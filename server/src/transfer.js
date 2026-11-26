// Moving and copying songs between libraries (linked folders, also of
// different services) and linked instances, and removing them from some or
// all of them. Removing always means "to the trash" on each side.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db, audit } from './db.js';
import * as jobs from './jobs.js';
import * as lib from './library/index.js';
import { getProfile, canUse } from './services/index.js';
import { requireUser } from './auth.js';
import { httpError, json, str } from './lib/http.js';
import { uuid } from './lib/crypto.js';
import { PATHS } from './config.js';

async function nodeCall(nodeId, pathname, opts) {
  const fed = await import('./federation.js');
  const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!n) throw new Error('Unknown instance');
  return fed.callNode(n, pathname, opts);
}

function uniqueRel(profile, rel) {
  let r = rel;
  for (let i = 2; fs.existsSync(lib.absPath(profile, r)); i++) r = rel.replace(/(\.[^.]+)$/, ` (${i})$1`);
  return r;
}

export function register(app) {
  /**
   * body: { from: profileId, ids: [...], to: [{ profileId } | { nodeId, profileId? }], mode: 'copy' | 'move', skipExisting }
   */
  app.post(
    '/api/transfer',
    requireUser,
    json((req) => {
      const src = getProfile(req.body.from);
      if (!canUse(req.user, src) || !src.local_path) throw httpError(400, 'Pick songs from a library with a linked folder');
      const tracks = (req.body.ids || []).map((id) => lib.byId(src.id, id)).filter(Boolean);
      if (!tracks.length) throw httpError(400, 'Select songs first');
      const targets = (req.body.to || []).filter((t) => t.profileId || t.nodeId);
      if (!targets.length) throw httpError(400, 'Pick where they should go');
      for (const t of targets) if (t.profileId && !t.nodeId && (!canUse(req.user, getProfile(t.profileId)) || !getProfile(t.profileId)?.local_path)) throw httpError(400, 'A target library has no linked folder');
      const move = req.body.mode === 'move';
      return {
        job: jobs.start(
          'transfer',
          `${move ? 'Moving' : 'Copying'} ${tracks.length} songs`,
          async (ctx) => {
            const { audioHash } = await import('./library/duplicates.js');
            let done = 0;
            let skipped = 0;
            for (const t of tracks) {
              ctx.check();
              const abs = lib.absPath(src, t.path);
              let ok = true;
              let hash = db.prepare('SELECT audio_hash FROM tracks WHERE id = ?').get(t.id)?.audio_hash;
              if (!hash) {
                hash = await audioHash(abs).catch(() => null);
                if (hash) db.prepare('UPDATE tracks SET audio_hash = ? WHERE id = ?').run(hash, t.id);
              }
              for (const target of targets) {
                try {
                  if (target.nodeId) {
                    const r = await nodeCall(target.nodeId, `/api/fed/receive?path=${encodeURIComponent(t.path)}&profile=${encodeURIComponent(target.profileId || '')}&hash=${hash || ''}&skipExisting=${req.body.skipExisting !== false}`, { method: 'POST', body: fs.readFileSync(abs), raw: false, timeout: 600_000, headers: { 'Content-Type': 'application/octet-stream' } });
                    ctx.log(`${r.skipped ? 'skip' : 'sent'}  ${t.path}  →  instance${r.path ? `: ${r.path}` : ''}`);
                    if (r.skipped) skipped++;
                  } else {
                    const dst = getProfile(target.profileId);
                    if (dst.id === src.id) continue;
                    if (req.body.skipExisting !== false && hash && db.prepare('SELECT 1 FROM tracks WHERE profile_id = ? AND audio_hash = ?').get(dst.id, hash)) {
                      ctx.log(`skip  ${t.path}  (${dst.name} already has this song)`);
                      skipped++;
                      continue;
                    }
                    const rel = uniqueRel(dst, t.path);
                    const out = lib.absPath(dst, rel);
                    fs.mkdirSync(path.dirname(out), { recursive: true });
                    fs.copyFileSync(abs, out);
                    for (const side of ['.lrc']) {
                      const s = abs.replace(/\.[^.]+$/, side);
                      if (fs.existsSync(s)) fs.copyFileSync(s, out.replace(/\.[^.]+$/, side));
                    }
                    const nt = await lib.rescanFile(dst, rel);
                    if (hash) db.prepare('UPDATE tracks SET audio_hash = ? WHERE id = ?').run(hash, nt.id);
                    lib.touchService(dst);
                    ctx.log(`copy  ${t.path}  →  ${dst.name}: ${rel}`);
                  }
                } catch (e) {
                  ok = false;
                  ctx.log(`! ${t.path}: ${e.message}`);
                }
              }
              if (move && ok) lib.trash(src, t, req.user.id);
              ctx.progress(++done / tracks.length, `${done} / ${tracks.length}`);
            }
            audit(req.user.id, move ? 'transfer.move' : 'transfer.copy', { from: src.id, count: tracks.length, targets: targets.length });
            return { done, skipped };
          },
          { userId: req.user.id },
        ),
      };
    }),
  );

  /**
   * Remove songs (by identical audio) from some or all places.
   * body: { from: profileId, ids, places: [{ profileId } | { nodeId }] | 'all' }
   */
  app.post(
    '/api/remove-everywhere',
    requireUser,
    json(async (req) => {
      const src = getProfile(req.body.from);
      if (!canUse(req.user, src)) throw httpError(403, 'Not yours');
      const tracks = (req.body.ids || []).map((id) => lib.byId(src.id, id)).filter(Boolean);
      const hashes = tracks.map((t) => db.prepare('SELECT audio_hash FROM tracks WHERE id = ?').get(t.id)?.audio_hash);
      const all = req.body.places === 'all';
      // "Take out": keep the files in a folder instead of the trash.
      let outFolder = null;
      if (req.body.takeOut) {
        const custom = typeof req.body.takeOut === 'string' && req.body.takeOut.trim();
        if (custom && req.user.role !== 'admin') throw httpError(403, 'Only admins can pick another folder');
        outFolder = path.resolve(custom || lib.takeOutFolder(src));
        if (!path.isAbsolute(custom || outFolder)) throw httpError(400, 'Give the full path of the folder');
        for (const p of db.prepare('SELECT local_path FROM profiles WHERE local_path IS NOT NULL').all()) {
          const rel = path.relative(path.resolve(p.local_path), outFolder);
          if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw httpError(400, 'Pick a folder outside your libraries, or the songs come right back with the next scan');
        }
      }
      const places = all
        ? [...db.prepare('SELECT id FROM profiles WHERE local_path IS NOT NULL').all().map((p) => ({ profileId: p.id })), ...db.prepare('SELECT id FROM nodes').all().map((n) => ({ nodeId: n.id }))]
        : req.body.places || [{ profileId: src.id }];
      if (req.body.preview) {
        const where = places.map((pl) => {
          if (pl.nodeId) return { ...pl, name: db.prepare('SELECT name FROM nodes WHERE id = ?').get(pl.nodeId)?.name, count: hashes.filter((h) => h && db.prepare('SELECT 1 FROM remote_tracks WHERE node_id = ? AND audio_hash = ?').get(pl.nodeId, h)).length };
          const p = getProfile(pl.profileId);
          return { ...pl, name: p?.name, count: pl.profileId === src.id ? tracks.length : hashes.filter((h) => h && db.prepare('SELECT 1 FROM tracks WHERE profile_id = ? AND audio_hash = ?').get(pl.profileId, h)).length };
        });
        return { tracks: tracks.length, places: where, unhashed: hashes.filter((h) => !h).length, takeOutFolder: lib.takeOutFolder(src) };
      }
      return {
        job: jobs.start(
          'transfer',
          `Removing ${tracks.length} songs from ${all ? 'everywhere' : `${places.length} places`}`,
          async (ctx) => {
            let removed = 0;
            for (const pl of places) {
              if (pl.nodeId) {
                try {
                  const r = await nodeCall(pl.nodeId, '/api/fed/remove', { method: 'POST', body: { hashes: hashes.filter(Boolean) } });
                  ctx.log(`instance: ${r.removed} removed`);
                  removed += r.removed;
                } catch (e) {
                  ctx.log(`! instance unreachable: ${e.message} (try again when it's online)`);
                }
                continue;
              }
              const p = getProfile(pl.profileId);
              if (!p?.local_path || !canUse(req.user, p)) continue;
              const victims = p.id === src.id ? tracks : hashes.filter(Boolean).flatMap((h) => db.prepare('SELECT id FROM tracks WHERE profile_id = ? AND audio_hash = ?').all(p.id, h).map((r) => lib.byId(p.id, r.id)));
              for (const t of victims.filter(Boolean)) {
                ctx.check();
                if (outFolder) {
                  const to = lib.takeOut(p, t, outFolder, req.user.id);
                  ctx.log(`out    ${p.name}: ${t.path}  →  ${to}`);
                } else {
                  lib.trash(p, t, req.user.id);
                  ctx.log(`trash  ${p.name}: ${t.path}`);
                }
                removed++;
              }
            }
            return { removed, folder: outFolder };
          },
          { userId: req.user.id },
        ),
      };
    }),
  );
  void str;
  void uuid;
  void pipeline;
  void PATHS;
}
