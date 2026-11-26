// WebDAV access to the linked library folders, e.g. to mount them in a file
// manager, Windows Explorer or Finder. Login: your username + an app
// password made under Settings → Account (read-only or read/write). Deleting
// moves files to the app's trash; any change rescans the file and pokes the
// music service.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db, now, audit } from './db.js';
import { hashPassword, verifyPassword, token, uuid } from './lib/crypto.js';
import { httpError, json, str, limiter } from './lib/http.js';
import { requireUser } from './auth.js';
import { visibleProfiles } from './services/index.js';
import * as lib from './library/index.js';
import { PATHS } from './config.js';

const tries = limiter({ windowMs: 10 * 60_000, max: 40 });
const authCache = new Map(); // header -> { user, scopes, at }
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const slug = (s) => String(s).replace(/[/\\]/g, '-');

async function authenticate(req) {
  const h = req.get('authorization') || '';
  const cached = authCache.get(h);
  if (cached && Date.now() - cached.at < 60_000) return cached;
  const m = h.match(/^Basic (.+)$/);
  if (!m) return null;
  const [username, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  const password = rest.join(':');
  if (!tries(req.ip)) throw httpError(429, 'Too many attempts');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  for (const ap of db.prepare('SELECT * FROM app_passwords WHERE user_id = ?').all(user.id)) {
    if (await verifyPassword(password, ap.hash)) {
      db.prepare('UPDATE app_passwords SET last_used = ? WHERE id = ?').run(now(), ap.id);
      const r = { user: { id: user.id, username: user.username, role: user.role }, scopes: JSON.parse(ap.scopes), at: Date.now() };
      authCache.set(h, r);
      return r;
    }
  }
  return null;
}

/** "/dav/<profile>/<rest>" → { profile, abs, rel } */
function resolve(user, urlPath) {
  const parts = decodeURIComponent(urlPath).replace(/^\/dav\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return { root: true };
  const profiles = visibleProfiles(user).filter((p) => p.local_path);
  const p = profiles.find((x) => slug(x.name) === parts[0]);
  if (!p) return { missing: true };
  const rel = parts.slice(1).join('/');
  const abs = path.resolve(p.local_path, rel);
  if (abs !== p.local_path && !abs.startsWith(`${p.local_path}/`)) throw httpError(403, 'Outside the library');
  return { profile: p, abs, rel, profiles };
}

function propEntry(href, st, name) {
  const isDir = st.isDirectory();
  return `<d:response><d:href>${xml(encodeURI(href))}</d:href><d:propstat><d:prop><d:displayname>${xml(name)}</d:displayname><d:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</d:getlastmodified><d:creationdate>${new Date(st.birthtimeMs || st.mtimeMs).toISOString()}</d:creationdate>${isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${st.size}</d:getcontentlength><d:getcontenttype>${mime(name)}</d:getcontenttype><d:getetag>"${st.size}-${Math.round(st.mtimeMs)}"</d:getetag>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}
const mime = (n) => ({ mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', lrc: 'text/plain', nsp: 'application/json', mp4: 'video/mp4' })[path.extname(n).slice(1).toLowerCase()] || 'application/octet-stream';

async function afterChange(p, abs) {
  const rel = path.relative(p.local_path, abs);
  if (lib.MEDIA_EXT.has(path.extname(abs).slice(1).toLowerCase())) {
    try {
      await lib.rescanFile(p, rel);
    } catch {}
  }
  lib.touchService(p);
}

export function mount(app) {
  app.use('/dav', async (req, res, next) => {
    try {
      res.set('DAV', '1, 2');
      res.set('MS-Author-Via', 'DAV');
      if (req.method === 'OPTIONS') return res.set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK').status(200).end();
      const a = await authenticate(req);
      if (!a) return res.set('WWW-Authenticate', 'Basic realm="Master Music Manager", charset="UTF-8"').status(401).end();
      const write = !['GET', 'HEAD', 'PROPFIND'].includes(req.method);
      if (write && !a.scopes.includes('webdav:write')) return res.status(403).send('This app password is read-only');
      if (!a.scopes.some((s) => s.startsWith('webdav'))) return res.status(403).end();
      const target = resolve(a.user, req.originalUrl.split('?')[0]);
      if (target.missing) return res.status(404).end();

      if (req.method === 'PROPFIND') {
        const depth = req.get('depth') ?? '1';
        let body = '';
        if (target.root) {
          body += `<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:displayname>Libraries</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
          if (depth !== '0') for (const p of visibleProfiles(a.user).filter((x) => x.local_path)) body += propEntry(`/dav/${slug(p.name)}/`, fs.statSync(p.local_path), p.name);
        } else {
          let st;
          try {
            st = await fsp.stat(target.abs);
          } catch {
            return res.status(404).end();
          }
          const base = `/dav/${slug(target.profile.name)}/${target.rel}`.replace(/\/+$/, '');
          body += propEntry(st.isDirectory() ? `${base}/` : base, st, path.basename(target.abs) || target.profile.name);
          if (st.isDirectory() && depth !== '0') {
            for (const e of await fsp.readdir(target.abs, { withFileTypes: true })) {
              if (e.name.startsWith('.mmm')) continue;
              try {
                const s = await fsp.stat(path.join(target.abs, e.name));
                body += propEntry(`${base}/${e.name}${s.isDirectory() ? '/' : ''}`, s, e.name);
              } catch {}
            }
          }
        }
        return res.status(207).type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`);
      }
      if (target.root) return req.method === 'GET' ? res.type('text').send('Master Music Manager WebDAV. Mount this address in your file manager.') : res.status(405).end();

      switch (req.method) {
        case 'GET':
        case 'HEAD': {
          const st = await fsp.stat(target.abs).catch(() => null);
          if (!st) return res.status(404).end();
          if (st.isDirectory()) return res.type('text').send(fs.readdirSync(target.abs).join('\n'));
          return res.sendFile(target.abs, { acceptRanges: true, dotfiles: 'allow' });
        }
        case 'PUT': {
          fs.mkdirSync(path.dirname(target.abs), { recursive: true });
          const tmp = path.join(path.dirname(target.abs), `.mmm-upload-${uuid()}`);
          const existed = fs.existsSync(target.abs);
          await pipeline(req, fs.createWriteStream(tmp));
          await fsp.rename(tmp, target.abs);
          audit(a.user.id, 'webdav.put', { path: target.rel });
          afterChange(target.profile, target.abs);
          return res.status(existed ? 204 : 201).end();
        }
        case 'DELETE': {
          const st = await fsp.stat(target.abs).catch(() => null);
          if (!st) return res.status(404).end();
          const dest = path.join(PATHS.trash, `${Date.now()}-dav-${path.basename(target.abs)}`);
          await fsp.rename(target.abs, dest).catch(async () => {
            await fsp.cp(target.abs, dest, { recursive: true });
            await fsp.rm(target.abs, { recursive: true });
          });
          fs.writeFileSync(`${dest}.json`, JSON.stringify({ profile: target.profile.id, path: target.rel, at: now(), via: 'webdav' }));
          db.prepare('DELETE FROM tracks WHERE profile_id = ? AND (path = ? OR path LIKE ?)').run(target.profile.id, target.rel, `${target.rel}/%`);
          lib.invalidate(target.profile.id);
          audit(a.user.id, 'webdav.delete', { path: target.rel });
          lib.touchService(target.profile);
          return res.status(204).end();
        }
        case 'MKCOL':
          if (fs.existsSync(target.abs)) return res.status(405).end();
          await fsp.mkdir(target.abs, { recursive: true });
          return res.status(201).end();
        case 'MOVE':
        case 'COPY': {
          const destHeader = req.get('destination');
          if (!destHeader) return res.status(400).end();
          const to = resolve(a.user, new URL(destHeader, `http://${req.get('host')}`).pathname);
          if (!to.profile) return res.status(403).end();
          const exists = fs.existsSync(to.abs);
          if (exists && req.get('overwrite') === 'F') return res.status(412).end();
          await fsp.mkdir(path.dirname(to.abs), { recursive: true });
          if (req.method === 'MOVE') {
            await fsp.rename(target.abs, to.abs).catch(async () => {
              await fsp.cp(target.abs, to.abs, { recursive: true });
              await fsp.rm(target.abs, { recursive: true });
            });
            if (to.profile.id === target.profile.id) db.prepare('UPDATE tracks SET path = ? WHERE profile_id = ? AND path = ?').run(to.rel, target.profile.id, target.rel);
            lib.invalidate(target.profile.id);
            lib.touchService(target.profile);
          } else await fsp.cp(target.abs, to.abs, { recursive: true });
          afterChange(to.profile, to.abs);
          audit(a.user.id, `webdav.${req.method.toLowerCase()}`, { from: target.rel, to: to.rel });
          return res.status(exists ? 204 : 201).end();
        }
        case 'LOCK': {
          // Fake locks: enough for Windows and macOS to write.
          const t = `opaquelocktoken:${uuid()}`;
          return res
            .status(200)
            .set('Lock-Token', `<${t}>`)
            .type('application/xml; charset=utf-8')
            .send(`<?xml version="1.0" encoding="utf-8"?><d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${t}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`);
        }
        case 'UNLOCK':
          return res.status(204).end();
        case 'PROPPATCH':
          return res.status(207).type('application/xml').send(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${xml(req.originalUrl)}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
        default:
          return res.status(405).end();
      }
    } catch (e) {
      next(e);
    }
  });
}

export function register(app) {
  app.get('/api/account/app-passwords', requireUser, json((req) => db.prepare('SELECT id, name, scopes, last_used, created_at FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id).map((r) => ({ ...r, scopes: JSON.parse(r.scopes) }))));
  app.post(
    '/api/account/app-passwords',
    requireUser,
    json(async (req) => {
      if (req.user.anonymous) throw httpError(400, 'Turn on logins and log in to make app passwords');
      const secret = token(18).replace(/[-_]/g, 'x');
      const scopes = req.body.write ? ['webdav', 'webdav:write'] : ['webdav'];
      const id = uuid();
      db.prepare('INSERT INTO app_passwords (id, user_id, name, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user.id, str(req.body.name, 80) || 'WebDAV', await hashPassword(secret), JSON.stringify(scopes), now());
      audit(req.user.id, 'app-password.create', { name: req.body.name, scopes });
      return { id, password: secret, scopes };
    }),
  );
  app.delete(
    '/api/account/app-passwords/:id',
    requireUser,
    json((req) => {
      db.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
      authCache.clear();
      return { ok: true };
    }),
  );
}
