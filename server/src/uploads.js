// Resumable uploads. Files up to 50 MB go in one request; bigger ones in
// 32 MB parts (Cloudflare refuses bodies over 100 MB and cuts requests after
// 100 s, so parts stay well below both). A broken part is cut back to the last
// confirmed offset and the browser resumes from `received`.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { uuid } from './lib/crypto.js';
import { httpError, json, str } from './lib/http.js';
import { requireUser } from './auth.js';

export const CHUNK = 32 * 1024 * 1024;
export const SINGLE_LIMIT = 50 * 1024 * 1024;
const MAX_SIZE = Number(process.env.MMM_MAX_UPLOAD_GB || 20) * 1024 ** 3;
const uploads = new Map(); // id -> { file, size, received, name, relativePath, userId, at }

setInterval(() => {
  for (const [id, u] of uploads) {
    if (Date.now() - u.at > 6 * 3600_000) {
      fs.rmSync(u.file, { force: true });
      uploads.delete(id);
    }
  }
}, 600_000).unref();

/** The finished upload for `id`, handed to whoever asked for it. */
export function take(id, userId) {
  const u = uploads.get(id);
  if (!u || u.userId !== userId) throw httpError(404, 'Upload not found (it may have expired)');
  if (u.received !== u.size) throw httpError(409, `Upload incomplete (${u.received} of ${u.size} bytes)`);
  uploads.delete(id);
  return u;
}

export function register(app) {
  app.post(
    '/api/uploads',
    requireUser,
    json((req) => {
      const size = Number(req.body.size);
      if (!Number.isFinite(size) || size < 0) throw httpError(400, 'Missing file size');
      if (size > MAX_SIZE) throw httpError(413, `Files over ${MAX_SIZE / 1024 ** 3} GB are refused (MMM_MAX_UPLOAD_GB)`);
      const free = freeSpace(PATHS.uploads);
      if (free != null && free < size * 1.1) throw httpError(507, 'Not enough free disk space for this upload');
      const id = uuid();
      const file = path.join(PATHS.uploads, id);
      fs.writeFileSync(file, '');
      uploads.set(id, {
        id,
        file,
        size,
        received: 0,
        name: path.basename(str(req.body.name, 500) || 'upload'),
        relativePath: str(req.body.relativePath, 2000).replace(/\\/g, '/').replace(/^\/+/, '').replace(/(^|\/)\.\.(\/|$)/g, '$1'),
        userId: req.user.id,
        at: Date.now(),
      });
      const chunkSize = size > SINGLE_LIMIT ? CHUNK : SINGLE_LIMIT;
      uploads.get(id).chunkSize = chunkSize;
      return { id, chunkSize };
    }),
  );

  app.put('/api/uploads/:id', requireUser, (req, res, next) => {
    const u = uploads.get(req.params.id);
    if (!u || u.userId !== req.user.id) return next(httpError(404, 'Upload not found'));
    const offset = Number(req.query.offset || 0);
    if (offset !== u.received) return res.status(409).json({ error: 'Wrong offset', received: u.received });
    const out = fs.createWriteStream(u.file, { flags: 'r+', start: offset });
    let got = 0;
    let failed = false;
    req.on('data', (c) => {
      got += c.length;
      if (got > u.chunkSize + 1024 || offset + got > u.size) {
        failed = true;
        req.destroy();
      }
    });
    req.pipe(out);
    const fail = () => {
      out.destroy();
      try {
        fs.truncateSync(u.file, u.received);
      } catch {}
    };
    req.on('aborted', fail);
    out.on('error', (e) => {
      fail();
      next(e);
    });
    out.on('finish', () => {
      if (failed) {
        fail();
        return res.status(413).json({ error: 'Part too large', received: u.received });
      }
      u.received = offset + got;
      u.at = Date.now();
      res.json({ received: u.received, done: u.received === u.size });
    });
  });

  app.get(
    '/api/uploads/:id',
    requireUser,
    json((req) => {
      const u = uploads.get(req.params.id);
      if (!u || u.userId !== req.user.id) throw httpError(404, 'Upload not found');
      return { received: u.received, size: u.size };
    }),
  );

  app.delete(
    '/api/uploads/:id',
    requireUser,
    json((req) => {
      const u = uploads.get(req.params.id);
      if (u && u.userId === req.user.id) {
        fs.rmSync(u.file, { force: true });
        uploads.delete(req.params.id);
      }
      return { ok: true };
    }),
  );
}

export function freeSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
