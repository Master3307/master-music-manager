// Linking Master Music Manager instances (e.g. a home server and a PC).
//
// Pairing: one side makes a one-time code (its addresses + a secret), the
// other pastes it; both then hold a key for each other. Every call carries
// "Authorization: Bearer <key>"; only SHA-256 hashes of keys are stored.
//
// Each link has modes, all usable at once:
//   catalog  – see the other side's songs (kept as a list, also while it's offline)
//   stream   – play songs from there when nobody here has them (100% same audio only)
//   host     – that node is my host: push my settings, stats, scrobbles and
//              song list to it, so it knows everything even while I'm off
//   mirror   – copy every song I don't have (backup); identical audio is never copied twice
//   settings – take look & library settings from that node
// Addresses: the LAN address is tried first (fast, no tunnel), then the public one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, now, audit, tx } from './db.js';
import * as settings from './settings.js';
import * as jobs from './jobs.js';
import * as lib from './library/index.js';
import { PATHS, PORT, VERSION } from './config.js';
import { token, sha256, seal, unseal, uuid, safeEqual } from './lib/crypto.js';
import { httpError, json, str, bool } from './lib/http.js';
import { requireAdmin, requireUser } from './auth.js';
import { log } from './lib/log.js';
import { merge as mergeScrobbles } from './scrobbles.js';
import { getProfile } from './services/index.js';

const pending = new Map(); // pairing secret -> expires

export function instance() {
  let inst = settings.get('instance');
  if (!inst?.id) inst = settings.set('instance', { id: uuid(), name: os.hostname() });
  return inst;
}

export function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}

const nodeRow = (id) => db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
const modesOf = (n) => ({ catalog: true, stream: true, host: false, mirror: false, settings: false, serve: true, ...JSON.parse(n.modes || '{}') });

function publicNode(n) {
  return { id: n.id, name: n.name, localUrl: n.local_url, publicUrl: n.public_url, modes: modesOf(n), lastSeen: n.last_seen, lastError: n.last_error, lastUrl: n.last_url, online: Boolean(n.last_seen && now() - n.last_seen < 10 * 60_000 && !n.last_error), catalogAt: n.catalog_at, info: JSON.parse(n.info || '{}'), tracks: db.prepare('SELECT COUNT(*) n FROM remote_tracks WHERE node_id = ?').get(n.id).n };
}

// ---- talking to a node ----
async function call(n, pathname, { method = 'GET', body, raw = false, timeout, headers = {} } = {}) {
  const key = unseal(n.their_key);
  const urls = [...new Set([n.last_url, n.local_url, n.public_url].filter(Boolean))];
  // LAN first: a short timeout so a far-away node falls through to its public address quickly.
  urls.sort((a, b) => (a === n.local_url ? -1 : b === n.local_url ? 1 : 0));
  let lastErr;
  for (const base of urls) {
    const isLan = base === n.local_url;
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'X-MMM': '1', 'X-MMM-Node': instance().id, ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? (body instanceof Buffer ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(timeout ?? (isLan ? 2500 : 15000)),
      });
      if (r.status === 401) throw Object.assign(new Error('The other side no longer accepts our key (unpaired?)'), { fatal: true });
      if (!r.ok && r.status !== 206) throw new Error(`${base} answered ${r.status}`);
      if (base !== n.last_url) db.prepare('UPDATE nodes SET last_url = ? WHERE id = ?').run(base, n.id);
      db.prepare('UPDATE nodes SET last_seen = ?, last_error = NULL WHERE id = ?').run(now(), n.id);
      return raw ? r : r.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
    }
  }
  db.prepare('UPDATE nodes SET last_error = ? WHERE id = ?').run(lastErr?.message || 'unreachable', n.id);
  throw lastErr || new Error('No address for this node');
}

export const callNode = call;
export { nodeAuth, modesOf };

/** Middleware for /api/fed/*: identify the calling node by its key. */
function nodeAuth(req, _res, next) {
  const m = String(req.get('authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return next(httpError(401, 'Node key needed'));
  const n = db.prepare('SELECT * FROM nodes WHERE our_key_hash = ?').get(sha256(m[1]));
  if (!n) return next(httpError(401, 'Unknown node key'));
  req.node = n;
  db.prepare('UPDATE nodes SET last_seen = ? WHERE id = ?').run(now(), n.id);
  next();
}

// ---- catalog ----
function localCatalog({ offset = 0, limit = 2000 } = {}) {
  return db.prepare('SELECT id, profile_id, path, size, duration, title, artist, album, album_artist, year, genre, track_no, audio_hash, hash, bitrate, updated_at FROM tracks ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
}

export async function pullCatalog(n, ctx) {
  let offset = 0;
  const seen = new Set();
  for (;;) {
    const page = await call(n, `/api/fed/catalog?offset=${offset}&limit=2000`, { timeout: 60000 });
    tx(() => {
      for (const t of page.tracks) {
        seen.add(t.id);
        db.prepare(`INSERT INTO remote_tracks (node_id, remote_track_id, audio_hash, hash, path, size, duration, title, artist, album, album_artist, year, genre, track_no, ext, bitrate, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(node_id, remote_track_id) DO UPDATE SET audio_hash=excluded.audio_hash, hash=excluded.hash, path=excluded.path, size=excluded.size, duration=excluded.duration, title=excluded.title, artist=excluded.artist, album=excluded.album, album_artist=excluded.album_artist, year=excluded.year, genre=excluded.genre, track_no=excluded.track_no, ext=excluded.ext, bitrate=excluded.bitrate, updated_at=excluded.updated_at`).run(
          n.id, t.id, t.audio_hash, t.hash, t.path, t.size, t.duration, t.title, t.artist, t.album, t.album_artist, t.year, t.genre, t.track_no, path.extname(t.path || '').slice(1), t.bitrate, now(),
        );
      }
    });
    ctx?.progress?.(0.5, `${seen.size} songs from ${n.name}`);
    if (page.tracks.length < 2000) break;
    offset += 2000;
  }
  // Songs the node no longer has.
  const ids = db.prepare('SELECT remote_track_id FROM remote_tracks WHERE node_id = ?').all(n.id).map((r) => r.remote_track_id);
  tx(() => ids.filter((id) => !seen.has(id)).forEach((id) => db.prepare('DELETE FROM remote_tracks WHERE node_id = ? AND remote_track_id = ?').run(n.id, id)));
  db.prepare('UPDATE nodes SET catalog_at = ? WHERE id = ?').run(now(), n.id);
  return seen.size;
}

// ---- host: push our state ----
function stateSnapshot(since) {
  const s = settings.all();
  delete s.auth;
  delete s.plugin;
  return {
    instance: instance(),
    version: VERSION,
    at: now(),
    settings: s,
    stats: db.prepare('SELECT profile_id, COUNT(*) tracks, SUM(size) size, SUM(duration) duration FROM tracks GROUP BY profile_id').all(),
    profiles: db.prepare('SELECT id, name, kind, url, public_url, local_path FROM profiles').all(),
    scrobbles: db.prepare('SELECT ts, username, title, artist, album, album_artist, duration, mbid FROM scrobbles WHERE ts >= ? ORDER BY ts LIMIT 50000').all(since || 0),
    shares: db.prepare('SELECT id, name, kind, visibility, created_at, views FROM shares').all(),
  };
}

// ---- streaming fallback ----
export async function streamFromPeers(audioHash, req, res) {
  const rows = db.prepare('SELECT r.*, n.modes FROM remote_tracks r JOIN nodes n ON n.id = r.node_id WHERE r.audio_hash = ?').all(audioHash);
  for (const r of rows) {
    const n = nodeRow(r.node_id);
    if (!n || !modesOf(n).stream) continue;
    try {
      const resp = await call(n, `/api/fed/stream/${audioHash}`, { raw: true, headers: req.get('range') ? { Range: req.get('range') } : {}, timeout: 8000 });
      res.status(resp.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (resp.headers.get(h)) res.set(h, resp.headers.get(h));
      res.set('X-MMM-Source', `node:${n.name}`);
      Readable.fromWeb(resp.body).pipe(res);
      return true;
    } catch {}
  }
  return false;
}

/** Where can a song (by audio hash) be played right now? */
export function availability(audioHash) {
  const local = db.prepare('SELECT profile_id FROM tracks WHERE audio_hash = ?').all(audioHash);
  const remote = db.prepare('SELECT node_id FROM remote_tracks WHERE audio_hash = ?').all(audioHash).map((r) => publicNode(nodeRow(r.node_id)));
  return { local: local.length > 0, nodes: remote.map((n) => ({ id: n.id, name: n.name, online: n.online })) };
}

// ---- the sync loop ----
export async function syncNode(n, ctx) {
  const m = modesOf(n);
  const hello = await call(n, '/api/fed/hello');
  db.prepare('UPDATE nodes SET info = ?, name = ? WHERE id = ?').run(JSON.stringify(hello), hello.name || n.name, n.id);
  ctx?.log?.(`${n.name}: online (${hello.version}), ${hello.tracks} songs`);
  if (m.catalog || m.stream || m.mirror) ctx?.log?.(`  catalog: ${await pullCatalog(n, ctx)} songs`);
  if (m.host) {
    const info = JSON.parse(n.info || '{}');
    const r = await call(n, '/api/fed/state', { method: 'POST', body: stateSnapshot(info.pushedUntil || 0), timeout: 60000 });
    db.prepare("UPDATE nodes SET info = json_set(info, '$.pushedUntil', ?) WHERE id = ?").run(Math.floor(Date.now() / 1000) - 3600, n.id);
    ctx?.log?.(`  state sent to host (${r.scrobbles?.added ?? 0} new listens there)`);
  }
  if (m.settings) {
    const remote = await call(n, '/api/fed/settings');
    for (const k of ['appearance', 'library', 'convert', 'player', 'shares']) if (remote[k]) settings.set(k, remote[k]);
    ctx?.log?.('  settings taken from this node');
  }
  if (m.mirror) await mirror(n, ctx);
}

async function mirror(n, ctx) {
  const target = getProfile(modesOf(n).mirrorProfile) || db.prepare('SELECT * FROM profiles WHERE local_path IS NOT NULL ORDER BY sort LIMIT 1').get();
  if (!target) return ctx?.log?.('  mirror: no local folder to copy into');
  const have = new Set(db.prepare('SELECT audio_hash FROM tracks WHERE audio_hash IS NOT NULL').all().map((r) => r.audio_hash));
  const want = db.prepare('SELECT * FROM remote_tracks WHERE node_id = ? AND audio_hash IS NOT NULL').all(n.id).filter((r) => !have.has(r.audio_hash));
  ctx?.log?.(`  mirror: ${want.length} songs to copy into ${target.name}`);
  let i = 0;
  let copied = 0;
  for (const r of want) {
    ctx?.check?.();
    try {
      let rel = r.path;
      let dest = lib.absPath(target, rel);
      if (fs.existsSync(dest)) {
        rel = rel.replace(/(\.[^.]+)$/, ` (${n.name})$1`);
        dest = lib.absPath(target, rel);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const resp = await call(n, `/api/fed/stream/${r.audio_hash}`, { raw: true, timeout: 600_000 });
      await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(`${dest}.part`));
      fs.renameSync(`${dest}.part`, dest);
      const t = await lib.rescanFile(target, rel);
      db.prepare('UPDATE tracks SET audio_hash = ? WHERE id = ?').run(r.audio_hash, t.id);
      have.add(r.audio_hash);
      copied++;
    } catch (e) {
      ctx?.log?.(`  ! ${r.path}: ${e.message}`);
    }
    ctx?.progress?.(++i / want.length, `Copied ${i} / ${want.length}`);
  }
  if (copied) lib.touchService(target);
}

export function syncAll({ userId } = {}) {
  return jobs.start(
    'federation',
    'Syncing linked instances',
    async (ctx) => {
      const nodes = db.prepare('SELECT * FROM nodes').all();
      const results = {};
      for (const n of nodes) {
        try {
          await syncNode(n, ctx);
          results[n.name] = 'ok';
        } catch (e) {
          results[n.name] = `offline: ${e.message}`;
          ctx.log(`${n.name}: ${e.message} (kept its last known song list)`);
        }
      }
      return results;
    },
    { userId },
  );
}

let timer = null;
export function startLoop() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (db.prepare('SELECT COUNT(*) n FROM nodes').get().n) syncAll();
  }, 15 * 60_000);
  timer.unref();
}

export function register(app) {
  // ---- for the GUI ----
  app.get('/api/nodes', requireUser, json(() => ({ self: { ...instance(), lanUrls: lanUrls(), publicUrl: settings.get('public').url || null }, nodes: db.prepare('SELECT * FROM nodes ORDER BY created_at').all().map(publicNode) })));
  app.post(
    '/api/nodes/code',
    requireAdmin,
    json((req) => {
      const secret = token(18);
      pending.set(secret, now() + 30 * 60_000);
      const inst = instance();
      const urls = { local: str(req.body.localUrl, 300) || lanUrls()[0] || null, public: str(req.body.publicUrl, 300) || settings.get('public').url || null };
      const code = Buffer.from(JSON.stringify({ v: 1, id: inst.id, name: inst.name, ...urls, secret })).toString('base64url');
      return { code: `mmm1.${code}`, expiresIn: 1800, urls };
    }),
  );
  app.post(
    '/api/nodes/join',
    requireAdmin,
    json(async (req) => {
      const raw = str(req.body.code, 4000).trim().replace(/^mmm1\./, '');
      let c;
      try {
        c = JSON.parse(Buffer.from(raw, 'base64url').toString());
      } catch {
        throw httpError(400, 'That code is not valid');
      }
      if (c.id === instance().id) throw httpError(400, 'That code is from this instance itself');
      const ourKey = token(32); // they send this to us
      const inst = instance();
      const tryUrls = [c.local, c.public].filter(Boolean);
      let answer;
      let used;
      for (const u of tryUrls) {
        try {
          const r = await fetch(`${u.replace(/\/$/, '')}/api/fed/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-MMM': '1' },
            body: JSON.stringify({ secret: c.secret, node: { id: inst.id, name: inst.name, localUrl: str(req.body.localUrl, 300) || lanUrls()[0], publicUrl: str(req.body.publicUrl, 300) || settings.get('public').url || null, key: ourKey } }),
            signal: AbortSignal.timeout(u === c.local ? 3000 : 15000),
          });
          answer = await r.json();
          if (!r.ok) throw new Error(answer.error || `answered ${r.status}`);
          used = u;
          break;
        } catch (e) {
          answer = { error: e.message };
        }
      }
      if (!used) throw httpError(502, `Could not reach ${c.name}: ${answer?.error}. Is it running, and is one of its addresses reachable from here?`);
      db.prepare('INSERT OR REPLACE INTO nodes (id, name, local_url, public_url, modes, their_key, our_key_hash, last_seen, last_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        c.id, c.name, c.local, c.public, JSON.stringify(req.body.modes || { catalog: true, stream: true }), seal(answer.key), sha256(ourKey), now(), used, now(),
      );
      audit(req.user.id, 'node.pair', { name: c.name });
      setTimeout(() => syncAll(), 500);
      return publicNode(nodeRow(c.id));
    }),
  );
  app.patch(
    '/api/nodes/:id',
    requireAdmin,
    json((req) => {
      const n = nodeRow(req.params.id);
      if (!n) throw httpError(404, 'No such node');
      const modes = { ...modesOf(n), ...(req.body.modes || {}) };
      db.prepare('UPDATE nodes SET name = COALESCE(?, name), local_url = COALESCE(?, local_url), public_url = COALESCE(?, public_url), modes = ? WHERE id = ?').run(req.body.name ?? null, req.body.localUrl ?? null, req.body.publicUrl ?? null, JSON.stringify(modes), n.id);
      return publicNode(nodeRow(n.id));
    }),
  );
  app.delete(
    '/api/nodes/:id',
    requireAdmin,
    json(async (req) => {
      const n = nodeRow(req.params.id);
      if (!n) throw httpError(404, 'No such node');
      await call(n, '/api/fed/unpair', { method: 'POST' }).catch(() => null);
      db.prepare('DELETE FROM remote_tracks WHERE node_id = ?').run(n.id);
      db.prepare('DELETE FROM nodes WHERE id = ?').run(n.id);
      audit(req.user.id, 'node.unpair', { name: n.name });
      return { ok: true };
    }),
  );
  app.post('/api/nodes/sync', requireUser, json((req) => ({ job: syncAll({ userId: req.user.id }) })));
  app.get(
    '/api/nodes/catalog',
    requireUser,
    json((req) => {
      // Everything every node has, merged by identical audio; offline nodes' songs are marked unavailable.
      const q = `%${str(req.query.q, 200)}%`;
      const rows = db.prepare('SELECT * FROM remote_tracks WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? ORDER BY artist, album, track_no LIMIT 2000').all(q, q, q);
      const nodes = new Map(db.prepare('SELECT * FROM nodes').all().map((n) => [n.id, publicNode(n)]));
      const localHashes = new Set(db.prepare('SELECT audio_hash FROM tracks WHERE audio_hash IS NOT NULL').all().map((r) => r.audio_hash));
      const merged = new Map();
      for (const r of rows) {
        const k = r.audio_hash || `${r.node_id}:${r.remote_track_id}`;
        if (!merged.has(k)) merged.set(k, { ...r, here: localHashes.has(r.audio_hash), on: [] });
        merged.get(k).on.push({ id: r.node_id, name: nodes.get(r.node_id)?.name, online: nodes.get(r.node_id)?.online });
      }
      return [...merged.values()].map((m) => ({ ...m, available: m.here || m.on.some((o) => o.online) }));
    }),
  );
  app.get('/api/nodes/states', requireAdmin, json(() => {
    const dir = path.join(PATHS.data, 'nodes');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((id) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, id, 'state.json'), 'utf8'));
        return { id, name: s.instance?.name, at: s.at, version: s.version, stats: s.stats, profiles: s.profiles };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }));

  // ---- for other nodes ----
  app.post(
    '/api/fed/pair',
    json((req) => {
      const secret = str(req.body.secret, 100);
      const exp = pending.get(secret);
      if (!exp || exp < now()) throw httpError(401, 'This pairing code expired or was already used');
      pending.delete(secret);
      const nd = req.body.node || {};
      if (!nd.id || !nd.key) throw httpError(400, 'Incomplete pairing request');
      const keyForThem = token(32);
      db.prepare('INSERT OR REPLACE INTO nodes (id, name, local_url, public_url, modes, their_key, our_key_hash, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        nd.id, str(nd.name, 100) || 'Instance', str(nd.localUrl, 300) || null, str(nd.publicUrl, 300) || null, JSON.stringify({ catalog: true, stream: true }), seal(nd.key), sha256(keyForThem), now(), now(),
      );
      audit(null, 'node.paired', { name: nd.name });
      const inst = instance();
      return { id: inst.id, name: inst.name, key: keyForThem };
    }),
  );
  app.post('/api/fed/unpair', nodeAuth, json((req) => {
    db.prepare('DELETE FROM remote_tracks WHERE node_id = ?').run(req.node.id);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(req.node.id);
    return { ok: true };
  }));
  app.get('/api/fed/hello', nodeAuth, json(() => ({ ...instance(), version: VERSION, time: now(), tracks: db.prepare('SELECT COUNT(*) n FROM tracks').get().n, lanUrls: lanUrls() })));
  app.get('/api/fed/catalog', nodeAuth, json((req) => {
    if (!modesOf(req.node).serve) throw httpError(403, 'This instance does not share its songs with you');
    return { tracks: localCatalog({ offset: Number(req.query.offset) || 0, limit: Math.min(Number(req.query.limit) || 2000, 5000) }) };
  }));
  app.get('/api/fed/stream/:hash', nodeAuth, (req, res) => {
    if (!modesOf(req.node).serve) return res.status(403).end();
    const t = db.prepare('SELECT * FROM tracks WHERE audio_hash = ?').get(String(req.params.hash));
    if (!t) return res.status(404).end();
    const p = getProfile(t.profile_id);
    if (!p?.local_path) return res.status(404).end();
    res.sendFile(lib.absPath(p, t.path), { acceptRanges: true });
  });
  app.post('/api/fed/state', nodeAuth, json((req) => {
    // We are this node's host: keep its state, merge its listens.
    const dir = path.join(PATHS.data, 'nodes', req.node.id.replace(/[^\w-]/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    const { scrobbles = [], ...rest } = req.body || {};
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(rest));
    const r = mergeScrobbles(scrobbles.map((s) => ({ ...s, albumArtist: s.album_artist })), { username: null, source: `node:${req.node.name}` });
    return { ok: true, scrobbles: r };
  }));
  // Another instance sends us a song (transfer / move).
  app.post('/api/fed/receive', nodeAuth, async (req, res, next) => {
    try {
      if (!modesOf(req.node).acceptFiles && modesOf(req.node).acceptFiles !== undefined) throw httpError(403, 'This instance does not accept songs from you');
      const target = getProfile(String(req.query.profile || '')) || db.prepare('SELECT * FROM profiles WHERE local_path IS NOT NULL ORDER BY sort LIMIT 1').get();
      if (!target?.local_path) throw httpError(400, 'This instance has no library folder');
      const hash = String(req.query.hash || '');
      if (req.query.skipExisting !== 'false' && hash && db.prepare('SELECT 1 FROM tracks WHERE audio_hash = ?').get(hash)) {
        req.resume();
        return res.json({ skipped: true });
      }
      let rel = String(req.query.path || `From ${req.node.name}/${Date.now()}.mp3`).replace(/^\/+/, '');
      let dest = lib.absPath(target, rel);
      for (let i = 2; fs.existsSync(dest); i++) dest = lib.absPath(target, rel.replace(/(\.[^.]+)$/, ` (${i})$1`));
      rel = path.relative(target.local_path, dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(req, fs.createWriteStream(`${dest}.part`));
      fs.renameSync(`${dest}.part`, dest);
      const t = await lib.rescanFile(target, rel);
      if (hash) db.prepare('UPDATE tracks SET audio_hash = ? WHERE id = ?').run(hash, t.id);
      lib.touchService(target);
      audit(null, 'fed.receive', { from: req.node.name, path: rel });
      res.json({ ok: true, path: rel });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/fed/remove', nodeAuth, json((req) => {
    if (modesOf(req.node).allowRemove === false) throw httpError(403, 'This instance does not let you remove songs');
    let removed = 0;
    for (const h of (req.body.hashes || []).slice(0, 10000)) {
      for (const r of db.prepare('SELECT id, profile_id FROM tracks WHERE audio_hash = ?').all(String(h))) {
        const p = getProfile(r.profile_id);
        const t = p && lib.byId(p.id, r.id);
        if (t) {
          lib.trash(p, t, null);
          removed++;
        }
      }
    }
    audit(null, 'fed.remove', { from: req.node.name, removed });
    return { removed };
  }));
  app.get('/api/fed/settings', nodeAuth, json(() => {
    const s = settings.all();
    return { appearance: s.appearance, library: s.library, convert: s.convert, player: s.player, shares: s.shares };
  }));

  startLoop();
  void bool;
  void safeEqual;
  void log;
}
