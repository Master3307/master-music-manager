import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as lib from './index.js';
import * as tags from './tags.js';
import * as commands from './commands.js';
import * as jobs from '../jobs.js';
import * as settings from '../settings.js';
import { SEPARATORS } from './naming.js';
import { getProfile, canUse } from '../services/index.js';
import { requireUser, requireAdmin } from '../auth.js';
import { httpError, json, str, bool } from '../lib/http.js';
import { db, audit } from '../db.js';
import { compile, sorter, parseSort } from './query.js';
import { online } from '../settings.js';
import { safeFetch } from '../lib/net.js';
import { FILE_FIELDS } from './tags.js';

export function profileOf(req, { local = true } = {}) {
  const p = getProfile(req.params.pid);
  if (!p) throw httpError(404, 'No such profile');
  if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
  if (local && !p.local_path) throw httpError(400, 'This profile has no linked folder. Link one in Settings → Profiles to edit files.', { needsFolder: true });
  return p;
}
const trackOf = (p, id) => {
  const t = lib.byId(p.id, id);
  if (!t) throw httpError(404, 'Track not found (rescan the library?)');
  return t;
};

/** Pick tracks from { ids } or { query } (the current filter), in display order. */
export function selection(p, body) {
  if (Array.isArray(body.ids) && body.ids.length) {
    const order = sorter(parseSort(body.sort || '')) || null;
    const list = body.ids.map((id) => lib.byId(p.id, id)).filter(Boolean);
    return order ? list.sort(order) : list;
  }
  if (body.query !== undefined) return lib.query(p.id, { q: body.query, sort: body.sort, limit: Infinity }).list;
  throw httpError(400, 'Select tracks first');
}

const LIGHT = ['id', 'title', 'artist', 'artists', 'album', 'albumartist', 'genre', 'year', 'track', 'tracktotal', 'disc', 'disctotal', 'duration', 'bitrate', 'samplerate', 'bits', 'channels', 'codec', 'ext', 'size', 'path', 'filename', 'folder', 'added', 'modified', 'cover', 'haslyrics', 'lossless', 'remoteId', 'nosplit', 'bpm', 'key', 'mood', 'composer', 'label', 'comment', 'language', 'compilation', 'releasetype', 'isrc', 'hash'];
const light = (t, extra = []) => Object.fromEntries([...LIGHT, ...extra].filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));

export function register(app) {
  app.get(
    '/api/library/fields',
    requireUser,
    json(() => ({ tags: tags.FIELDS, file: FILE_FIELDS, separators: SEPARATORS, commands: commands.HELP })),
  );

  app.get(
    '/api/p/:pid/tracks',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      if (req.query.ids) {
        const list = String(req.query.ids).split(',').slice(0, 20000).map((id) => lib.byId(p.id, id)).filter(Boolean);
        return { total: list.length, tracks: list.map((t) => ({ ...light(t, []), ...Object.fromEntries(tags.FIELDS.map((f) => [f.key, t[f.key]]).filter(([, v]) => v !== undefined)), custom: t.custom })) };
      }
      let r;
      try {
        r = lib.query(p.id, { q: str(req.query.q, 4000), sort: str(req.query.sort, 200), offset: Number(req.query.offset) || 0, limit: Math.min(Number(req.query.limit) || 300, 5000) });
      } catch (e) {
        throw httpError(400, `Filter problem: ${e.message}`);
      }
      const extra = String(req.query.columns || '')
        .split(',')
        .filter(Boolean);
      return { total: r.total, sort: r.sort, tracks: r.list.map((t) => light(t, extra)), ids: bool(req.query.ids) ? lib.query(p.id, { q: str(req.query.q, 4000), sort: str(req.query.sort, 200), limit: Infinity }).list.map((t) => t.id) : undefined };
    }),
  );

  // Facets for filter dropdowns (top values of a field in the current filter).
  app.get(
    '/api/p/:pid/facets/:field',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      const { list } = lib.query(p.id, { q: str(req.query.q, 4000), limit: Infinity });
      const counts = new Map();
      for (const t of list) for (const v of [].concat(t[req.params.field] ?? [])) if (v !== '' && v != null) counts.set(v, (counts.get(v) || 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, Number(req.query.limit) || 200).map(([value, count]) => ({ value, count }));
    }),
  );

  app.get('/api/p/:pid/stats', requireUser, json((req) => lib.stats(profileOf(req).id)));

  // A song from the music server → its file here (for "Edit" on songs played through the server).
  app.get(
    '/api/p/:pid/by-remote/:rid',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      const r = db.prepare('SELECT id FROM tracks WHERE profile_id = ? AND remote_id = ?').get(p.id, String(req.params.rid));
      if (!r) throw httpError(404, 'This song isn’t in the linked folder, so it can’t be edited here');
      return { id: r.id };
    }),
  );

  app.get(
    '/api/p/:pid/tracks/:id',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      const data = await tags.read(lib.absPath(p, t.path), { covers: true });
      return {
        track: t,
        tags: data.tags,
        custom: data.custom,
        lyrics: data.lyrics,
        comments: data.comments,
        pictures: data.pictures.map(({ data: _d, ...rest }) => rest),
        info: data.info,
        restorePoints: lib.restorePoints(p.id, t.path),
        canvas: ((c) => c && { mp4: c.mp4, webp: c.webp })(canvasFiles(p, t)),
      };
    }),
  );

  app.patch(
    '/api/p/:pid/tracks/:id',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      const edit = { tags: req.body.tags, custom: req.body.custom, lyrics: req.body.lyrics, comments: req.body.comments, noSplit: req.body.noSplit, skipSeparators: req.body.skipSeparators };
      return lib.applyEdit(p, t, edit, { organize: req.body.organize, restorePoint: req.body.restorePoint !== false, userId: req.user.id });
    }),
  );

  app.get('/api/p/:pid/tracks/:id/cover', requireUser, async (req, res, next) => {
    try {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      const abs = lib.absPath(p, t.path);
      const c = await tags.readCover(abs).catch(() => null);
      if (c) {
        res.set('Cache-Control', 'private, max-age=300').type(c.format).send(c.data);
        return;
      }
      // Folder art next to the file.
      for (const n of ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'cover.webp']) {
        const f = path.join(path.dirname(abs), n);
        if (fs.existsSync(f)) return res.set('Cache-Control', 'private, max-age=300').sendFile(f);
      }
      res.status(404).end();
    } catch (e) {
      next(e);
    }
  });

  // New cover: raw image body, or { url }.
  app.put(
    '/api/p/:pid/tracks/:id/cover',
    requireUser,
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' }),
    json(async (req) => {
      const p = profileOf(req);
      const ids = req.query.ids ? String(req.query.ids).split(',').map(Number) : [Number(req.params.id)];
      let data;
      let format = req.get('content-type');
      if (Buffer.isBuffer(req.body) && req.body.length) data = req.body;
      else {
        const url = str(req.query.url, 2000);
        if (!url) throw httpError(400, 'Send an image or a URL');
        if (!online('coverSearch') && !/^https?:\/\/(localhost|127\.|10\.|192\.168\.)/.test(url)) throw httpError(403, 'Privacy mode is on: downloading from the internet is off');
        const r = await safeFetch(url, { maxBytes: 25 * 1024 * 1024 });
        data = r.body;
        format = r.type;
      }
      if (!/^image\/(jpeg|png|webp|gif)/.test(format || '')) format = sniff(data);
      if (!format) throw httpError(400, 'That is not a JPEG, PNG, WebP or GIF image');
      const results = [];
      for (const id of ids) {
        const t = trackOf(p, id);
        results.push(await lib.applyEdit(p, t, { cover: { data, format }, label: 'Before new cover', skipSeparators: true }, { organize: false, userId: req.user.id }));
      }
      audit(req.user.id, 'cover.set', { count: ids.length });
      return { ok: true, count: results.length };
    }),
  );

  app.delete(
    '/api/p/:pid/tracks/:id/cover',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      return lib.applyEdit(p, t, { cover: null, label: 'Before removing the cover', skipSeparators: true }, { organize: false, userId: req.user.id });
    }),
  );

  app.get('/api/p/:pid/tracks/:id/canvas/:kind', requireUser, (req, res, next) => {
    try {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      const c = canvasFiles(p, t);
      const f = req.params.kind === 'webp' ? c?.webpFile : c?.mp4File;
      if (!f) return res.status(404).end();
      res.set('Cache-Control', 'private, max-age=3600').sendFile(f);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/p/:pid/tracks/:id/file', requireUser, (req, res, next) => {
    try {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      const abs = lib.absPath(p, t.path);
      if (bool(req.query.download)) res.attachment(path.basename(abs));
      res.sendFile(abs, { acceptRanges: true, headers: { 'Cache-Control': 'private, max-age=60' } });
    } catch (e) {
      next(e);
    }
  });

  app.post(
    '/api/p/:pid/tracks/:id/copy',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      return lib.copyTrack(p, trackOf(p, req.params.id), req.user.id);
    }),
  );

  // Rename / move one file freely. If the name is taken: ask, replace, keep both, or merge.
  app.post(
    '/api/p/:pid/tracks/:id/rename',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      let to = str(req.body.path, 1000).trim().replace(/^\/+/, '').replace(/\\/g, '/');
      if (!to) throw httpError(400, 'Enter a file name');
      if (!/\.[a-z0-9]{2,5}$/i.test(to)) to += `.${t.ext}`;
      if (path.extname(to).toLowerCase() !== `.${t.ext}`) throw httpError(400, `Keep the .${t.ext} ending; converting is done in the Sound tab`);
      if (to.split('/').some((x) => x === '..' || !x.trim())) throw httpError(400, 'That is not a valid path');
      const dest = lib.absPath(p, to);
      const existing = fs.existsSync(dest) && dest.toLowerCase() !== lib.absPath(p, t.path).toLowerCase() ? lib.all(p.id).find((x) => x.path === to) : null;
      const mode = req.body.onConflict || 'ask';
      if (fs.existsSync(dest) && dest !== lib.absPath(p, t.path) && mode === 'ask') {
        const { similarity } = await import('./duplicates.js');
        throw httpError(409, 'A file with that name already exists', { conflict: { path: to, track: existing && { id: existing.id, title: existing.title, artist: existing.artist, duration: existing.duration, bitrate: existing.bitrate, ext: existing.ext, size: existing.size }, similarity: existing ? similarity(t, existing) : null } });
      }
      if (fs.existsSync(dest) && dest !== lib.absPath(p, t.path)) {
        if (mode === 'replace' && existing) lib.trash(p, existing, req.user.id);
        else if (mode === 'merge' && existing) {
          const { merge } = await import('./duplicates.js');
          await merge(p, { keep: t.id, remove: [existing.id], fillTags: true, userId: req.user.id });
        } else if (mode === 'replace') fs.rmSync(dest);
      }
      const rel = lib.moveFile(p, t.path, to);
      const fresh = await lib.rescanFile(p, rel, { oldRel: t.path });
      lib.touchService(p);
      audit(req.user.id, 'track.rename', { from: t.path, to: rel, mode });
      return { track: fresh, path: rel };
    }),
  );

  // ---- restore points ----
  app.post(
    '/api/p/:pid/tracks/:id/restore-points',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      const t = trackOf(p, req.params.id);
      return { id: lib.createRestorePoint(p, t, str(req.body.label, 120) || 'Saved by hand') };
    }),
  );
  app.post(
    '/api/p/:pid/restore-points/:rid/restore',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = await lib.restore(p, req.params.rid);
      audit(req.user.id, 'track.restore', { path: t?.path });
      lib.touchService(p);
      return t;
    }),
  );
  app.delete(
    '/api/p/:pid/restore-points/:rid',
    requireUser,
    json((req) => {
      profileOf(req);
      lib.deleteRestorePoint(req.params.rid);
      return { ok: true };
    }),
  );

  // ---- bulk + command line ----
  app.post(
    '/api/p/:pid/bulk',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      let steps;
      if (req.body.command) {
        if (/^\s*help\s*$/i.test(req.body.command)) return { help: commands.HELP };
        steps = commands.parseCommand(req.body.command);
      } else steps = [{ op: req.body.op, where: null }, ...(req.body.ops || []).map((op) => ({ op }))].filter((s) => s.op);
      if (!steps.length) throw httpError(400, 'Nothing to do');
      // Plan step by step so later steps see earlier results.
      const base = steps[0].where != null ? lib.query(p.id, { q: steps[0].where, sort: req.body.sort, limit: Infinity }).list : selection(p, req.body);
      const ops = steps.map((s) => s.op);
      if (steps.some((s, i) => i > 0 && s.where != null)) {
        // A later "where" narrows that step only.
        for (const s of steps) if (s.where) s.filter = compile(s.where).test;
      }
      let planned;
      try {
        planned = steps.some((s) => s.filter)
          ? mergePlans(steps.map((s) => commands.plan(s.filter ? base.filter(s.filter) : base, [s.op])))
          : commands.plan(base, ops);
      } catch (e) {
        throw httpError(e.status || 400, e.message);
      }
      if (req.body.preview !== false && !req.body.apply) return { preview: planned.slice(0, 500), total: planned.length, scanned: base.length, ops };
      if (!planned.length) return { ok: true, changed: 0 };
      const restorePoints = req.body.restorePoints ?? planned.length <= 500;
      const jobId = jobs.start(
        'bulk',
        `${req.body.command ? req.body.command.slice(0, 60) : ops.map((o) => o.type).join(', ')} · ${planned.length} tracks`,
        async (ctx) => {
          let done = 0;
          let failed = 0;
          for (const item of planned) {
            ctx.check();
            const t = lib.byId(p.id, item.id);
            if (!t) continue;
            try {
              if (item.delete) {
                lib.trash(p, t, req.user.id);
                ctx.log(`trash  ${t.path}`);
              } else {
                const edit = { tags: {}, custom: {}, label: `Bulk: ${ops[0].type}`, skipSeparators: !ops.some((o) => o.type === 'separators') };
                for (const [f, [, nv]] of Object.entries(item.changes)) edit.tags[f] = nv;
                for (const [k, [, nv]] of Object.entries(item.custom || {})) edit.custom[k] = nv;
                if (!Object.keys(edit.custom).length) delete edit.custom;
                if (item.noSplit !== undefined) edit.noSplit = item.noSplit;
                const r = await lib.applyEdit(p, t, edit, { organize: false, restorePoint: restorePoints, userId: req.user.id });
                let rel = r.track?.path || t.path;
                if (item.move) rel = lib.moveFile(p, rel, item.move);
                if (rel !== (r.track?.path || t.path)) await lib.rescanFile(p, rel, { oldRel: r.track?.path || t.path });
                ctx.log(`ok     ${rel}${Object.keys(item.changes).length ? `  (${Object.keys(item.changes).join(', ')})` : ''}`);
              }
            } catch (e) {
              failed++;
              ctx.log(`failed ${t.path}: ${e.message}`);
            }
            ctx.progress(++done / planned.length, `${done} / ${planned.length}`);
          }
          lib.touchService(p);
          return { changed: done - failed, failed };
        },
        { userId: req.user.id },
      );
      audit(req.user.id, 'bulk', { profile: p.id, count: planned.length, ops: ops.map((o) => o.type) });
      return { job: jobId, total: planned.length };
    }),
  );

  app.post(
    '/api/p/:pid/scan',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      return { job: lib.scan(p, { full: bool(req.body.full), userId: req.user.id }) };
    }),
  );

  app.post(
    '/api/p/:pid/organize',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      const list = req.body.ids || req.body.query !== undefined ? selection(p, req.body) : lib.all(p.id);
      const planned = commands.plan(list, [{ type: 'organize' }]);
      if (!req.body.apply) return { preview: planned.slice(0, 500), total: planned.length };
      return { job: startMoves(p, planned, req.user.id) };
    }),
  );

  // ---- trash ----
  app.get('/api/trash', requireAdmin, json(() => lib.trashList()));
  app.post('/api/trash/:id/restore', requireAdmin, json((req) => lib.untrash(req.params.id, getProfile)));
  app.delete('/api/trash', requireAdmin, json((req) => ({ removed: lib.emptyTrash(Number(req.query.olderThanDays) || 0) })));
}

function startMoves(p, planned, userId) {
  return jobs.start(
    'organize',
    `Organize ${planned.length} files · ${p.name}`,
    async (ctx) => {
      let n = 0;
      for (const item of planned) {
        ctx.check();
        try {
          const rel = lib.moveFile(p, item.path, item.move);
          await lib.rescanFile(p, rel, { oldRel: item.path });
          ctx.log(`${item.path}\n  → ${rel}`);
        } catch (e) {
          ctx.log(`! ${item.path}: ${e.message}`);
        }
        ctx.progress(++n / planned.length, `${n} / ${planned.length}`);
      }
      lib.touchService(p);
      audit(userId, 'organize', { profile: p.id, count: n });
      return { moved: n };
    },
    { userId },
  );
}

function mergePlans(plans) {
  const out = new Map();
  for (const list of plans)
    for (const item of list) {
      const cur = out.get(item.id);
      if (!cur) out.set(item.id, { ...item, changes: { ...item.changes }, custom: { ...item.custom } });
      else {
        Object.assign(cur.changes, item.changes);
        Object.assign(cur.custom, item.custom);
        cur.move = item.move || cur.move;
        cur.delete = cur.delete || item.delete;
      }
    }
  return [...out.values()];
}

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}

export function canvasFiles(p, t) {
  const abs = lib.absPath(p, t.path);
  const dir = path.join(path.dirname(abs), '.canvas', path.basename(abs).replace(/\.[^.]+$/, ''));
  const mp4 = path.join(dir, 'canvas.mp4');
  const webp = path.join(dir, 'canvas.webp');
  if (!fs.existsSync(mp4) && !fs.existsSync(webp)) return null;
  return { mp4: fs.existsSync(mp4), webp: fs.existsSync(webp), mp4File: fs.existsSync(mp4) ? mp4 : null, webpFile: fs.existsSync(webp) ? webp : null };
}
