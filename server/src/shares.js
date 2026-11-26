// Shares: songs, albums, artists, playlists, radio stations or any selection.
// Same address scheme as Navidrome (/share/<10 char id>). Public, key-protected
// or private; downloads optional; expiry optional. Navidrome's own shares are
// listed next to ours, and can be created on Navidrome at the same time.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { db, now, audit } from './db.js';
import * as settings from './settings.js';
import * as lib from './library/index.js';
import { getProfile, canUse, forProfile, visibleProfiles } from './services/index.js';
import { requireUser } from './auth.js';
import { httpError, json, str, bool, limiter } from './lib/http.js';
import { shortId, hashPassword, verifyPassword, sha256, safeEqual } from './lib/crypto.js';
import * as tags from './library/tags.js';
import { ZipArchive } from 'archiver';
import { REPO_URL, AUTHOR_URL } from './config.js';

const keyLimit = limiter({ windowMs: 10 * 60_000, max: 30 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600);
  return h ? `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function publicBase(req) {
  const pub = settings.get('public').url;
  return pub ? pub.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
}

function row(id) {
  return db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
}

function out(s, req) {
  const ref = JSON.parse(s.ref);
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    kind: s.kind,
    visibility: s.visibility,
    allowDownload: Boolean(s.allow_download),
    expiresAt: s.expires_at,
    views: s.views,
    lastVisited: s.last_visited,
    createdAt: s.created_at,
    profileId: s.profile_id,
    remoteId: s.remote_id,
    source: s.source,
    count: ref.items?.length || 0,
    title: ref.title,
    subtitle: ref.subtitle,
    url: `${publicBase(req)}/share/${s.id}`,
    remoteUrl: ref.remoteUrl || null,
  };
}

/** Resolve what is shared into a fixed list of items (a snapshot, like Navidrome). */
async function resolve(p, kind, refIn) {
  if (kind === 'theme') {
    const t = (settings.get('appearance').customThemes || []).find((x) => x.id === refIn.themeId);
    if (!t) throw httpError(404, 'No such theme');
    return { title: t.name, subtitle: 'Theme', cover: null, items: [], themeId: t.id };
  }
  const items = [];
  let title = refIn.title;
  let subtitle = '';
  let cover = null;
  const s = p.url ? forProfile(p) : null;
  const pushLocal = (t) => items.push({ local: t.id, remote: t.remoteId || null, title: t.title || t.filename, artist: t.artist, album: t.album, duration: t.duration, cover: t.cover ? `l:${t.id}` : null });
  const pushRemote = (x) => {
    const localTrack = p.local_path ? lib.all(p.id).find((t) => t.remoteId === x.id) : null;
    items.push({ local: localTrack?.id || null, remote: x.id, title: x.title, artist: x.artist, album: x.album, duration: x.duration, cover: x.coverArt || null });
  };
  if (kind === 'selection' || kind === 'track') {
    for (const id of refIn.ids || []) {
      const sid = String(id);
      if (sid.startsWith('l:') || /^\d+$/.test(sid)) {
        const t = lib.byId(p.id, sid.replace(/^l:/, ''));
        if (t) pushLocal(t);
      } else if (s) pushRemote(await s.song(sid));
    }
    if (kind === 'track' && items[0]) {
      title = title || items[0].title;
      subtitle = items[0].artist;
    }
  } else if (kind === 'album') {
    if (String(refIn.id).startsWith('la:')) {
      const [artist, album] = Buffer.from(refIn.id.slice(3), 'base64url').toString().split('|');
      lib.all(p.id).filter((t) => (t.albumartist || t.artist || '') === artist && (t.album || '') === album).sort((a, b) => (a.disc || 1) - (b.disc || 1) || (a.track || 0) - (b.track || 0)).forEach(pushLocal);
      title = title || album;
      subtitle = artist;
    } else {
      const a = await s.album(refIn.id);
      a.songs.forEach(pushRemote);
      title = title || a.name;
      subtitle = `${a.artist}${a.year ? ` · ${a.year}` : ''}`;
      cover = a.coverArt;
    }
  } else if (kind === 'playlist') {
    if (String(refIn.id).startsWith('lp:')) {
      const pl = db.prepare('SELECT * FROM local_playlists WHERE id = ?').get(refIn.id.slice(3));
      JSON.parse(pl.track_ids).map((id) => lib.byId(p.id, id)).filter(Boolean).forEach(pushLocal);
      title = title || pl.name;
    } else {
      const pl = await s.playlist(refIn.id);
      pl.songs.forEach(pushRemote);
      title = title || pl.name;
      subtitle = pl.comment || '';
      cover = pl.coverArt;
    }
  } else if (kind === 'artist') {
    if (String(refIn.id).startsWith('lr:')) {
      const name = Buffer.from(refIn.id.slice(3), 'base64url').toString();
      lib.all(p.id).filter((t) => (t.albumartist || t.artist) === name).sort((a, b) => String(a.album).localeCompare(String(b.album)) || (a.track || 0) - (b.track || 0)).forEach(pushLocal);
      title = title || name;
    } else {
      const a = await s.artist(refIn.id);
      title = title || a.name;
      cover = a.coverArt;
      for (const al of a.albums || []) {
        const full = await s.album(al.id);
        full.songs.forEach(pushRemote);
      }
      subtitle = `${a.albums?.length || 0} albums`;
    }
  } else if (kind === 'radio') {
    items.push({ radio: true, title: refIn.name, streamUrl: refIn.streamUrl, homepageUrl: refIn.homepageUrl });
    title = title || refIn.name;
    subtitle = 'Internet radio';
  } else throw httpError(400, 'Unknown share kind');
  if (!items.length) throw httpError(400, 'There is nothing to share here');
  return { title, subtitle, cover: cover || items.find((i) => i.cover)?.cover || null, items };
}

export function register(app) {
  app.get(
    '/api/shares',
    requireUser,
    json(async (req) => {
      const own = db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all().filter((s) => req.user.role === 'admin' || s.owner_id === req.user.id).map((s) => out(s, req));
      const remote = [];
      const errors = [];
      for (const p of visibleProfiles(req.user).filter((x) => x.url && x.kind !== 'jellyfin')) {
        try {
          for (const sh of await forProfile(p).shares()) {
            if (own.some((o) => o.remoteId === sh.id)) continue;
            remote.push({ id: sh.id, remote: true, profileId: p.id, profileName: p.name, name: sh.description, description: sh.description, url: sh.url, createdAt: Date.parse(sh.created), expiresAt: sh.expires ? Date.parse(sh.expires) : null, views: sh.visitCount, lastVisited: sh.lastVisited ? Date.parse(sh.lastVisited) : null, count: sh.songs.length, kind: 'selection', source: 'navidrome', visibility: 'public', allowDownload: null });
          }
        } catch (e) {
          errors.push({ profile: p.name, error: e.message, offline: e.offline });
        }
      }
      return { shares: [...own, ...remote], errors };
    }),
  );

  app.post(
    '/api/shares',
    requireUser,
    json(async (req) => {
      const p = getProfile(req.body.profileId);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      const kind = str(req.body.kind, 20);
      const snap = await resolve(p, kind, req.body.ref || {});
      const d = settings.get('shares');
      const visibility = ['public', 'key', 'private'].includes(req.body.visibility) ? req.body.visibility : d.defaultVisibility;
      let keyHash = null;
      let key = null;
      if (visibility === 'key') {
        key = str(req.body.key, 200) || shortId(8);
        keyHash = await hashPassword(key);
      }
      let id = shortId(10);
      while (row(id)) id = shortId(10);
      const expires = req.body.expiresAt ? Number(req.body.expiresAt) : d.defaultExpiryDays ? now() + d.defaultExpiryDays * 86400e3 : null;
      let remoteId = null;
      let remoteUrl = null;
      // Also create it on Navidrome so it shows up there (songs / albums / playlists only).
      if (bool(req.body.alsoOnService) && p.kind !== 'jellyfin' && p.url && ['track', 'album', 'playlist', 'selection'].includes(kind)) {
        try {
          const ids = kind === 'album' || kind === 'playlist' ? [req.body.ref.id] : snap.items.map((i) => i.remote).filter(Boolean);
          const sh = await forProfile(p).createShare(ids, { description: str(req.body.name, 200) || snap.title, expires: expires || undefined });
          remoteId = sh?.id || null;
          remoteUrl = sh?.url || null;
        } catch (e) {
          snap.serviceError = e.message;
        }
      }
      db.prepare('INSERT INTO shares (id, name, description, kind, ref, profile_id, visibility, key_hash, allow_download, expires_at, remote_id, source, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        str(req.body.name, 200) || null,
        str(req.body.description, 2000) || null,
        kind,
        JSON.stringify({ ...snap, remoteUrl, source: req.body.ref }),
        p.id,
        visibility,
        keyHash,
        bool(req.body.allowDownload ?? d.defaultDownload) ? 1 : 0,
        expires,
        remoteId,
        'mmm',
        req.user.id,
        now(),
      );
      audit(req.user.id, 'share.create', { id, kind, visibility });
      return { ...out(row(id), req), key, serviceError: snap.serviceError || null };
    }),
  );

  app.patch(
    '/api/shares/:id',
    requireUser,
    json(async (req) => {
      const s = row(req.params.id);
      if (!s) {
        // A Navidrome share: only its description and expiry can change.
        const p = getProfile(req.body.profileId);
        if (!canUse(req.user, p)) throw httpError(404, 'No such share');
        await forProfile(p).updateShare(req.params.id, { description: req.body.name, expires: req.body.expiresAt || undefined });
        return { ok: true };
      }
      if (req.user.role !== 'admin' && s.owner_id !== req.user.id) throw httpError(403, 'Not yours');
      const b = req.body;
      let keyHash = s.key_hash;
      let key = null;
      if (b.visibility === 'key' && (b.key || !s.key_hash)) {
        key = str(b.key, 200) || shortId(8);
        keyHash = await hashPassword(key);
      }
      db.prepare('UPDATE shares SET name = ?, description = ?, visibility = ?, key_hash = ?, allow_download = ?, expires_at = ? WHERE id = ?').run(
        b.name !== undefined ? str(b.name, 200) : s.name,
        b.description !== undefined ? str(b.description, 2000) : s.description,
        b.visibility || s.visibility,
        (b.visibility || s.visibility) === 'key' ? keyHash : null,
        b.allowDownload !== undefined ? (bool(b.allowDownload) ? 1 : 0) : s.allow_download,
        b.expiresAt !== undefined ? b.expiresAt || null : s.expires_at,
        s.id,
      );
      if (s.remote_id && b.name !== undefined) {
        try {
          await forProfile(getProfile(s.profile_id)).updateShare(s.remote_id, { description: b.name });
        } catch {}
      }
      return { ...out(row(s.id), req), key };
    }),
  );

  app.delete(
    '/api/shares/:id',
    requireUser,
    json(async (req) => {
      const s = row(req.params.id);
      if (!s) {
        const p = getProfile(req.query.profileId);
        if (!canUse(req.user, p)) throw httpError(404, 'No such share');
        await forProfile(p).deleteShare(req.params.id);
        return { ok: true };
      }
      if (req.user.role !== 'admin' && s.owner_id !== req.user.id) throw httpError(403, 'Not yours');
      if (s.remote_id && bool(req.query.alsoOnService)) {
        try {
          await forProfile(getProfile(s.profile_id)).deleteShare(s.remote_id);
        } catch {}
      }
      db.prepare('DELETE FROM shares WHERE id = ?').run(s.id);
      audit(req.user.id, 'share.delete', { id: s.id });
      return { ok: true };
    }),
  );

  // ---- the public share page ----
  const access = async (req, res) => {
    const s = row(req.params.id);
    if (!s) return { error: 404 };
    if (s.expires_at && s.expires_at < now()) return { error: 410, s };
    if (s.visibility === 'private') {
      if (!req.user || req.user.anonymous || (req.user.role !== 'admin' && req.user.id !== s.owner_id)) return { error: 403, s };
      return { s };
    }
    if (s.visibility === 'key') {
      const cookie = req.cookies?.[`mmm_share_${s.id}`];
      if (cookie && safeEqual(cookie, sha256(`${s.id}:${s.key_hash}`))) return { s };
      const k = req.query.k || req.body?.k;
      if (k) {
        if (!keyLimit(`${req.ip}:${s.id}`)) return { error: 429, s };
        if (await verifyPassword(String(k), s.key_hash)) {
          res.cookie(`mmm_share_${s.id}`, sha256(`${s.id}:${s.key_hash}`), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 7 * 86400e3, path: `/share/${s.id}` });
          return { s };
        }
        return { error: 401, s, wrongKey: true };
      }
      return { error: 401, s };
    }
    return { s };
  };

  app.all('/share/:id', async (req, res, next) => {
    try {
      const a = await access(req, res);
      if (a.error) return res.status(a.error === 401 ? 200 : a.error).type('html').send(gatePage(req, a));
      const s = a.s;
      db.prepare('UPDATE shares SET views = views + 1, last_visited = ? WHERE id = ?').run(now(), s.id);
      res.type('html').send(sharePage(req, s));
    } catch (e) {
      next(e);
    }
  });

  // A shared theme: the CSS is served live, so the person who shared it updates it for everyone.
  app.get('/share/:id/theme.css', async (req, res) => {
    const a = await access(req, res);
    if (a.error) return res.status(a.error === 401 ? 403 : a.error).end();
    const ref = JSON.parse(a.s.ref);
    const t = (settings.get('appearance').customThemes || []).find((x) => x.id === ref.themeId);
    if (!t) return res.status(410).type('text/css').send('/* This theme was removed by its author. */');
    db.prepare('UPDATE shares SET views = views + 1, last_visited = ? WHERE id = ?').run(now(), a.s.id);
    res.set('Cache-Control', 'no-cache').set('Access-Control-Allow-Origin', '*').type('text/css').send(withUpdateUrl(t.css, `${publicBase(req)}/share/${a.s.id}/theme.css`));
  });

  app.get('/share/:id/cover.jpg', async (req, res) => {
    const a = await access(req, res);
    if (a.error) return res.status(a.error === 401 ? 403 : a.error).end();
    const ref = JSON.parse(a.s.ref);
    const n = req.query.n !== undefined ? Number(req.query.n) : null;
    const coverId = n !== null ? ref.items[n]?.cover : ref.cover;
    await sendCover(getProfile(a.s.profile_id), coverId, res);
  });

  app.get('/share/:id/stream/:n', async (req, res) => {
    const a = await access(req, res);
    if (a.error) return res.status(a.error === 401 ? 403 : a.error).end();
    const ref = JSON.parse(a.s.ref);
    const item = ref.items[Number(req.params.n)];
    if (!item || item.radio) return res.status(404).end();
    const p = getProfile(a.s.profile_id);
    await sendItem(p, item, req, res, { download: false });
  });

  app.get('/share/:id/download{/:n}', async (req, res) => {
    const a = await access(req, res);
    if (a.error) return res.status(a.error === 401 ? 403 : a.error).end();
    if (!a.s.allow_download) return res.status(403).send('Downloads are off for this share');
    const ref = JSON.parse(a.s.ref);
    const p = getProfile(a.s.profile_id);
    if (req.params.n !== undefined) {
      const item = ref.items[Number(req.params.n)];
      if (!item || item.radio) return res.status(404).end();
      return sendItem(p, item, req, res, { download: true });
    }
    // Everything as one zip (music is stored, not compressed: it would not shrink).
    res.attachment(`${(a.s.name || ref.title || 'share').replace(/[^\w .-]+/g, '_')}.zip`);
    const z = new ZipArchive({ store: true });
    z.pipe(res);
    for (const [i, item] of ref.items.entries()) {
      if (item.radio) continue;
      const t = item.local ? lib.byId(p.id, item.local) : null;
      if (t && p.local_path) {
        const abs = lib.absPath(p, t.path);
        if (fs.existsSync(abs)) {
          z.file(abs, { name: `${String(i + 1).padStart(2, '0')} - ${path.basename(abs)}` });
          continue;
        }
      }
      if (item.remote && p.url) {
        try {
          const r = await forProfile(p).c.raw('download', { id: item.remote });
          if (r.ok) z.append(Readable.fromWeb(r.body), { name: `${String(i + 1).padStart(2, '0')} - ${item.artist || ''} - ${item.title}.${(r.headers.get('content-type') || '').includes('flac') ? 'flac' : 'mp3'}` });
        } catch {}
      }
    }
    await z.finalize();
  });
}

async function sendItem(p, item, req, res, { download }) {
  const t = item.local && p.local_path ? lib.byId(p.id, item.local) : null;
  if (t) {
    const abs = lib.absPath(p, t.path);
    if (fs.existsSync(abs)) {
      if (download) res.attachment(path.basename(abs));
      return res.sendFile(abs, { acceptRanges: true });
    }
  }
  if (item.remote && p.url) {
    try {
      const r = download ? await forProfile(p).c.raw('download', { id: item.remote }) : await forProfile(p).stream(item.remote, req.get('range'));
      res.status(r.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) res.set(h, r.headers.get(h));
      if (download) res.attachment(`${item.artist || ''} - ${item.title}`.replace(/[/\\?%*:|"<>]/g, '-'));
      return Readable.fromWeb(r.body).pipe(res);
    } catch {}
  }
  res.status(503).send('This song is not available right now');
}

async function sendCover(p, coverId, res) {
  if (!p || !coverId) return res.redirect('/share-placeholder.svg');
  try {
    if (String(coverId).startsWith('l:')) {
      const t = lib.byId(p.id, String(coverId).slice(2));
      const c = t && (await tags.readCover(lib.absPath(p, t.path)));
      if (c) return res.set('Cache-Control', 'public, max-age=3600').type(c.format).send(c.data);
    } else if (p.url) {
      const r = await forProfile(p).cover(coverId, 600);
      if (r.ok) return res.set('Cache-Control', 'public, max-age=3600').type(r.headers.get('content-type') || 'image/jpeg').send(Buffer.from(await r.arrayBuffer()));
    }
  } catch {}
  res.redirect('/share-placeholder.svg');
}

// ---- HTML ----
function shell(req, { title, description, image, type, audio, body, color = '#8b5cf6', robots = 'noindex' }) {
  const site = esc(settings.get('shares').siteName || 'Master Music Manager');
  const url = `${publicBase(req)}${req.path}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${site}</title>
<meta name="robots" content="${robots}">
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="${esc(color)}">
<meta property="og:site_name" content="${site}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:type" content="${type || 'website'}">
${image ? `<meta property="og:image" content="${esc(image)}"><meta property="og:image:width" content="600"><meta property="og:image:height" content="600"><meta name="twitter:image" content="${esc(image)}">` : ''}
${audio ? `<meta property="og:audio" content="${esc(audio)}"><meta property="og:audio:type" content="audio/mpeg">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}">
<link rel="icon" href="/favicon.svg">
<style>${SHARE_CSS}</style></head><body>${body}
<footer><a href="${REPO_URL}" target="_blank" rel="noopener">Master Music Manager</a> · <a href="${AUTHOR_URL}" target="_blank" rel="noopener">by MrKoby07</a></footer>
</body></html>`;
}

function gatePage(req, a) {
  const msgs = { 404: ['Not found', 'This share does not exist (anymore).'], 410: ['Expired', 'This share has expired.'], 403: ['Private', 'Only its owner can open this share.'], 429: ['Slow down', 'Too many wrong keys. Try again in a few minutes.'] };
  if (a.error === 401) {
    return shell(req, {
      title: 'Protected share',
      description: 'This share needs a key to open.',
      body: `<main class="gate"><div class="lock">🔒</div><h1>This share is protected</h1><p>Enter the key you were given.</p><form method="post"><input name="k" type="password" autocomplete="off" placeholder="Key" autofocus required>${a.wrongKey ? '<p class="err">That key is not right.</p>' : ''}<button>Open</button></form></main>`,
    });
  }
  const [t, d] = msgs[a.error] || ['Error', 'Something went wrong.'];
  return shell(req, { title: t, description: d, body: `<main class="gate"><h1>${t}</h1><p>${d}</p></main>` });
}

/** Make sure the theme's header points back here for updates. */
function withUpdateUrl(css, url) {
  const m = css.match(/\/\*\s*==MMMTheme==([\s\S]*?)==\/MMMTheme==\s*\*\//);
  if (!m) return `/* ==MMMTheme==\n@updateURL ${url}\n==/MMMTheme== */\n${css}`;
  if (/@updateURL/.test(m[1])) return css;
  return css.replace(m[0], m[0].replace('==/MMMTheme==', `@updateURL ${url}\n==/MMMTheme==`));
}

function themePage(req, s) {
  const ref = JSON.parse(s.ref);
  const t = (settings.get('appearance').customThemes || []).find((x) => x.id === ref.themeId);
  const base = `${publicBase(req)}/share/${s.id}`;
  const meta = {};
  const m = t?.css.match(/==MMMTheme==([\s\S]*?)==\/MMMTheme==/);
  if (m) for (const line of m[1].split('\n')) { const x = line.match(/@(\w+)\s+(.+)/); if (x) meta[x[1]] = x[2].trim(); }
  const name = meta.name || t?.name || 'Theme';
  return shell(req, {
    title: name,
    description: meta.description || 'A theme for Master Music Manager',
    body: `<main class="share"><header class="hero"><div class="meta"><span class="kind">Theme for Master Music Manager</span><h1>${esc(name)}</h1>
<p class="facts">${[meta.author && `by ${esc(meta.author)}`, meta.version && `version ${esc(meta.version)}`, meta.license && esc(meta.license)].filter(Boolean).join(' · ')}</p>
${meta.description ? `<p class="desc">${esc(meta.description)}</p>` : ''}
<div class="actions"><a class="primary" style="padding:10px 20px;border-radius:999px;background:var(--acc);color:#fff;text-decoration:none" href="${base}/theme.css" download="${esc(name)}.css">Download</a><button id="copy" class="ghost">Copy install link</button></div>
<p class="desc">In Master Music Manager: Settings → Look → Install a theme, and paste the install link. It updates by itself when ${meta.author ? esc(meta.author) : 'the author'} changes it.</p></div></header>
<pre style="margin-top:28px;padding:16px;border-radius:14px;background:var(--card);border:1px solid var(--line);overflow:auto;max-height:50vh;font:12px/1.5 ui-monospace,monospace">${esc(t?.css || '')}</pre></main>
<script>document.getElementById('copy').onclick=async e=>{await navigator.clipboard.writeText(${JSON.stringify(`${base}/theme.css`)});e.target.textContent='Copied'}</script>`,
  });
}

function sharePage(req, s) {
  if (s.kind === 'theme') return themePage(req, s);
  const ref = JSON.parse(s.ref);
  const base = `${publicBase(req)}/share/${s.id}`;
  const title = s.name || ref.title || 'Shared music';
  const total = ref.items.reduce((a, i) => a + (i.duration || 0), 0);
  const kindLabel = { track: 'Song', album: 'Album', artist: 'Artist', playlist: 'Playlist', radio: 'Radio station', selection: 'Selection' }[s.kind];
  const desc = s.description || [kindLabel, ref.subtitle, ref.items.length > 1 ? `${ref.items.length} songs · ${fmt(total)}` : ref.items[0]?.duration ? fmt(ref.items[0].duration) : ''].filter(Boolean).join(' · ');
  const isPublic = s.visibility === 'public';
  const single = ref.items.length === 1 && !ref.items[0].radio;
  const items = ref.items
    .map(
      (i, n) => `<li data-n="${n}" ${i.radio ? `data-radio="${esc(i.streamUrl)}"` : ''}><button class="row" aria-label="Play ${esc(i.title)}"><span class="n">${n + 1}</span>${i.cover && !single ? `<img loading="lazy" src="${base}/cover.jpg?n=${n}" alt="">` : ''}<span class="t"><b>${esc(i.title)}</b><small>${esc([i.artist, s.kind !== 'album' ? i.album : ''].filter(Boolean).join(' · '))}</small></span><span class="d">${i.duration ? fmt(i.duration) : i.radio ? 'Live' : ''}</span></button>${s.allow_download && !i.radio ? `<a class="dl" href="${base}/download/${n}" title="Download" aria-label="Download ${esc(i.title)}">↓</a>` : ''}</li>`,
    )
    .join('');
  const body = `<div class="bg" style="background-image:url('${base}/cover.jpg')"></div>
<main class="share">
  <header class="hero">
    <img class="cover" src="${base}/cover.jpg" alt="" width="240" height="240">
    <div class="meta">
      <span class="kind">${esc(kindLabel)}</span>
      <h1>${esc(title)}</h1>
      ${ref.subtitle ? `<p class="sub">${esc(ref.subtitle)}</p>` : ''}
      <p class="facts">${ref.items.length > 1 ? `${ref.items.length} songs · ${fmt(total)}` : ''}${s.expires_at ? ` · available until ${new Date(s.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</p>
      ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
      <div class="actions"><button id="play" class="primary">▶ Play</button>${s.allow_download && ref.items.length > 1 ? `<a class="ghost" href="${base}/download">Download all</a>` : s.allow_download && single ? `<a class="ghost" href="${base}/download/0">Download</a>` : ''}<button id="copy" class="ghost">Copy link</button></div>
    </div>
  </header>
  <ol class="list">${items}</ol>
  <div class="player" hidden><div class="now"><b id="nt"></b><small id="na"></small></div><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Position"><span id="time">0:00</span><button id="pp" aria-label="Pause">❚❚</button></div>
  <audio id="audio" preload="none"></audio>
</main>
<script>${SHARE_JS.replace('__BASE__', JSON.stringify(base))}</script>`;
  return shell(req, {
    title,
    description: desc,
    image: isPublic ? `${base}/cover.jpg` : null,
    type: s.kind === 'track' ? 'music.song' : s.kind === 'album' ? 'music.album' : s.kind === 'playlist' ? 'music.playlist' : s.kind === 'radio' ? 'music.radio_station' : 'website',
    audio: isPublic && single ? `${base}/stream/0` : null,
    body,
    color: settings.get('appearance').accent,
  });
}

const SHARE_CSS = `
:root{--bg:#0f0d14;--fg:#f1eef7;--mut:#a8a1b8;--card:rgba(255,255,255,.06);--line:rgba(255,255,255,.08);--acc:#8b5cf6;color-scheme:dark}
@media(prefers-color-scheme:light){:root{--bg:#f6f4fa;--fg:#1d1a24;--mut:#6b6478;--card:rgba(255,255,255,.7);--line:rgba(20,10,40,.08);color-scheme:light}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
.bg{position:fixed;inset:-80px;background-size:cover;background-position:center;filter:blur(70px) saturate(1.4);opacity:.45;z-index:-1;transform:scale(1.1)}
.bg::after{content:"";position:absolute;inset:0;background:linear-gradient(to bottom,transparent,var(--bg) 70%)}
main{width:min(900px,100% - 32px);margin:48px auto 24px;flex:1}
.hero{display:flex;gap:28px;align-items:flex-end;flex-wrap:wrap}
.cover{width:240px;height:240px;border-radius:14px;object-fit:cover;box-shadow:0 24px 60px -20px rgba(0,0,0,.6);background:var(--card)}
.meta{flex:1;min-width:240px}.kind{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:600}
h1{font-size:clamp(28px,5vw,52px);line-height:1.05;margin:.2em 0;letter-spacing:-.02em}
.sub{margin:0;font-size:17px;font-weight:500}.facts,.desc{color:var(--mut);margin:.4em 0 0}
.actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
button,.ghost{font:inherit;border:0;border-radius:999px;padding:10px 20px;cursor:pointer;text-decoration:none;color:var(--fg);transition:transform .15s,background .15s}
.primary{background:var(--acc);color:#fff;font-weight:600}.primary:hover{transform:scale(1.04)}
.ghost{background:var(--card);border:1px solid var(--line)}.ghost:hover{background:var(--line)}
.list{list-style:none;padding:0;margin:32px 0 0;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;backdrop-filter:blur(20px)}
.list li{display:flex;align-items:center;border-bottom:1px solid var(--line)}.list li:last-child{border:0}
.row{all:unset;display:flex;align-items:center;gap:14px;flex:1;padding:10px 16px;cursor:pointer;min-width:0}
.row:hover{background:var(--line)}.row img{width:40px;height:40px;border-radius:6px;object-fit:cover}
.n{width:22px;text-align:right;color:var(--mut);font-variant-numeric:tabular-nums}
.t{display:flex;flex-direction:column;min-width:0;flex:1}.t b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.t small{color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.d{color:var(--mut);font-variant-numeric:tabular-nums}.dl{padding:0 16px;color:var(--mut);text-decoration:none;font-size:18px}.dl:hover{color:var(--fg)}
li.playing .t b,li.playing .n{color:var(--acc)}
.player{position:sticky;bottom:16px;margin-top:16px;display:flex;gap:14px;align-items:center;padding:12px 16px;border-radius:14px;background:var(--card);border:1px solid var(--line);backdrop-filter:blur(30px)}
.player .now{display:flex;flex-direction:column;min-width:0;width:30%}.player small{color:var(--mut)}.player b,.player small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#seek{flex:1;accent-color:var(--acc)}#time{color:var(--mut);font-variant-numeric:tabular-nums;min-width:44px}#pp{padding:8px 14px;background:var(--acc);color:#fff}
.gate{text-align:center;margin-top:18vh;max-width:380px}.gate .lock{font-size:42px}.gate form{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap;justify-content:center}
.gate input{flex:1;font:inherit;padding:10px 16px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--fg)}.gate button{background:var(--acc);color:#fff}.err{color:#f87171;width:100%}
footer{text-align:center;padding:24px;color:var(--mut);font-size:13px}footer a{color:inherit}
@media(max-width:560px){.hero{flex-direction:column;align-items:flex-start}.cover{width:180px;height:180px}.player .now{display:none}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

const SHARE_JS = `
const base=__BASE__,a=document.getElementById('audio'),items=[...document.querySelectorAll('.list li')];let cur=-1;
const fmt=s=>{s=Math.floor(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
function play(n){const li=items[n];if(!li)return;cur=n;items.forEach(x=>x.classList.toggle('playing',x===li));a.src=li.dataset.radio||base+'/stream/'+n;a.play();
document.querySelector('.player').hidden=false;document.getElementById('nt').textContent=li.querySelector('b').textContent;document.getElementById('na').textContent=li.querySelector('small').textContent;
if('mediaSession' in navigator)navigator.mediaSession.metadata=new MediaMetadata({title:li.querySelector('b').textContent,artist:li.querySelector('small').textContent,artwork:[{src:base+'/cover.jpg',sizes:'600x600'}]})}
items.forEach((li,n)=>li.querySelector('.row').onclick=()=>play(n));
document.getElementById('play').onclick=()=>cur<0?play(0):a.paused?a.play():a.pause();
document.getElementById('pp').onclick=()=>a.paused?a.play():a.pause();
a.onplay=()=>document.getElementById('pp').textContent='❚❚';a.onpause=()=>document.getElementById('pp').textContent='▶';
a.ontimeupdate=()=>{if(a.duration&&isFinite(a.duration))document.getElementById('seek').value=a.currentTime/a.duration*1000;document.getElementById('time').textContent=fmt(a.currentTime)};
document.getElementById('seek').oninput=e=>{if(a.duration)a.currentTime=e.target.value/1000*a.duration};
a.onended=()=>play(cur+1);
if('mediaSession' in navigator){navigator.mediaSession.setActionHandler('nexttrack',()=>play(cur+1));navigator.mediaSession.setActionHandler('previoustrack',()=>play(Math.max(0,cur-1)))}
document.getElementById('copy').onclick=async e=>{await navigator.clipboard.writeText(location.href.split('?')[0]);e.target.textContent='Copied';setTimeout(()=>e.target.textContent='Copy link',1500)};`;
