// The local library index: scanning folders, an in-memory copy of every track
// for instant filtering, editing tags, moving files, restore points.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now, audit, tx } from '../db.js';
import { PATHS } from '../config.js';
import * as settings from '../settings.js';
import * as jobs from '../jobs.js';
import * as tags from './tags.js';
import { targetPath, normalizeArtistTags } from './naming.js';
import { compile, sorter, parseSort } from './query.js';
import { log } from '../lib/log.js';
import { uuid } from '../lib/crypto.js';
import { readPlan, breathe, inDiskOrder } from '../lib/disk.js';

export const MEDIA_EXT = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wv', 'ape', 'wma', 'aif', 'aiff', 'alac', 'dsf', 'dff', 'mpc', 'm4b', 'mka', 'tta', 'caf']);
export const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'wmv', 'ts', 'mpg', 'mpeg', '3gp']);
const SKIP_DIRS = new Set(['.originals', '.canvas', '.mmm', '@eaDir', '#recycle', '.Trash', 'lost+found', '.spotify-dl-working']);

// ---- in-memory index ----
const cache = new Map(); // profileId -> { list, byId }

export function flat(r) {
  const t = JSON.parse(r.tags || '{}');
  const custom = t.__custom || {};
  delete t.__custom;
  const filename = path.basename(r.path);
  return {
    ...t,
    id: r.id,
    profileId: r.profile_id,
    path: r.path,
    filename,
    folder: path.dirname(r.path),
    ext: path.extname(r.path).slice(1).toLowerCase(),
    size: r.size,
    mtime: r.mtime,
    modified: r.mtime,
    added: r.added_at,
    hash: r.hash,
    duration: r.duration,
    bitrate: r.bitrate,
    samplerate: r.sample_rate,
    channels: r.channels,
    bits: r.bits,
    codec: r.codec,
    container: r.container,
    lossless: Boolean(r.lossless),
    cover: Boolean(r.has_cover),
    haslyrics: Boolean(r.has_lyrics),
    nosplit: Boolean(r.no_split),
    remoteId: r.remote_id,
    online: Boolean(r.remote_id),
    custom,
  };
}

function load(profileId) {
  if (!cache.has(profileId)) {
    const list = db.prepare('SELECT * FROM tracks WHERE profile_id = ?').all(profileId).map(flat);
    cache.set(profileId, { list, byId: new Map(list.map((t) => [t.id, t])) });
  }
  return cache.get(profileId);
}
export const all = (profileId) => load(profileId).list;
export const byId = (profileId, id) => load(profileId).byId.get(Number(id));
export function invalidate(profileId) {
  cache.delete(profileId);
}
function refreshRow(profileId, id) {
  const c = cache.get(profileId);
  if (!c) return;
  const r = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
  const i = c.list.findIndex((t) => t.id === Number(id));
  if (!r) {
    if (i >= 0) c.list.splice(i, 1);
    c.byId.delete(Number(id));
    return;
  }
  const t = flat(r);
  if (i >= 0) c.list[i] = t;
  else c.list.push(t);
  c.byId.set(t.id, t);
  return t;
}

export function query(profileId, { q = '', sort = '', offset = 0, limit = 200 } = {}) {
  const { test, sort: qs } = compile(q);
  let list = all(profileId).filter(test);
  const spec = qs.length ? qs : parseSort(sort || 'albumartist,album,disc,track,title');
  const cmp = sorter(spec);
  if (cmp) list = list.slice().sort(cmp);
  return { total: list.length, list: limit === Infinity ? list : list.slice(offset, offset + limit), sort: spec };
}

export function absPath(profile, rel) {
  if (!profile.local_path) throw Object.assign(new Error('This profile has no linked folder'), { status: 400 });
  const abs = path.resolve(profile.local_path, rel);
  if (abs !== profile.local_path && !abs.startsWith(profile.local_path.replace(/\/?$/, '/'))) throw Object.assign(new Error('Path outside the library'), { status: 400 });
  return abs;
}

// ---- scanning ----
async function* walk(dir, root) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') {
      if (SKIP_DIRS.has(e.name) || e.isDirectory()) continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full, root);
    } else if (e.isFile() || e.isSymbolicLink()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (MEDIA_EXT.has(ext)) yield full;
    }
  }
}

function rowFromRead(profileId, rel, st, data, existing) {
  const t = { ...data.tags, __custom: data.custom };
  return {
    profile_id: profileId,
    path: rel,
    size: st.size,
    mtime: Math.round(st.mtimeMs),
    duration: data.info.duration,
    bitrate: data.info.bitrate,
    sample_rate: data.info.sampleRate,
    channels: data.info.channels,
    bits: data.info.bits,
    codec: data.info.codec,
    container: data.info.container,
    lossless: data.info.lossless ? 1 : 0,
    title: data.tags.title ?? null,
    artist: data.tags.artist ?? null,
    album: data.tags.album ?? null,
    album_artist: data.tags.albumartist ?? null,
    genre: data.tags.genre?.join('; ') ?? null,
    year: data.tags.year ?? null,
    track_no: data.tags.track ?? null,
    track_of: data.tags.tracktotal ?? null,
    disc_no: data.tags.disc ?? null,
    disc_of: data.tags.disctotal ?? null,
    has_cover: data.hasCover ? 1 : 0,
    has_lyrics: data.tags.lyrics ? 1 : 0,
    tags: JSON.stringify(t),
    hash: existing && existing.size === st.size && existing.mtime === Math.round(st.mtimeMs) ? existing.hash : null,
  };
}

const upsert = () =>
  db.prepare(`INSERT INTO tracks (profile_id, path, size, mtime, duration, bitrate, sample_rate, channels, bits, codec, container, lossless, title, artist, album, album_artist, genre, year, track_no, track_of, disc_no, disc_of, has_cover, has_lyrics, tags, hash, added_at, updated_at)
    VALUES (@profile_id, @path, @size, @mtime, @duration, @bitrate, @sample_rate, @channels, @bits, @codec, @container, @lossless, @title, @artist, @album, @album_artist, @genre, @year, @track_no, @track_of, @disc_no, @disc_of, @has_cover, @has_lyrics, @tags, @hash, @added_at, @updated_at)
    ON CONFLICT(profile_id, path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, duration=excluded.duration, bitrate=excluded.bitrate, sample_rate=excluded.sample_rate, channels=excluded.channels, bits=excluded.bits, codec=excluded.codec, container=excluded.container, lossless=excluded.lossless, title=excluded.title, artist=excluded.artist, album=excluded.album, album_artist=excluded.album_artist, genre=excluded.genre, year=excluded.year, track_no=excluded.track_no, track_of=excluded.track_of, disc_no=excluded.disc_no, disc_of=excluded.disc_of, has_cover=excluded.has_cover, has_lyrics=excluded.has_lyrics, tags=excluded.tags, hash=excluded.hash, updated_at=excluded.updated_at`);

/** Re-read one file (after an edit or a move). Returns the fresh track. */
export async function rescanFile(profile, rel, { oldRel } = {}) {
  const abs = absPath(profile, rel);
  const st = fs.statSync(abs);
  const data = await tags.read(abs, { covers: true });
  const existing = db.prepare('SELECT * FROM tracks WHERE profile_id = ? AND path = ?').get(profile.id, oldRel || rel);
  const row = rowFromRead(profile.id, rel, st, data, null);
  if (existing) {
    db.prepare(`UPDATE tracks SET path=@path, size=@size, mtime=@mtime, duration=@duration, bitrate=@bitrate, sample_rate=@sample_rate, channels=@channels, bits=@bits, codec=@codec, container=@container, lossless=@lossless, title=@title, artist=@artist, album=@album, album_artist=@album_artist, genre=@genre, year=@year, track_no=@track_no, track_of=@track_of, disc_no=@disc_no, disc_of=@disc_of, has_cover=@has_cover, has_lyrics=@has_lyrics, tags=@tags, hash=NULL, updated_at=@updated_at WHERE id=@id`).run({
      ...row,
      id: existing.id,
      updated_at: now(),
    });
    return refreshRow(profile.id, existing.id);
  }
  const info = upsert().run({ ...row, added_at: now(), updated_at: now() });
  return refreshRow(profile.id, info.lastInsertRowid) || byId(profile.id, info.lastInsertRowid);
}

// Bump when reading tags changes, so every library re-reads its files once
// (2: track and disc numbers, which music-metadata 13 had renamed).
const READ_FORMAT = 2;
export function scan(profile, { full = false, userId } = {}) {
  const formats = settings.get('scanFormat') || {};
  const upgrade = formats[profile.id] !== READ_FORMAT;
  if (upgrade) full = true;
  return jobs.start(
    'scan',
    `${full ? 'Full' : 'Quick'} scan · ${profile.name}`,
    async (ctx) => {
      if (!profile.local_path) throw new Error('No folder is linked to this profile');
      ctx.log(`Scanning ${profile.local_path} (${full ? 'every file' : 'new and changed files'})${upgrade ? ' once, to pick up track and disc numbers' : ''}`);
      const known = new Map(db.prepare('SELECT id, path, size, mtime, hash FROM tracks WHERE profile_id = ?').all(profile.id).map((r) => [r.path, r]));
      let files = [];
      for await (const f of walk(profile.local_path, profile.local_path)) files.push(f);
      // Songs you took out stay out (their files are still there).
      const out = takenOutSet(profile.id);
      if (out.size) files = files.filter((f) => !out.has(path.relative(profile.local_path, f).split(path.sep).join('/')));
      ctx.log(`${files.length} media files found${out.size ? ` (${out.size} taken out, left alone)` : ''}`);
      const plan = readPlan(profile.local_path);
      if (plan.gentle) {
        ctx.log(`${plan.forced ? 'Set to spinning disk' : plan.detected === 'hdd' ? 'Spinning disk found' : 'Disk type unknown, so treating it like a spinning disk'}: reading one file at a time in the order they lie on the disk, and pausing while music plays. Slower, but quiet and easy on the drive. (Settings → Library & naming → Disk)`);
        // Only new / changed files are read; the rest is just a quick look at their size and date.
        files = await inDiskOrder(files);
      }
      const seen = new Set();
      let changed = 0;
      let failed = 0;
      const stmt = upsert();
      const batch = [];
      const flush = () => {
        if (!batch.length) return;
        tx(() => {
          for (const r of batch) stmt.run(r);
        });
        batch.length = 0;
      };
      let i = 0;
      const worker = async () => {
        while (i < files.length) {
          ctx.check();
          const file = files[i++];
          const rel = path.relative(profile.local_path, file);
          seen.add(rel);
          let st;
          try {
            st = await fsp.stat(file);
          } catch {
            continue;
          }
          const old = known.get(rel);
          if (!full && old && old.size === st.size && old.mtime === Math.round(st.mtimeMs)) continue;
          try {
            const data = await tags.read(file, { covers: true });
            batch.push({ ...rowFromRead(profile.id, rel, st, data, old), added_at: old ? undefined : Math.round(st.birthtimeMs || st.mtimeMs) || now(), updated_at: now() });
            if (batch.at(-1).added_at === undefined) batch.at(-1).added_at = now();
            changed++;
            if (batch.length >= 200) flush();
          } catch (e) {
            failed++;
            ctx.log(`! ${rel}: ${e.message}`);
          }
          if (i % 50 === 0) ctx.progress(i / files.length, `${i} / ${files.length} files`);
          await breathe(plan);
        }
      };
      await Promise.all(Array.from({ length: plan.workers }, worker));
      flush();
      const gone = [...known.keys()].filter((p) => !seen.has(p));
      if (gone.length) {
        tx(() => {
          for (const p of gone) db.prepare('DELETE FROM tracks WHERE profile_id = ? AND path = ?').run(profile.id, p);
        });
        ctx.log(`${gone.length} files are gone and were removed from the index`);
      }
      invalidate(profile.id);
      ctx.log(`${changed} read, ${failed} unreadable, ${gone.length} removed`);
      if (upgrade) settings.set('scanFormat', { [profile.id]: READ_FORMAT });
      if (profile.url) {
        try {
          const matched = await syncRemoteIds(profile, ctx);
          ctx.log(`${matched} tracks matched to ${profile.name}`);
        } catch (e) {
          ctx.log(`Could not match with ${profile.name}: ${e.message} (the local index is still complete)`);
        }
      }
      audit(userId, 'library.scan', { profile: profile.id, full, files: files.length, changed });
      return { files: files.length, changed, failed, removed: gone.length };
    },
    { userId },
  );
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Attach the service's id to each local track: by path when possible, else by tags. */
export async function syncRemoteIds(profile, ctx) {
  const { forProfile } = await import('../services/index.js');
  const svc = forProfile(profile);
  const opts = JSON.parse(profile.options || '{}');
  const local = all(profile.id);
  const byPath = new Map(local.map((t) => [t.path, t]));
  const byKey = new Map();
  for (const t of local) {
    byKey.set(`${norm(t.title)}|${norm(t.album)}|${Math.round(t.duration || 0)}`, t);
    if (!byKey.has(`${norm(t.title)}|${norm(t.artist)}`)) byKey.set(`${norm(t.title)}|${norm(t.artist)}`, t);
  }
  const updates = [];
  let remoteCount = 0;
  const take = (s, realPath) => {
    remoteCount++;
    let rel = realPath;
    if (rel && path.isAbsolute(rel)) {
      if (opts.remotePrefix && rel.startsWith(opts.remotePrefix)) rel = rel.slice(opts.remotePrefix.length).replace(/^\/+/, '');
      else if (profile.local_path && rel.startsWith(profile.local_path)) rel = path.relative(profile.local_path, rel);
    }
    const t = (rel && byPath.get(rel)) || byKey.get(`${norm(s.title)}|${norm(s.album)}|${Math.round(s.duration || 0)}`) || byKey.get(`${norm(s.title)}|${norm(s.artist)}`);
    if (t && t.remoteId !== s.id) updates.push([s.id, t.id]);
  };
  if (profile.kind === 'navidrome') {
    // The native API reports real, library-relative paths.
    try {
      for (let start = 0; ; start += 1000) {
        const page = await svc.c.native('song', { query: { _start: start, _end: start + 1000, _sort: 'path', _order: 'ASC' } });
        for (const s of page || []) take(s, s.path);
        ctx?.progress?.(0.99, `Matching with ${profile.name}: ${start + (page?.length || 0)} songs`);
        if (!page || page.length < 1000) break;
      }
    } catch (e) {
      ctx?.log?.(`Navidrome native API not usable (${e.message}); matching with the Subsonic API`);
      for await (const list of svc.allSongs()) for (const s of list) take(s, s.path);
    }
  } else {
    for await (const list of svc.allSongs()) for (const s of list) take(s, s.path);
  }
  tx(() => {
    for (const [rid, id] of updates) db.prepare('UPDATE tracks SET remote_id = ? WHERE id = ?').run(rid, id);
  });
  invalidate(profile.id);
  ctx?.log?.(`${remoteCount} songs on the service`);
  return all(profile.id).filter((t) => t.remoteId).length;
}

// ---- hashing (for exact duplicates) ----
export async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export async function ensureHashes(profile, ctx) {
  const plan = readPlan(profile.local_path);
  let missing = all(profile.id).filter((t) => !t.hash);
  if (plan.gentle) {
    const order = await inDiskOrder(missing.map((t) => absPath(profile, t.path)));
    const byAbs = new Map(missing.map((t) => [absPath(profile, t.path), t]));
    missing = order.map((f) => byAbs.get(f));
  }
  let done = 0;
  for (const t of missing) {
    ctx?.check();
    await breathe(plan);
    try {
      const h = await hashFile(absPath(profile, t.path));
      db.prepare('UPDATE tracks SET hash = ? WHERE id = ?').run(h, t.id);
      t.hash = h;
    } catch {}
    if (++done % 25 === 0) ctx?.progress(done / missing.length, `Fingerprinting ${done} / ${missing.length}`);
  }
}

// ---- restore points ----
export function createRestorePoint(profile, track, label = 'Before edit') {
  const abs = absPath(profile, track.path);
  const id = uuid();
  const file = path.join(PATHS.restore, `${id}${path.extname(abs)}`);
  fs.copyFileSync(abs, file);
  db.prepare('INSERT INTO restore_points (id, profile_id, path, file, label, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, profile.id, track.path, file, label, fs.statSync(file).size, now());
  return id;
}

export function restorePoints(profileId, trackPath) {
  return db.prepare('SELECT id, path, label, size, created_at FROM restore_points WHERE profile_id = ? AND path = ? ORDER BY created_at DESC').all(profileId, trackPath);
}

export async function restore(profile, id) {
  const rp = db.prepare('SELECT * FROM restore_points WHERE id = ? AND profile_id = ?').get(id, profile.id);
  if (!rp) throw Object.assign(new Error('No such restore point'), { status: 404 });
  const current = db.prepare('SELECT * FROM tracks WHERE profile_id = ? AND path = ?').get(profile.id, rp.path);
  if (current) createRestorePoint(profile, flat(current), 'Before restoring');
  const abs = absPath(profile, rp.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(rp.file, abs);
  return rescanFile(profile, rp.path);
}

export function deleteRestorePoint(id) {
  const rp = db.prepare('SELECT * FROM restore_points WHERE id = ?').get(id);
  if (rp) fs.rmSync(rp.file, { force: true });
  db.prepare('DELETE FROM restore_points WHERE id = ?').run(id);
}

// ---- edits and moves ----
const dirty = new Map();
/** Ask the service to rescan a little after the last change (debounced). */
export async function touchService(profile) {
  if (!profile.url || !settings.get('library').rescanAfterChanges) return;
  clearTimeout(dirty.get(profile.id));
  dirty.set(
    profile.id,
    setTimeout(async () => {
      dirty.delete(profile.id);
      try {
        const { forProfile } = await import('../services/index.js');
        await forProfile(profile).scan(false);
        log.info(`asked ${profile.name} to rescan`);
      } catch (e) {
        log.warn(`could not ask ${profile.name} to rescan: ${e.message}`);
      }
    }, 8000),
  );
}

function removeEmptyDirs(profile, dir) {
  let d = dir;
  while (d.startsWith(profile.local_path) && d !== profile.local_path) {
    try {
      const left = fs.readdirSync(d).filter((n) => !/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(n));
      const onlyArt = left.every((n) => /^(cover|folder|front|album)\.(jpe?g|png|webp)$|^\.canvas$/i.test(n));
      if (left.length && !onlyArt) break;
      if (left.length && onlyArt) break; // keep art folders; the album may come back
      fs.rmSync(d, { recursive: true });
      d = path.dirname(d);
    } catch {
      break;
    }
  }
}

/** Move a file to `rel` (and its sidecars: .lrc, .canvas). Returns the final rel path. */
export function moveFile(profile, fromRel, toRel) {
  if (fromRel === toRel) return fromRel;
  const from = absPath(profile, fromRel);
  let to = absPath(profile, toRel);
  if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) {
    const ext = path.extname(to);
    for (let i = 2; fs.existsSync(to); i++) to = absPath(profile, toRel.replace(new RegExp(`${ext.replace('.', '\\.')}$`), ` (${i})${ext}`));
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to); // another disk mounted inside the library
    fs.rmSync(from);
  }
  for (const side of ['.lrc', '.txt']) {
    const s = from.replace(/\.[^.]+$/, side);
    if (fs.existsSync(s)) fs.renameSync(s, to.replace(/\.[^.]+$/, side));
  }
  const canvasFrom = path.join(path.dirname(from), '.canvas', path.basename(from).replace(/\.[^.]+$/, ''));
  if (fs.existsSync(canvasFrom)) {
    const canvasTo = path.join(path.dirname(to), '.canvas', path.basename(to).replace(/\.[^.]+$/, ''));
    fs.mkdirSync(path.dirname(canvasTo), { recursive: true });
    fs.renameSync(canvasFrom, canvasTo);
  }
  removeEmptyDirs(profile, path.dirname(from));
  const newRel = path.relative(profile.local_path, to);
  db.prepare('UPDATE restore_points SET path = ? WHERE profile_id = ? AND path = ?').run(newRel, profile.id, fromRel);
  return newRel;
}

/**
 * Apply an edit to one track: tags, cover, artist separators, then move it
 * where the template says. `edit` = { tags, custom, lyrics, comments, cover, noSplit }.
 */
export async function applyEdit(profile, track, edit, { organize, restorePoint = true, userId } = {}) {
  const lib = settings.get('library');
  const abs = absPath(profile, track.path);
  if (restorePoint) createRestorePoint(profile, track, edit.label || 'Before edit');
  if (edit.noSplit !== undefined) db.prepare('UPDATE tracks SET no_split = ? WHERE id = ?').run(edit.noSplit ? 1 : 0, track.id);
  const merged = { ...track, ...(edit.tags || {}) };
  const noSplit = edit.noSplit ?? track.nosplit;
  const fixes = edit.skipSeparators ? {} : normalizeArtistTags(merged, lib, { noSplit });
  const finalEdit = { ...edit, tags: { ...(edit.tags || {}), ...fixes } };
  const hasTagChange = Object.keys(finalEdit.tags).length || edit.custom || edit.lyrics || edit.comments || edit.cover !== undefined;
  let result = { method: 'none' };
  if (hasTagChange) result = await tags.write(abs, finalEdit);
  let rel = track.path;
  if (organize ?? lib.autoOrganize) {
    const fresh = { ...merged, ...fixes, nosplit: noSplit };
    const want = targetPath(fresh, lib);
    if (want !== track.path) rel = moveFile(profile, track.path, want);
  }
  const t = await rescanFile(profile, rel, { oldRel: track.path });
  touchService(profile);
  audit(userId, 'track.edit', { profile: profile.id, path: rel, from: track.path !== rel ? track.path : undefined, fields: Object.keys(finalEdit.tags) });
  return { track: t, method: result.method, moved: rel !== track.path ? { from: track.path, to: rel } : null };
}

/** Move to the app's trash (never deleted right away). */
// A file someone asked for is gone: read that library again soon (once per 10 minutes at most).
const staleScan = new Map();
export function staleFile(profileId) {
  const last = staleScan.get(profileId) || 0;
  if (Date.now() - last < 10 * 60_000) return;
  staleScan.set(profileId, Date.now());
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  if (p?.local_path && fs.existsSync(p.local_path)) setTimeout(() => scan(p), 2000);
}

export function trash(profile, track, userId) {
  const abs = absPath(profile, track.path);
  const dest = path.join(PATHS.trash, `${Date.now()}-${path.basename(abs)}`);
  if (!fs.existsSync(abs)) {
    // Already gone (moved or deleted outside the app): just forget it.
    db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);
    refreshRow(profile.id, track.id);
    staleFile(profile.id);
    return null;
  }
  try {
    fs.renameSync(abs, dest);
  } catch {
    fs.copyFileSync(abs, dest);
    fs.rmSync(abs);
  }
  fs.writeFileSync(`${dest}.json`, JSON.stringify({ profile: profile.id, path: track.path, at: now() }));
  db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);
  refreshRow(profile.id, track.id);
  removeEmptyDirs(profile, path.dirname(abs));
  touchService(profile);
  audit(userId, 'track.trash', { profile: profile.id, path: track.path });
  return dest;
}

// Songs taken out of Master Music Manager. The file stays exactly where it is
// (also for the music server); we just stop showing and touching it.
db.exec(`CREATE TABLE IF NOT EXISTS taken_out (
  profile_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT, artist TEXT, album TEXT, audio_hash TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, path)
)`);
export const takenOut = (profileId) => db.prepare('SELECT * FROM taken_out WHERE profile_id = ? ORDER BY at DESC').all(profileId);
const takenOutSet = (profileId) => new Set(db.prepare('SELECT path FROM taken_out WHERE profile_id = ?').all(profileId).map((r) => r.path));

/** Take a song out of Master Music Manager. Nothing happens to the file. */
export function takeOut(profile, track, userId) {
  const hash = db.prepare('SELECT audio_hash FROM tracks WHERE id = ?').get(track.id)?.audio_hash || null;
  db.prepare('INSERT OR REPLACE INTO taken_out (profile_id, path, title, artist, album, audio_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(profile.id, track.path, track.title || null, track.artist || null, track.album || null, hash, now());
  db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);
  refreshRow(profile.id, track.id);
  audit(userId, 'track.take-out', { profile: profile.id, path: track.path });
}

/** Back in: read the file again, as if it were new. */
export async function takeBackIn(profile, paths, userId) {
  const back = [];
  for (const rel of paths) {
    db.prepare('DELETE FROM taken_out WHERE profile_id = ? AND path = ?').run(profile.id, rel);
    if (fs.existsSync(absPath(profile, rel))) back.push(await rescanFile(profile, rel));
  }
  audit(userId, 'track.take-back', { profile: profile.id, count: paths.length });
  return back;
}

export function trashList() {
  return fs
    .readdirSync(PATHS.trash)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PATHS.trash, f), 'utf8'));
        const file = path.join(PATHS.trash, f.slice(0, -5));
        return { id: f.slice(0, -5), ...meta, size: fs.statSync(file).size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
}

export async function untrash(id, getProfile) {
  const file = path.join(PATHS.trash, path.basename(id));
  const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
  const profile = getProfile(meta.profile);
  if (!profile) throw new Error('The profile this came from is gone');
  let dest = absPath(profile, meta.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) dest = dest.replace(/(\.[^.]+)$/, ' (restored)$1');
  fs.renameSync(file, dest);
  fs.rmSync(`${file}.json`, { force: true });
  return rescanFile(profile, path.relative(profile.local_path, dest));
}

export function emptyTrash(olderThanDays = 0) {
  const cutoff = Date.now() - olderThanDays * 86400e3;
  let n = 0;
  for (const item of trashList()) {
    if (item.at > cutoff) continue;
    fs.rmSync(path.join(PATHS.trash, item.id), { force: true });
    fs.rmSync(path.join(PATHS.trash, `${item.id}.json`), { force: true });
    n++;
  }
  return n;
}

/** Copy a track ("Title (copy)") so it can be edited separately. */
export async function copyTrack(profile, track, userId) {
  const abs = absPath(profile, track.path);
  let dest = abs.replace(/(\.[^.]+)$/, ' (copy)$1');
  for (let i = 2; fs.existsSync(dest); i++) dest = abs.replace(/(\.[^.]+)$/, ` (copy ${i})$1`);
  fs.copyFileSync(abs, dest);
  const rel = path.relative(profile.local_path, dest);
  await tags.write(dest, { tags: { title: `${track.title || path.basename(abs, path.extname(abs))} (copy)` } });
  audit(userId, 'track.copy', { from: track.path, to: rel });
  touchService(profile);
  return rescanFile(profile, rel);
}

export function stats(profileId) {
  const list = all(profileId);
  const sum = (f) => list.reduce((a, t) => a + (t[f] || 0), 0);
  const count = (f) => new Set(list.map((t) => (Array.isArray(t[f]) ? t[f][0] : t[f])).filter(Boolean)).size;
  const formats = {};
  for (const t of list) formats[t.ext] = (formats[t.ext] || 0) + 1;
  return {
    tracks: list.length,
    size: sum('size'),
    duration: sum('duration'),
    artists: count('artist'),
    albums: new Set(list.map((t) => `${t.albumartist || t.artist}|${t.album}`).filter((k) => !k.endsWith('|undefined'))).size,
    genres: count('genre'),
    formats,
    noCover: list.filter((t) => !t.cover).length,
    noGenre: list.filter((t) => !t.genre?.length).length,
    noAlbum: list.filter((t) => !t.album).length,
    lossless: list.filter((t) => t.lossless).length,
    online: list.filter((t) => t.remoteId).length,
  };
}
