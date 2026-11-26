import fs from 'node:fs';
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PATHS } from '../config.js';
import * as lib from '../library/index.js';
import * as dupes from '../library/duplicates.js';
import * as exporter from '../library/export.js';
import * as ff from '../media/ffmpeg.js';
import * as jobs from '../jobs.js';
import { profileOf, selection } from '../library/routes.js';
import { requireUser, requireAdmin } from '../auth.js';
import { httpError, json, str, bool } from '../lib/http.js';
import { token, sha256, uuid } from '../lib/crypto.js';
import { audit } from '../db.js';
import { ingest, receive } from '../inbox.js';
import { hasBinary } from '../media/ffmpeg.js';

const prepared = new Map(); // download token -> { profileId, ids, opts, userId, at }
setInterval(() => {
  for (const [k, v] of prepared) if (Date.now() - v.at > 15 * 60_000) prepared.delete(k);
}, 60_000).unref();

export function register(app) {
  // Same-origin copy of a picture on the web, so the image editor can work on it.
  app.get('/api/fetch-image', requireUser, async (req, res, next) => {
    try {
      const { online } = await import('../settings.js');
      if (!online('coverSearch')) throw httpError(403, 'Privacy mode is on: loading pictures from the internet is off');
      const { safeFetch } = await import('../lib/net.js');
      const r = await safeFetch(str(req.query.url, 2000), { maxBytes: 25 * 1024 * 1024 });
      if (!/^image\//.test(r.type || '')) throw httpError(400, 'That address is not a picture');
      res.type(r.type).send(r.body);
    } catch (e) {
      next(e);
    }
  });

  // Edit an animated GIF / WebP frame by frame (crop, rotate, flip, colours, size).
  app.post(
    '/api/image/animated-edit',
    requireUser,
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '40mb' }),
    async (req, res, next) => {
      const tmpIn = path.join(PATHS.cache, `anim-in-${uuid()}`);
      const fmt = req.query.format === 'webp' ? 'webp' : 'gif';
      const tmpOut = path.join(PATHS.cache, `anim-out-${uuid()}.${fmt}`);
      try {
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'Send the picture');
        fs.writeFileSync(tmpIn, req.body);
        const q = req.query;
        const n = (k, d) => (Number.isFinite(Number(q[k])) ? Number(q[k]) : d);
        const f = [];
        const rot = ((n('rot', 0) % 360) + 360) % 360;
        if (rot === 90) f.push('transpose=1');
        if (rot === 180) f.push('transpose=1', 'transpose=1');
        if (rot === 270) f.push('transpose=2');
        if (q.flipH === '1') f.push('hflip');
        if (q.flipV === '1') f.push('vflip');
        if (q.w && q.h) f.push(`crop=${Math.round(n('w', 0))}:${Math.round(n('h', 0))}:${Math.round(n('x', 0))}:${Math.round(n('y', 0))}`);
        const b = n('brightness', 100);
        const c = n('contrast', 100);
        const sat = n('saturate', 100);
        if (b !== 100 || c !== 100 || sat !== 100) f.push(`eq=brightness=${((b - 100) / 200).toFixed(3)}:contrast=${(c / 100).toFixed(3)}:saturation=${(sat / 100).toFixed(3)}`);
        if (n('blur', 0) > 0) f.push(`gblur=sigma=${Math.min(20, n('blur', 0))}`);
        const size = Math.min(2000, n('size', 800));
        f.push(`scale='min(${size},iw)':-2:flags=lanczos`);
        const chain = f.join(',');
        const args = fmt === 'gif'
          ? ['-y', '-v', 'error', '-i', tmpIn, '-filter_complex', `[0:v]${chain},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', tmpOut]
          : ['-y', '-v', 'error', '-i', tmpIn, '-vf', chain, '-c:v', 'libwebp', '-loop', '0', '-quality', String(Math.round(n('quality', 0.85) * 100)), '-compression_level', '5', tmpOut];
        await ff.run('ffmpeg', args);
        res.type(fmt === 'gif' ? 'image/gif' : 'image/webp').send(fs.readFileSync(tmpOut));
      } catch (e) {
        next(e.status ? e : httpError(400, `Could not edit the animation: ${e.message.split('|')[0]}`));
      } finally {
        fs.rmSync(tmpIn, { force: true });
        fs.rmSync(tmpOut, { force: true });
      }
    },
  );

  // ---- duplicates ----
  app.post('/api/p/:pid/duplicates/scan', requireUser, json((req) => ({ job: dupes.scanJob(profileOf(req), { autoMerge: req.body.autoMerge === undefined ? undefined : bool(req.body.autoMerge), userId: req.user.id }) })));
  app.get('/api/p/:pid/duplicates', requireUser, json((req) => dupes.find(profileOf(req).id, { includeLikely: req.query.likely !== '0' })));

  // Merge any songs (from the duplicates view or a manual selection).
  app.post(
    '/api/p/:pid/merge',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const keep = Number(req.body.keep);
      const remove = (req.body.remove || []).map(Number).filter((id) => id !== keep);
      const k = lib.byId(p.id, keep);
      if (!k || !remove.length) throw httpError(400, 'Pick the copy to keep and at least one to remove');
      const checks = remove.map((id) => {
        const o = lib.byId(p.id, id);
        return o ? { id, title: o.title, ...dupes.similarity(k, o) } : null;
      }).filter(Boolean);
      const lowest = Math.min(...checks.map((c) => c.score));
      if (lowest < 75 && !bool(req.body.confirm)) {
        throw httpError(409, `These may not be the same song (${lowest}% sure). Check the differences and confirm.`, { needsConfirm: true, checks });
      }
      return dupes.merge(p, { keep, remove, fillTags: req.body.fillTags !== false, userId: req.user.id });
    }),
  );
  app.post(
    '/api/p/:pid/compare',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      const [a, b] = (req.body.ids || []).map((id) => lib.byId(p.id, id));
      if (!a || !b) throw httpError(400, 'Pick two songs');
      return dupes.similarity(a, b);
    }),
  );

  // ---- exports ----
  app.get('/api/export/formats', requireUser, json(async () => ({ lists: exporter.LIST_FORMATS, presets: exporter.PRESETS, archives: Object.fromEntries(await Promise.all(Object.entries(exporter.ARCHIVE_FORMATS).map(async ([k, v]) => [k, { ...v, available: v.needs ? await hasBinary(v.needs) : true }]))) })));

  app.post(
    '/api/p/:pid/export/list',
    requireUser,
    json((req, res) => {
      const p = profileOf(req);
      const tracks = req.body.ids || req.body.query !== undefined ? selection(p, req.body) : lib.all(p.id);
      const format = str(req.body.format, 20) || 'template';
      const text = exporter.list(tracks, { format, template: str(req.body.template, 2000) || '{artist} - {title}', preset: req.body.preset, fields: req.body.fields, header: req.body.header !== false, profile: p, title: str(req.body.title, 120) || p.name });
      if (bool(req.body.inline)) return { text, count: tracks.length };
      const f = exporter.LIST_FORMATS[format];
      res.attachment(`${(str(req.body.title, 120) || 'music').replace(/[^\w .-]+/g, '_')}.${f.ext}`).type(f.mime).send(text);
    }),
  );

  app.post(
    '/api/p/:pid/export/archive',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      const tracks = req.body.ids || req.body.query !== undefined ? selection(p, req.body) : lib.all(p.id);
      const t = token(18);
      prepared.set(t, { profileId: p.id, ids: tracks.map((x) => x.id), opts: req.body, userId: req.user.id, at: Date.now() });
      const size = tracks.reduce((a, x) => a + (x.size || 0), 0);
      return { url: `/api/export/${t}`, count: tracks.length, size };
    }),
  );
  app.get('/api/export/:token', requireUser, async (req, res, next) => {
    const job = prepared.get(req.params.token);
    if (!job || job.userId !== req.user.id) return next(httpError(404, 'This download expired. Start it again.'));
    prepared.delete(req.params.token);
    try {
      req.params.pid = job.profileId;
      const p = profileOf(req);
      const tracks = job.ids.map((id) => lib.byId(p.id, id)).filter(Boolean);
      audit(req.user.id, 'export.archive', { count: tracks.length, format: job.opts.format });
      await exporter.archive(res, p, tracks, { format: job.opts.format, layout: job.opts.layout, template: job.opts.template, includeList: job.opts.includeList !== false, name: job.opts.name || p.name });
    } catch (e) {
      if (!res.headersSent) next(e);
      else res.destroy();
    }
  });

  // ---- audio editor ----
  app.get('/api/editor/ops', requireUser, json(() => ff.EDIT_OPS));
  app.get(
    '/api/p/:pid/tracks/:id/waveform',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = lib.byId(p.id, req.params.id);
      if (!t) throw httpError(404, 'Track not found');
      return ff.waveform(lib.absPath(p, t.path), Math.min(4000, Number(req.query.buckets) || 1200));
    }),
  );
  app.post(
    '/api/p/:pid/tracks/:id/edit/preview',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = lib.byId(p.id, req.params.id);
      if (!t) throw httpError(404, 'Track not found');
      const key = sha256(JSON.stringify([t.path, t.mtime, req.body.ops]));
      const out = path.join(PATHS.cache, `preview-${key}.mp3`);
      if (!fs.existsSync(out)) await ff.renderEdit(lib.absPath(p, t.path), out, req.body.ops || [], { preview: true });
      const wave = await ff.waveform(out, 1200);
      return { url: `/api/editor/preview/${key}`, waveform: wave };
    }),
  );
  app.get('/api/editor/preview/:key', requireUser, (req, res) => {
    const f = path.join(PATHS.cache, `preview-${req.params.key.replace(/[^a-f0-9]/g, '')}.mp3`);
    if (!fs.existsSync(f)) return res.status(404).end();
    res.sendFile(f, { acceptRanges: true });
  });
  app.post(
    '/api/p/:pid/tracks/:id/edit/apply',
    requireUser,
    json((req) => {
      const p = profileOf(req);
      const t = lib.byId(p.id, req.params.id);
      if (!t) throw httpError(404, 'Track not found');
      const ops = req.body.ops || [];
      if (!ops.length) throw httpError(400, 'No changes to apply');
      const asCopy = req.body.mode === 'copy';
      return {
        job: jobs.start(
          'edit',
          `${asCopy ? 'New version of' : 'Editing'} ${t.title || t.filename}`,
          async (ctx) => {
            const abs = lib.absPath(p, t.path);
            const tmp = path.join(PATHS.cache, `edit-${uuid()}${path.extname(abs)}`);
            ctx.log(`Operations: ${ops.map((o) => o.type).join(' → ')}`);
            await ff.renderEdit(abs, tmp, ops, { ctx });
            if (asCopy) {
              const suffix = str(req.body.suffix, 60) || 'edit';
              let dest = abs.replace(/(\.[^.]+)$/, ` (${suffix})$1`);
              for (let i = 2; fs.existsSync(dest); i++) dest = abs.replace(/(\.[^.]+)$/, ` (${suffix} ${i})$1`);
              fs.renameSync(tmp, dest);
              const rel = path.relative(p.local_path, dest);
              const { write } = await import('../library/tags.js');
              await write(dest, { tags: { title: `${t.title || path.basename(abs, path.extname(abs))} (${suffix})` } });
              const nt = await lib.rescanFile(p, rel);
              ctx.log(`Saved as ${rel}`);
              lib.touchService(p);
              return { track: nt.id };
            }
            lib.createRestorePoint(p, t, `Before audio edit (${ops.map((o) => o.type).join(', ')})`);
            await fsp.copyFile(tmp, abs);
            fs.rmSync(tmp, { force: true });
            const nt = await lib.rescanFile(p, t.path);
            lib.touchService(p);
            audit(req.user.id, 'audio.edit', { path: t.path, ops: ops.map((o) => o.type) });
            return { track: nt.id };
          },
          { userId: req.user.id },
        ),
      };
    }),
  );

  // ---- server folder browser (admins pick library folders with it) ----
  app.get(
    '/api/fs',
    requireAdmin,
    json(async (req) => {
      const dir = path.resolve(str(req.query.path, 2000) || os.homedir());
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        throw httpError(400, `Can't open ${dir}: ${e.code}`);
      }
      const dirs = [];
      let media = 0;
      for (const e of entries) {
        if (e.isDirectory() && (bool(req.query.hidden) || !e.name.startsWith('.'))) dirs.push(e.name);
        else if (e.isFile() && lib.MEDIA_EXT.has(path.extname(e.name).slice(1).toLowerCase())) media++;
      }
      dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs: dirs.slice(0, 2000), media, places: ['/', os.homedir(), '/mnt', '/media', '/srv', '/data'].filter((x) => fs.existsSync(x)) };
    }),
  );

  // ---- import from a folder on this machine ----
  app.post(
    '/api/inbox/from-path',
    requireAdmin,
    json((req) => {
      const src = path.resolve(str(req.body.path, 2000));
      if (!fs.existsSync(src)) throw httpError(400, `${src} does not exist`);
      const move = bool(req.body.move);
      const profileId = str(req.body.profileId, 64) || null;
      return {
        job: jobs.start(
          'ingest',
          `Reading ${src}`,
          async (ctx) => {
            const files = [];
            const walk = async (d) => {
              for (const e of await fsp.readdir(d, { withFileTypes: true })) {
                const full = path.join(d, e.name);
                if (e.isDirectory() && !e.name.startsWith('.')) await walk(full);
                else if (e.isFile()) files.push(full);
              }
            };
            if (fs.statSync(src).isDirectory()) await walk(src);
            else files.push(src);
            ctx.log(`${files.length} files in ${src}`);
            let i = 0;
            let added = 0;
            for (const f of files) {
              ctx.check();
              const ext = path.extname(f).slice(1).toLowerCase();
              const rel = path.relative(fs.statSync(src).isDirectory() ? src : path.dirname(src), f);
              const isMedia = lib.MEDIA_EXT.has(ext) || lib.VIDEO_EXT.has(ext);
              const isArchive = /\.(zip|rar|7z|tar|tgz|gz|xz|bz2)$/i.test(f);
              if (isMedia || isArchive) {
                const tmp = path.join(PATHS.uploads, uuid());
                await (move ? fsp.rename(f, tmp).catch(() => fsp.copyFile(f, tmp).then(() => fsp.rm(f))) : fsp.copyFile(f, tmp));
                try {
                  if (isArchive) {
                    const j = receive(tmp, { name: path.basename(f), relativePath: rel, profileId, userId: req.user.id });
                    await jobs.wait(j);
                  } else {
                    const parts = rel.split(path.sep);
                    await ingest(tmp, { source: 'folder', name: path.basename(f), jobId: ctx.id, profileId, userId: req.user.id, ctx, meta: parts.length > 1 ? { albumFolder: parts.at(-2), artistFolder: parts.length > 2 ? parts.at(-3) : undefined } : {} });
                  }
                  added++;
                } catch (e) {
                  ctx.log(`! ${rel}: ${e.message}`);
                }
              }
              ctx.progress(++i / files.length, `${i} / ${files.length}`);
            }
            return { added };
          },
          { userId: req.user.id },
        ),
      };
    }),
  );
}
