// The inbox: everything new (uploads, downloads, archives, other instances)
// lands here first, with metadata the user can check and edit. Importing
// converts it as the settings say, tags it, and files it into the library.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { PATHS } from './config.js';
import { db, now, audit } from './db.js';
import * as settings from './settings.js';
import * as jobs from './jobs.js';
import * as ff from './media/ffmpeg.js';
import * as tags from './library/tags.js';
import * as lib from './library/index.js';
import { targetPath, normalizeArtistTags, splitArtists, joinArtists } from './library/naming.js';
import { uuid } from './lib/crypto.js';
import { httpError, json, str, bool } from './lib/http.js';
import { requireUser } from './auth.js';
import { take } from './uploads.js';
import { getProfile, canUse } from './services/index.js';
import { safeFetch } from './lib/net.js';
import { log } from './lib/log.js';

const ARCHIVE = /\.(zip|rar|7z|tar|tgz|tbz2?|txz|tar\.(gz|bz2|xz|zst|lz4)|gz|bz2|xz|zst|iso|cab|lzh|arj|cpio|jar|apk)$/i;
const MEDIA = new Set([...lib.MEDIA_EXT, ...lib.VIDEO_EXT, 'mid', 'midi', 'amr', '3ga', 'au', 'ra', 'ac3', 'dts', 'm4r', 'weba', 'spx']);
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;

function itemDir(id) {
  const d = path.join(PATHS.inbox, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function publicItem(r) {
  const meta = JSON.parse(r.meta || '{}');
  const info = JSON.parse(r.info || '{}');
  return {
    id: r.id,
    jobId: r.job_id,
    source: r.source,
    sourceUrl: r.source_url,
    name: r.original_name,
    status: r.status,
    profileId: r.profile_id,
    duplicateOf: r.duplicate_of,
    meta: { ...meta, cover: meta.cover ? { format: meta.cover.format, from: meta.cover.from } : null },
    info,
    createdAt: r.created_at,
    size: fileSize(r.file),
  };
}
const fileSize = (f) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return null;
  }
};

/** Guess "Artist - Title" from a file name when there are no tags. */
export function guessFromName(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  base = base.replace(/\s*[[(](official\s*(music\s*)?(video|audio|lyric(s)?\s*video|visualizer)|lyrics?|hd|hq|4k|audio|mv|m\/v)[)\]]\s*/gi, ' ').trim();
  const num = base.match(/^(\d{1,3})[\s.\-_]+(.*)$/);
  let track;
  if (num) {
    track = Number(num[1]);
    base = num[2];
  }
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), track };
  return { title: base.trim(), track };
}

/** Read whatever we can about a media file and create an inbox entry. */
export async function ingest(file, { source, sourceUrl, name, jobId, profileId, meta: extra = {}, userId, ctx } = {}) {
  const id = uuid();
  const dir = itemDir(id);
  const dest = path.join(dir, `original${path.extname(name || file).toLowerCase() || ''}`);
  await fsp.rename(file, dest).catch(async () => {
    await fsp.copyFile(file, dest);
    await fsp.rm(file, { force: true });
  });
  let info;
  try {
    info = await ff.probe(dest);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`${name}: not a media file (${e.message.split('|')[0]})`);
  }
  if (!info.audio) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`${name}: no sound in this file`);
  }
  let read = { tags: {}, custom: {}, lyrics: [], hasCover: info.hasCover };
  try {
    read = await tags.read(dest, { covers: true });
  } catch {
    // Videos and odd containers: ffprobe's tags.
    const t = Object.fromEntries(Object.entries(info.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
    read.tags = { title: t.title, artist: t.artist || t.album_artist, album: t.album, albumartist: t.album_artist, genre: t.genre ? [t.genre] : undefined, year: Number.parseInt(t.date || t.year, 10) || undefined, comment: t.comment || t.description, track: Number.parseInt(t.track, 10) || undefined };
  }
  const guess = guessFromName(name || path.basename(file));
  const lc = settings.get('library');
  const m = Object.fromEntries(Object.entries({ ...guess, ...stripEmpty(read.tags), ...stripEmpty(extra) }).filter(([, v]) => v !== undefined && v !== ''));
  if (!m.title) m.title = guess.title;
  if (!m.album && m.albumFolder) m.album = m.albumFolder;
  if (!m.artist && m.artistFolder) m.artist = m.artistFolder;
  delete m.albumFolder;
  delete m.artistFolder;
  Object.assign(m, normalizeArtistTags(m, lc));
  if (!m.album && m.title) m.albumGuess = true;
  const plan = ff.plan(info, { ...settings.get('convert'), ext: path.extname(dest).slice(1) });
  const meta = { tags: m, custom: read.custom || {}, lyrics: read.lyrics || [], cover: null };
  if (extra.coverUrl) meta.coverUrl = extra.coverUrl;
  const dup = profileId ? findDuplicate(profileId, m, info.duration) : null;
  db.prepare('INSERT INTO inbox (id, job_id, source, source_url, file, original_name, meta, info, profile_id, status, duplicate_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    jobId || null,
    source,
    sourceUrl || null,
    dest,
    name || path.basename(file),
    JSON.stringify(meta),
    JSON.stringify({ ...info, plan, embeddedCover: Boolean(read.hasCover), video: Boolean(info.video) }),
    profileId || null,
    'pending',
    dup?.id ?? null,
    now(),
  );
  ctx?.log(`+ ${name}  →  ${m.artist || '?'} – ${m.title || '?'}${dup ? '  (maybe already in the library)' : ''}`);
  if (extra.coverUrl) fetchCover(id, extra.coverUrl).catch(() => {});
  // Names guessed from a video title or file name: look up the real details in the background.
  if (['youtube', 'ytmusic', 'search', 'web', 'upload', 'folder', 'archive', 'soundcloud', 'tiktok'].includes(source) && (!read.tags?.album || !read.tags?.artist)) {
    import('./lookup.js').then((l) => l.suggestFor(id)).catch(() => {});
  }
  return id;
}

const stripEmpty = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)));

function findDuplicate(profileId, m, duration) {
  const key = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const title = key(m.title);
  if (!title) return null;
  const artist = key(splitArtists(m.artist || '', settings.get('library'))[0]);
  return lib.all(profileId).find((t) => key(t.title) === title && (!artist || key(t.artist).includes(artist)) && (!duration || !t.duration || Math.abs(t.duration - duration) < 3)) || null;
}

async function fetchCover(id, url) {
  const r = await safeFetch(url, { maxBytes: 20 * 1024 * 1024 });
  setCover(id, r.body, r.type, 'url');
}

export function setCover(id, data, format, from = 'upload') {
  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'Not in the inbox');
  const ext = /png/.test(format) ? 'png' : /webp/.test(format) ? 'webp' : /gif/.test(format) ? 'gif' : 'jpg';
  const file = path.join(path.dirname(row.file), `cover.${ext}`);
  fs.writeFileSync(file, data);
  const meta = JSON.parse(row.meta);
  meta.cover = { file, format: format || `image/${ext}`, from };
  db.prepare('UPDATE inbox SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
}

// ---- archives ----
async function extract(archive, into, ctx) {
  fs.mkdirSync(into, { recursive: true });
  const tries = [
    ['bsdtar', ['-xf', archive, '-C', into]],
    ['7z', ['x', '-y', `-o${into}`, archive]],
    ['unzip', ['-o', '-q', archive, '-d', into]],
  ];
  for (const [bin, args] of tries) {
    try {
      await ctx.run(bin, args, { quiet: true });
      return true;
    } catch (e) {
      ctx.log(`  ${bin}: ${e.message.split('\n')[0]}`);
    }
  }
  // Plain .gz / .xz of a single file.
  if (/\.(gz|xz|bz2|zst)$/i.test(archive) && !/\.tar\./i.test(archive)) {
    const out = path.join(into, path.basename(archive).replace(/\.(gz|xz|bz2|zst)$/i, ''));
    const tool = { gz: 'gzip', xz: 'xz', bz2: 'bzip2', zst: 'zstd' }[archive.split('.').pop().toLowerCase()];
    try {
      await ctx.run('sh', ['-c', `${tool} -dc "$1" > "$2"`, 'sh', archive, out], { quiet: true });
      return true;
    } catch {}
  }
  return false;
}

/** Walk an extracted folder; extract nested archives too (4 levels). */
async function collect(dir, depth, ctx, found) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__MACOSX') continue;
      await collect(full, depth, ctx, found);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (ARCHIVE.test(e.name) && depth < 4) {
        ctx.log(`  nested archive: ${path.relative(found.root, full)}`);
        const sub = `${full}.d`;
        if (await extract(full, sub, ctx)) await collect(sub, depth + 1, ctx, found);
      } else if (MEDIA.has(ext)) found.media.push(full);
      else if (IMAGE.test(e.name)) found.images.push(full);
    }
  }
}

/** Handle a finished upload or download: one media file, or an archive full of them. */
export async function receive(file, { name, relativePath, source = 'upload', sourceUrl, profileId, userId, meta } = {}) {
  const label = relativePath || name;
  return jobs.start(
    'ingest',
    `Reading ${label}`,
    async (ctx) => {
      const ids = [];
      const errors = [];
      if (ARCHIVE.test(name)) {
        const work = path.join(PATHS.inbox, `x-${ctx.id}`);
        ctx.log(`Unpacking ${name}…`);
        if (!(await extract(file, work, ctx))) throw new Error('Could not unpack this archive (install bsdtar or 7z for more formats)');
        fs.rmSync(file, { force: true });
        const found = { root: work, media: [], images: [] };
        await collect(work, 0, ctx, found);
        ctx.log(`${found.media.length} media files, ${found.images.length} pictures`);
        let i = 0;
        for (const f of found.media) {
          ctx.check();
          const rel = path.relative(work, f);
          try {
            const id = await ingest(f, { source: 'archive', name: path.basename(f), jobId: ctx.id, profileId, userId, ctx, meta: albumHint(rel) });
            // A cover.jpg / folder.jpg next to the file becomes its cover.
            const pic = found.images.find((p) => path.dirname(p) === path.dirname(f) && /^(cover|folder|front|album)/i.test(path.basename(p))) || found.images.find((p) => path.dirname(p) === path.dirname(f));
            if (pic) setCover(id, fs.readFileSync(pic), `image/${path.extname(pic).slice(1).replace('jpg', 'jpeg')}`, 'archive');
            ids.push(id);
          } catch (e) {
            errors.push(e.message);
            ctx.log(`! ${e.message}`);
          }
          ctx.progress(++i / found.media.length, `${i} / ${found.media.length}`);
        }
        fs.rmSync(work, { recursive: true, force: true });
      } else {
        try {
          ids.push(await ingest(file, { source, sourceUrl, name, jobId: ctx.id, profileId, userId, ctx, meta: { ...albumHint(relativePath), ...(meta || {}) } }));
        } catch (e) {
          errors.push(e.message);
          throw e;
        }
      }
      return { items: ids, errors };
    },
    { userId },
  );
}

/** "Artist/Album/01 Song.flac" in a folder upload or archive says something about album and artist. */
function albumHint(rel) {
  if (!rel) return {};
  const parts = rel.split('/').filter(Boolean);
  if (parts.length < 2) return {};
  const folder = parts.at(-2).replace(/^\d{4}\s*[-–]\s*/, '');
  return { album: undefined, albumFolder: folder, artistFolder: parts.length > 2 ? parts.at(-3) : undefined };
}

// ---- importing ----
export function importItems(ids, { profileId, userId, overrides = {}, misc } = {}) {
  const profile = getProfile(profileId);
  if (!profile?.local_path) throw httpError(400, 'Pick a profile with a linked folder to import into');
  return jobs.start(
    'import',
    `Importing ${ids.length} ${ids.length === 1 ? 'file' : 'files'} into ${profile.name}`,
    async (ctx) => {
      const done = [];
      let i = 0;
      for (const id of ids) {
        ctx.check();
        const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
        if (!row || row.status === 'imported') continue;
        try {
          db.prepare("UPDATE inbox SET status = 'importing' WHERE id = ?").run(id);
          const t = await importOne(row, profile, { ...overrides[id], misc }, ctx, (p) => ctx.progress((i + p) / ids.length));
          db.prepare("UPDATE inbox SET status = 'imported' WHERE id = ?").run(id);
          fs.rmSync(path.dirname(row.file), { recursive: true, force: true });
          db.prepare('DELETE FROM inbox WHERE id = ?').run(id);
          done.push({ id, track: t?.id, path: t?.path });
        } catch (e) {
          db.prepare("UPDATE inbox SET status = 'failed', info = json_set(info, '$.error', ?) WHERE id = ?").run(e.message, id);
          ctx.log(`✗ ${row.original_name}: ${e.message}`);
        }
        ctx.progress(++i / ids.length, `${i} / ${ids.length}`);
      }
      lib.touchService(profile);
      audit(userId, 'inbox.import', { profile: profile.id, count: done.length });
      return { imported: done };
    },
    { userId },
  );
}

async function importOne(row, profile, override, ctx, onProgress) {
  const conv = settings.get('convert');
  const lc = settings.get('library');
  const meta = JSON.parse(row.meta);
  const info = JSON.parse(row.info);
  const t = { ...meta.tags, ...(override?.tags || {}) };
  delete t.albumGuess;
  delete t.albumFolder;
  delete t.artistFolder;
  const format = override?.format || conv.format;
  const plan = ff.plan(info, { ...conv, format, ext: path.extname(row.file).slice(1) });
  if (plan.action === 'reject') throw new Error(plan.reason);
  ctx.log(`▸ ${row.original_name}: ${plan.reason}`);
  const work = path.dirname(row.file);
  let out = row.file;
  if (plan.action === 'convert' || plan.action === 'remux') {
    out = path.join(work, `converted.${ff.FORMATS[plan.format].ext}`);
    await ff.convert(row.file, out, plan.format, { ...conv, info, remux: plan.action === 'remux', normalize: conv.normalize, onProgress: (p) => onProgress(p * 0.8) }, ctx);
  }
  // Cover: chosen picture > embedded > a frame of the video.
  let cover;
  if (meta.cover?.file && fs.existsSync(meta.cover.file)) cover = { data: fs.readFileSync(meta.cover.file), format: meta.cover.format };
  else if (!info.embeddedCover && info.video) {
    const still = await ff.stillFrame(row.file).catch(() => null);
    if (still) cover = { data: still, format: 'image/jpeg' };
  }
  const noSplit = override?.noSplit ?? meta.noSplit;
  const fixes = normalizeArtistTags(t, lc, { noSplit });
  Object.assign(t, fixes);
  if (!t.album && t.title) t.album = t.title; // singles: album = title
  const edit = { tags: t, custom: meta.custom, lyrics: meta.lyrics?.length ? meta.lyrics : undefined, cover };
  if (!edit.lyrics) delete edit.lyrics;
  await tags.write(out, edit);
  // Where it goes.
  const unknown = !t.title && !t.artist;
  const useMisc = unknown && (override?.misc ?? lc.misc.enabled);
  const ext = path.extname(out).slice(1).toLowerCase();
  let rel = targetPath({ ...t, ext, filename: row.original_name, nosplit: noSplit }, lc, { misc: useMisc });
  let dest = lib.absPath(profile, rel);
  if (fs.existsSync(dest)) {
    const same = (await lib.hashFile(dest)) === (await lib.hashFile(out));
    if (same) {
      ctx.log(`  identical file already at ${rel}, skipped`);
      return lib.all(profile.id).find((x) => x.path === rel);
    }
    for (let n = 2; fs.existsSync(dest); n++) {
      rel = rel.replace(/( \(\d+\))?(\.[^.]+)$/, ` (${n})$2`);
      dest = lib.absPath(profile, rel);
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await fsp.copyFile(out, dest);
  ctx.log(`  → ${rel}`);
  // Originals.
  if (out !== row.file && conv.keepOriginal === 'folder') {
    const orig = lib.absPath(profile, path.join(conv.originalsFolder || '.originals', rel.replace(/\.[^.]+$/, path.extname(row.file))));
    fs.mkdirSync(path.dirname(orig), { recursive: true });
    await fsp.copyFile(row.file, orig);
    ctx.log(`  original kept at ${path.relative(profile.local_path, orig)}`);
  } else if (out !== row.file && conv.keepOriginal === 'inbox') {
    const keep = path.join(PATHS.inbox, 'originals', rel.replace(/\.[^.]+$/, path.extname(row.file)));
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    await fsp.copyFile(row.file, keep);
  }
  // Animated cover from music videos.
  if (info.video && conv.animatedCovers && (override?.animated ?? true)) {
    try {
      const canvasDir = path.join(path.dirname(dest), '.canvas', path.basename(dest).replace(/\.[^.]+$/, ''));
      const r = await ff.animatedCover(row.file, canvasDir, { seconds: conv.canvasSeconds || 8, start: override?.canvasStart, ctx });
      if (r) ctx.log(`  animated cover made (${r.length.toFixed(1)} s from ${r.from.toFixed(1)} s)`);
    } catch (e) {
      ctx.log(`  no animated cover: ${e.message.split('|')[0]}`);
    }
  }
  onProgress(1);
  const track = await lib.rescanFile(profile, rel);
  if (noSplit) db.prepare('UPDATE tracks SET no_split = 1 WHERE id = ?').run(track.id);
  return track;
}

export function register(app) {
  app.post(
    '/api/uploads/:id/finish',
    requireUser,
    json((req) => {
      const u = take(req.params.id, req.user.id);
      const profileId = str(req.body.profileId, 64) || null;
      return { job: receive(u.file, { name: u.name, relativePath: u.relativePath, profileId, userId: req.user.id }) };
    }),
  );

  app.get(
    '/api/inbox',
    requireUser,
    json(() => db.prepare('SELECT * FROM inbox ORDER BY created_at DESC LIMIT 2000').all().map(publicItem)),
  );

  app.patch(
    '/api/inbox/:id',
    requireUser,
    json((req) => {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
      if (!row) throw httpError(404, 'Not in the inbox');
      const meta = JSON.parse(row.meta);
      if (req.body.tags) meta.tags = { ...meta.tags, ...req.body.tags };
      if (req.body.custom) meta.custom = { ...meta.custom, ...req.body.custom };
      if (req.body.lyrics) meta.lyrics = req.body.lyrics;
      if (req.body.noSplit !== undefined) meta.noSplit = bool(req.body.noSplit);
      db.prepare('UPDATE inbox SET meta = ?, profile_id = COALESCE(?, profile_id) WHERE id = ?').run(JSON.stringify(meta), req.body.profileId || null, row.id);
      return publicItem(db.prepare('SELECT * FROM inbox WHERE id = ?').get(row.id));
    }),
  );

  // Same edit for many inbox items at once.
  app.post(
    '/api/inbox/bulk',
    requireUser,
    json((req) => {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      for (const id of ids) {
        const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
        if (!row) continue;
        const meta = JSON.parse(row.meta);
        meta.tags = { ...meta.tags, ...(req.body.tags || {}) };
        db.prepare('UPDATE inbox SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
      }
      return { ok: true, count: ids.length };
    }),
  );

  app.put(
    '/api/inbox/:id/cover',
    requireUser,
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' }),
    json(async (req) => {
      if (Buffer.isBuffer(req.body) && req.body.length) setCover(req.params.id, req.body, req.get('content-type'));
      else if (req.query.url) await fetchCover(req.params.id, String(req.query.url));
      else if (req.query.frame !== undefined) {
        const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
        const still = await ff.stillFrame(row.file, { at: Number(req.query.frame) || undefined });
        if (!still) throw httpError(400, 'No picture in this file');
        setCover(req.params.id, still, 'image/jpeg', 'video');
      } else throw httpError(400, 'Send an image, ?url= or ?frame=');
      return { ok: true };
    }),
  );

  app.get('/api/inbox/:id/cover', requireUser, async (req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).end();
      const meta = JSON.parse(row.meta);
      if (meta.cover?.file && fs.existsSync(meta.cover.file)) return res.sendFile(meta.cover.file);
      const c = await tags.readCover(row.file).catch(() => null);
      if (c) return res.type(c.format).send(c.data);
      const still = JSON.parse(row.info).video ? await ff.stillFrame(row.file).catch(() => null) : null;
      if (still) return res.type('image/jpeg').send(still);
      res.status(404).end();
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/inbox/:id/file', requireUser, (req, res) => {
    const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).end();
    res.sendFile(row.file, { acceptRanges: true });
  });

  app.post(
    '/api/inbox/import',
    requireUser,
    json((req) => {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : db.prepare("SELECT id FROM inbox WHERE status IN ('pending','failed')").all().map((r) => r.id);
      if (!ids.length) throw httpError(400, 'Nothing to import');
      const p = getProfile(req.body.profileId);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      // Remember the !Misc answer the first time the user gives it.
      if (req.body.misc !== undefined && settings.get('library').misc.enabled === null) settings.set('library', { misc: { ...settings.get('library').misc, enabled: bool(req.body.misc) } });
      return { job: importItems(ids, { profileId: p.id, userId: req.user.id, overrides: req.body.overrides || {}, misc: req.body.misc === undefined ? undefined : bool(req.body.misc) }) };
    }),
  );

  app.delete(
    '/api/inbox/:id',
    requireUser,
    json((req) => {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
      if (row) fs.rmSync(path.dirname(row.file), { recursive: true, force: true });
      db.prepare('DELETE FROM inbox WHERE id = ?').run(req.params.id);
      return { ok: true };
    }),
  );
  app.post(
    '/api/inbox/clear',
    requireUser,
    json((req) => {
      const rows = Array.isArray(req.body.ids) ? req.body.ids.map((id) => db.prepare('SELECT * FROM inbox WHERE id = ?').get(id)).filter(Boolean) : db.prepare('SELECT * FROM inbox').all();
      for (const r of rows) {
        fs.rmSync(path.dirname(r.file), { recursive: true, force: true });
        db.prepare('DELETE FROM inbox WHERE id = ?').run(r.id);
      }
      return { removed: rows.length };
    }),
  );

  // Import from a direct link (a file or an archive on the web).
  app.post(
    '/api/inbox/from-url',
    requireUser,
    json(async (req) => {
      if (!settings.online()) throw httpError(403, 'Privacy mode is on: downloads from the internet are off');
      const url = str(req.body.url, 2000);
      const r = await safeFetch(url, { maxBytes: 2 * 1024 ** 3, timeout: 600_000 });
      const tmp = path.join(PATHS.uploads, uuid());
      fs.writeFileSync(tmp, r.body);
      return { job: receive(tmp, { name: r.name, source: 'url', sourceUrl: url, profileId: req.body.profileId, userId: req.user.id }) };
    }),
  );
  log.info('inbox ready');
}
