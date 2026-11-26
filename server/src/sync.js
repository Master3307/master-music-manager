// Keeping places completely in sync: every library (and linked instance) in a
// sync group ends up with every song of every other, compared by identical
// audio, so a song is never copied twice just because its tags differ.
//
// Optional: removals follow (a song deleted in one place goes to the trash
// everywhere), and edits follow (the newest copy of a song wins, with a
// restore point on the others).
//
// Safety: a place that can't be read (disk not mounted, instance offline) is
// left out of the run and nothing is decided about it. A place suddenly
// missing a large part of what it had is not treated as deletions either.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, now, audit, tx } from './db.js';
import * as jobs from './jobs.js';
import * as lib from './library/index.js';
import { getProfile } from './services/index.js';
import { requireAdmin } from './auth.js';
import { httpError, json, str, bool } from './lib/http.js';
import { uuid } from './lib/crypto.js';
import { PATHS } from './config.js';
import { log } from './lib/log.js';

db.exec(`
CREATE TABLE IF NOT EXISTS sync_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  members TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run INTEGER, last_job TEXT, last_result TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_known (
  group_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (group_id, hash)
);
`);

const DEFAULTS = { removals: false, edits: true, everyMinutes: 60 };
const running = new Map(); // group id -> job id

function groupOf(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, members: JSON.parse(r.members), options: { ...DEFAULTS, ...JSON.parse(r.options || '{}') }, enabled: Boolean(r.enabled), lastRun: r.last_run, lastJob: r.last_job, lastResult: r.last_result ? JSON.parse(r.last_result) : null, running: running.get(r.id) || null, createdAt: r.created_at };
}
const getGroup = (id) => groupOf(db.prepare('SELECT * FROM sync_groups WHERE id = ?').get(id));
const nodeRow = (id) => db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);

function memberName(m) {
  if (m.nodeId) {
    const n = nodeRow(m.nodeId);
    return n ? `${n.name} (linked instance)` : 'a removed instance';
  }
  return getProfile(m.profileId)?.name || 'a removed library';
}

function cleanMembers(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (m?.nodeId) {
      if (!nodeRow(m.nodeId)) throw httpError(400, 'One of the linked instances no longer exists');
      out.push({ nodeId: String(m.nodeId), profileId: m.profileId ? String(m.profileId) : null });
    } else if (m?.profileId) {
      const p = getProfile(String(m.profileId));
      if (!p) throw httpError(400, 'One of the libraries no longer exists');
      if (!p.local_path) throw httpError(400, `${p.name} has no music folder linked, so there are no files to keep in sync`);
      out.push({ profileId: p.id });
    }
  }
  const keys = new Set(out.map((m) => `${m.nodeId || ''}|${m.profileId || ''}`));
  if (keys.size !== out.length) throw httpError(400, 'A place is in the list twice');
  if (out.length < 2) throw httpError(400, 'Pick at least two places to keep in sync');
  const folders = out.filter((m) => !m.nodeId).map((m) => path.resolve(getProfile(m.profileId).local_path));
  if (new Set(folders).size !== folders.length) throw httpError(400, 'Two of these libraries use the same folder, so they already have the same files');
  return out;
}

const call = async (nodeId, p, opts) => (await import('./federation.js')).callNode(nodeRow(nodeId), p, opts);

/** What one place has right now: audio hash -> { path, mtime, hash, id }. */
async function listPlace(m, ctx, o = DEFAULTS) {
  if (m.nodeId) {
    // The other side fingerprints its songs first, or everything would look missing.
    let left = Infinity;
    for (let i = 0; i < 60; i++) {
      left = (await call(m.nodeId, '/api/fed/sync-prepare', { method: 'POST', timeout: 20_000 })).unhashed;
      if (!left) break;
      if (i === 0) ctx.log(`  ${memberName(m)} is fingerprinting ${left} songs first…`);
      await new Promise((r) => setTimeout(r, 10_000));
      ctx.check();
    }
    if (left) throw new Error(`still fingerprinting (${left} songs left); the next run continues`);
    const items = new Map();
    for (let offset = 0; ; offset += 5000) {
      const { tracks } = await call(m.nodeId, `/api/fed/catalog?offset=${offset}&limit=5000`, { timeout: 60_000 });
      for (const t of tracks) if (t.audio_hash && (!m.profileId || t.profile_id === m.profileId) && !items.has(t.audio_hash)) items.set(t.audio_hash, { path: t.path, mtime: t.updated_at, hash: t.hash });
      if (tracks.length < 5000) break;
    }
    return items;
  }
  const p = getProfile(m.profileId);
  try {
    fs.readdirSync(p.local_path);
  } catch (e) {
    throw new Error(`its folder ${p.local_path} can't be read (${e.code || e.message}). Is the disk mounted?`);
  }
  await jobs.wait(lib.scan(p));
  const { ensureAudioHashes } = await import('./library/duplicates.js');
  await ensureAudioHashes(p, ctx);
  if (o.edits) await lib.ensureHashes(p, ctx); // tells edited files apart
  const items = new Map();
  for (const t of db.prepare('SELECT id, path, mtime, hash, audio_hash FROM tracks WHERE profile_id = ? AND audio_hash IS NOT NULL').all(p.id)) if (!items.has(t.audio_hash)) items.set(t.audio_hash, t);
  // Taken out here: the file is still there, so it must not be copied in again.
  for (const t of db.prepare('SELECT path, audio_hash FROM taken_out WHERE profile_id = ? AND audio_hash IS NOT NULL').all(p.id)) if (!items.has(t.audio_hash)) items.set(t.audio_hash, { path: t.path, takenOut: true });
  return items;
}

function uniqueRel(p, rel) {
  let r = rel;
  for (let i = 2; fs.existsSync(lib.absPath(p, r)); i++) r = rel.replace(/(\.[^.]+)$/, ` (${i})$1`);
  return r;
}

/** Copy one song from one place to another (any combination of library / instance). */
async function copySong(hash, from, fromItem, to) {
  let tmp = null;
  let src;
  if (from.nodeId) {
    tmp = path.join(PATHS.uploads, `sync-${uuid()}`);
    const r = await call(from.nodeId, `/api/fed/stream/${hash}`, { raw: true, timeout: 600_000 });
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
    src = tmp;
  } else src = lib.absPath(getProfile(from.profileId), fromItem.path);
  try {
    if (to.nodeId) {
      const r = await call(to.nodeId, `/api/fed/receive?path=${encodeURIComponent(fromItem.path)}&profile=${encodeURIComponent(to.profileId || '')}&hash=${hash}&skipExisting=true`, { method: 'POST', body: fs.readFileSync(src), timeout: 600_000, headers: { 'Content-Type': 'application/octet-stream' } });
      return r.path || fromItem.path;
    }
    const dst = getProfile(to.profileId);
    const rel = uniqueRel(dst, fromItem.path);
    const out = lib.absPath(dst, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(src, `${out}.part`);
    fs.renameSync(`${out}.part`, out);
    const lrc = src.replace(/\.[^.]+$/, '.lrc');
    if (!from.nodeId && fs.existsSync(lrc)) fs.copyFileSync(lrc, out.replace(/\.[^.]+$/, '.lrc'));
    const t = await lib.rescanFile(dst, rel);
    db.prepare('UPDATE tracks SET audio_hash = ? WHERE id = ?').run(hash, t.id);
    return rel;
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

async function removeSong(hash, m, item, userId) {
  if (m.nodeId) return call(m.nodeId, '/api/fed/remove', { method: 'POST', body: { hashes: [hash] }, timeout: 60_000 });
  const p = getProfile(m.profileId);
  for (const r of db.prepare('SELECT id FROM tracks WHERE profile_id = ? AND audio_hash = ?').all(p.id, hash)) {
    const t = lib.byId(p.id, r.id);
    if (t) lib.trash(p, t, userId);
  }
  return item;
}

/** Same recording, different file (tags or cover edited): the newest copy wins. */
async function updateSong(from, fromItem, to, toItem) {
  const sp = getProfile(from.profileId);
  const dp = getProfile(to.profileId);
  const track = lib.byId(dp.id, toItem.id);
  if (track) lib.createRestorePoint(dp, track, 'Before sync');
  const out = lib.absPath(dp, toItem.path);
  fs.copyFileSync(lib.absPath(sp, fromItem.path), `${out}.part`);
  fs.renameSync(`${out}.part`, out);
  const t = await lib.rescanFile(dp, toItem.path);
  db.prepare('UPDATE tracks SET audio_hash = (SELECT audio_hash FROM tracks WHERE id = ?) WHERE id = ?').run(fromItem.id, t.id);
}

export function run(groupId, { userId = null } = {}) {
  const g = getGroup(groupId);
  if (!g) throw httpError(404, 'This sync no longer exists');
  if (running.has(g.id)) return running.get(g.id);
  const id = jobs.start(
    'sync',
    `Keeping in sync · ${g.name}`,
    async (ctx) => {
      const o = g.options;
      // 1. What does every place have?
      const places = [];
      for (const m of g.members) {
        ctx.check();
        ctx.log(`Reading ${memberName(m)}`);
        try {
          places.push({ m, name: memberName(m), items: await listPlace(m, ctx, o) });
          ctx.log(`  ${places.at(-1).items.size} songs`);
        } catch (e) {
          ctx.log(`  ! left out this time: ${e.message}`);
        }
      }
      if (places.length < 2) throw new Error('Fewer than two places could be read, so nothing was changed. They are tried again next time.');
      const complete = places.length === g.members.length;
      const known = new Set(db.prepare('SELECT hash FROM sync_known WHERE group_id = ?').all(g.id).map((r) => r.hash));
      const all = new Set(places.flatMap((p) => [...p.items.keys()]));

      // 2. Removals: in sync last time, gone from some places now.
      const removed = new Set();
      if (o.removals && known.size) {
        for (const p of places) {
          const gone = [...known].filter((h) => !p.items.has(h) && all.has(h));
          if (!gone.length) continue;
          if (gone.length > Math.max(25, known.size * 0.3)) {
            ctx.log(`! ${p.name} is missing ${gone.length} of ${known.size} songs it had last time. That looks like an accident (an unmounted disk, a moved folder), so nothing is removed elsewhere and nothing is copied back to it this time. If you really deleted them, turn off “Removals follow” for one run.`);
            p.suspect = true;
            continue;
          }
          for (const h of gone) removed.add(h);
        }
      }
      let nRemoved = 0;
      for (const h of removed) {
        ctx.check();
        for (const p of places) {
          if (!p.items.has(h)) continue;
          try {
            await removeSong(h, p.m, p.items.get(h), userId);
            ctx.log(`remove  ${p.items.get(h).path}  from ${p.name} (removed elsewhere)`);
            p.items.delete(h);
            p.changed = true;
            nRemoved++;
          } catch (e) {
            ctx.log(`! couldn't remove ${p.items.get(h).path} from ${p.name}: ${e.message}`);
          }
        }
      }

      // 3. Copy every song to every place that lacks it. Libraries are the
      // preferred source (a local copy is faster than downloading).
      const want = [];
      for (const h of all) {
        if (removed.has(h)) continue;
        const have = places.filter((p) => p.items.has(h));
        const lack = places.filter((p) => !p.items.has(h) && !p.suspect);
        if (!have.length || !lack.length) continue;
        const sources = have.filter((p) => !p.items.get(h).takenOut);
        if (!sources.length) continue;
        const src = sources.find((p) => !p.m.nodeId) || sources[0];
        for (const dst of lack) want.push([h, src, dst]);
      }
      ctx.log(`${want.length} copies to make${removed.size ? `, ${nRemoved} removed` : ''}`);
      let copied = 0;
      let failed = 0;
      for (const [h, src, dst] of want) {
        ctx.check();
        const item = src.items.get(h);
        try {
          const rel = await copySong(h, src.m, item, dst.m);
          dst.items.set(h, { ...item, path: rel, copied: true });
          dst.changed = true;
          copied++;
          ctx.log(`copy  ${item.path}  ${src.name} → ${dst.name}`);
        } catch (e) {
          failed++;
          ctx.log(`! ${item.path} → ${dst.name}: ${e.message}`);
        }
        ctx.progress((copied + failed) / Math.max(1, want.length), `${copied + failed} / ${want.length}`);
      }

      // 4. Edits between libraries: the newest file of a recording wins.
      let updated = 0;
      if (o.edits) {
        const libs = places.filter((p) => !p.m.nodeId);
        for (const h of all) {
          const copies = libs.filter((p) => p.items.has(h) && !p.items.get(h).copied && !p.items.get(h).takenOut).map((p) => ({ p, item: p.items.get(h) }));
          if (copies.length < 2 || new Set(copies.map((c) => c.item.hash)).size < 2 || copies.some((c) => !c.item.hash)) continue;
          const newest = copies.reduce((a, b) => (b.item.mtime > a.item.mtime ? b : a));
          for (const c of copies) {
            if (c === newest || c.item.hash === newest.item.hash) continue;
            try {
              await updateSong(newest.p.m, newest.item, c.p.m, c.item);
              c.p.changed = true;
              updated++;
              ctx.log(`update  ${c.item.path} on ${c.p.name} (newer on ${newest.p.name})`);
            } catch (e) {
              ctx.log(`! couldn't update ${c.item.path} on ${c.p.name}: ${e.message}`);
            }
          }
        }
      }

      // 5. Remember what is now everywhere, for removals next time.
      tx(() => {
        const keep = new Set([...all].filter((h) => !removed.has(h) && places.every((p) => p.items.has(h))));
        if (complete) db.prepare('DELETE FROM sync_known WHERE group_id = ?').run(g.id);
        else for (const h of removed) db.prepare('DELETE FROM sync_known WHERE group_id = ? AND hash = ?').run(g.id, h);
        const ins = db.prepare('INSERT OR IGNORE INTO sync_known (group_id, hash) VALUES (?, ?)');
        for (const h of keep) ins.run(g.id, h);
      });
      for (const p of places) if (p.changed && !p.m.nodeId) lib.touchService(getProfile(p.m.profileId));
      const result = { copied, failed, removed: nRemoved, updated, places: places.length, of: g.members.length };
      ctx.log(`✓ ${copied} copied, ${updated} updated, ${nRemoved} removed${failed ? `, ${failed} failed` : ''}${complete ? '' : ` (${g.members.length - places.length} place(s) left out this time)`}`);
      audit(userId, 'sync.run', { group: g.name, ...result });
      return result;
    },
    { userId },
  );
  running.set(g.id, id);
  db.prepare('UPDATE sync_groups SET last_job = ? WHERE id = ?').run(id, g.id);
  jobs.wait(id).then((j) => {
    running.delete(g.id);
    db.prepare('UPDATE sync_groups SET last_run = ?, last_result = ? WHERE id = ?').run(now(), JSON.stringify(j.status === 'done' ? { ok: true, ...j.result } : { ok: false, error: j.error }), g.id);
  });
  return id;
}

// Every minute: start the syncs that are due.
setInterval(() => {
  for (const r of db.prepare('SELECT * FROM sync_groups WHERE enabled = 1').all()) {
    const g = groupOf(r);
    if (g.running || !g.options.everyMinutes) continue;
    if (!g.lastRun || now() - g.lastRun >= g.options.everyMinutes * 60_000) {
      try {
        run(g.id);
      } catch (e) {
        log.warn(`sync ${g.name}: ${e.message}`);
      }
    }
  }
}, 60_000).unref();

const optionsFrom = (b, old = DEFAULTS) => ({
  removals: b.removals === undefined ? old.removals : bool(b.removals),
  edits: b.edits === undefined ? old.edits : bool(b.edits),
  everyMinutes: b.everyMinutes === undefined ? old.everyMinutes : Math.max(0, Math.min(7 * 24 * 60, Number(b.everyMinutes) || 0)),
});

export function register(app) {
  app.get('/api/sync', requireAdmin, json(() => db.prepare('SELECT * FROM sync_groups ORDER BY created_at').all().map(groupOf).map((g) => ({ ...g, members: g.members.map((m) => ({ ...m, name: memberName(m) })) }))));
  app.post(
    '/api/sync',
    requireAdmin,
    json((req) => {
      const members = cleanMembers(req.body.members);
      const id = uuid();
      const name = str(req.body.name, 80).trim() || members.map(memberName).join(' ⇄ ').slice(0, 80);
      db.prepare('INSERT INTO sync_groups (id, name, members, options, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(id, name, JSON.stringify(members), JSON.stringify(optionsFrom(req.body)), now());
      audit(req.user.id, 'sync.create', { name });
      return { ...getGroup(id), job: req.body.runNow === false ? null : run(id, { userId: req.user.id }) };
    }),
  );
  app.patch(
    '/api/sync/:id',
    requireAdmin,
    json((req) => {
      const g = getGroup(req.params.id);
      if (!g) throw httpError(404, 'This sync no longer exists');
      const members = req.body.members ? cleanMembers(req.body.members) : g.members;
      if (req.body.members) db.prepare('DELETE FROM sync_known WHERE group_id = ?').run(g.id); // new places: start fresh
      db.prepare('UPDATE sync_groups SET name = ?, members = ?, options = ?, enabled = ? WHERE id = ?').run(str(req.body.name, 80).trim() || g.name, JSON.stringify(members), JSON.stringify(optionsFrom(req.body, g.options)), req.body.enabled === undefined ? Number(g.enabled) : Number(bool(req.body.enabled)), g.id);
      audit(req.user.id, 'sync.edit', { name: g.name });
      return getGroup(g.id);
    }),
  );
  app.delete(
    '/api/sync/:id',
    requireAdmin,
    json((req) => {
      const g = getGroup(req.params.id);
      if (!g) throw httpError(404, 'This sync no longer exists');
      if (g.running) jobs.cancel(g.running);
      db.prepare('DELETE FROM sync_known WHERE group_id = ?').run(g.id);
      db.prepare('DELETE FROM sync_groups WHERE id = ?').run(g.id);
      audit(req.user.id, 'sync.delete', { name: g.name });
      return { ok: true };
    }),
  );
  app.post('/api/sync/:id/run', requireAdmin, json((req) => ({ job: run(req.params.id, { userId: req.user.id }) })));
}

/** For linked instances: fingerprint our songs so the other side can compare. */
export function registerFed(app, nodeAuth, modesOf) {
  let preparing = null;
  app.post(
    '/api/fed/sync-prepare',
    nodeAuth,
    json(async (req) => {
      if (!modesOf(req.node).serve) throw httpError(403, 'This instance does not share its songs with you');
      const count = () => db.prepare('SELECT COUNT(*) n FROM tracks t JOIN profiles p ON p.id = t.profile_id WHERE t.audio_hash IS NULL AND p.local_path IS NOT NULL').get().n;
      const left = count();
      if (left && !preparing) {
        const { ensureAudioHashes } = await import('./library/duplicates.js');
        preparing = (async () => {
          for (const p of db.prepare('SELECT * FROM profiles WHERE local_path IS NOT NULL').all()) await ensureAudioHashes(p, null).catch(() => {});
        })().finally(() => {
          preparing = null;
        });
      }
      return { unhashed: left };
    }),
  );
}
