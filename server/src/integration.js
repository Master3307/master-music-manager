// For other apps: dashboards (HomeSite, Homarr, Homepage …) and scripts.
//
// Authentication is an API key (Settings → Account & security → Keys for
// other apps): "Authorization: Bearer mmm_<id>_<secret>". A key acts as the
// person who made it, but can only read: every request with a key that
// would change something is refused (see auth.js).
//
//   GET /api/integration              what this is, and the routes below
//   GET /api/integration/now-playing  who is listening to what right now
//   GET /api/integration/recent       recently added albums
//   GET /api/integration/stats        totals, plays, waiting songs, jobs
//   GET /api/integration/search?q=    songs and albums by name
//   GET /api/integration/cover?id=    a cover from any of the answers above
import { db, now } from './db.js';
import * as lib from './library/index.js';
import * as settings from './settings.js';
import { getProfile, canUse } from './services/index.js';
import { requireUser, makeApiKeyHash } from './auth.js';
import { audit } from './db.js';
import { token, uuid } from './lib/crypto.js';
import { httpError, json, str } from './lib/http.js';
import { VERSION } from './config.js';

const playing = new Map(); // `${user}:${title}` -> entry

/** Our own players report what they play (the Navidrome plugin reports the rest). */
export function markPlaying(entry) {
  if (!entry?.title) return;
  const key = `${entry.user || ''}|${entry.player || ''}`;
  playing.set(key, { ...entry, at: now() });
}

const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));
const profilesFor = (user) => db.prepare('SELECT * FROM profiles WHERE local_path IS NOT NULL ORDER BY sort').all().filter((p) => canUse(user, p));
const base = () => (settings.get('public').url || '').replace(/\/$/, '');

export function register(app, { pluginNowPlaying }) {
  // Keys for other apps (read-only). The full key is shown once.
  app.get('/api/account/api-keys', requireUser, json((req) => (req.user.anonymous ? [] : db.prepare("SELECT id, name, last_used, created_at FROM app_passwords WHERE user_id = ? AND scopes LIKE '%\"api\"%' ORDER BY created_at DESC").all(req.user.id))));
  app.post(
    '/api/account/api-keys',
    requireUser,
    json((req) => {
      if (req.user.anonymous) throw httpError(400, 'Turn on logins and log in to make keys');
      if (req.apiKey) throw httpError(403, 'A key can’t make keys');
      const id = uuid();
      const secret = token(24).replace(/[^\w-]/g, 'x');
      db.prepare('INSERT INTO app_passwords (id, user_id, name, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user.id, str(req.body.name, 80) || 'Dashboard', makeApiKeyHash(secret), JSON.stringify(['api']), now());
      audit(req.user.id, 'api-key.create', { name: req.body.name });
      return { id, key: `mmm_${id}_${secret}` };
    }),
  );
  app.delete(
    '/api/account/api-keys/:id',
    requireUser,
    json((req) => {
      db.prepare("DELETE FROM app_passwords WHERE id = ? AND user_id = ? AND scopes LIKE '%\"api\"%'").run(req.params.id, req.user.id);
      audit(req.user.id, 'api-key.delete', { id: req.params.id });
      return { ok: true };
    }),
  );

  app.get(
    '/api/integration',
    requireUser,
    json(() => ({
      app: 'Master Music Manager',
      version: VERSION,
      routes: ['now-playing', 'recent?size=12', 'stats', 'search?q=&size=4', 'cover?id=&size=300'].map((r) => `/api/integration/${r}`),
    })),
  );

  app.get(
    '/api/integration/now-playing',
    requireUser,
    json(() => {
      const fresh = (e) => now() - e.at < Math.max(10 * 60_000, (e.duration || 0) * 1000 + 60_000);
      const own = [...playing.values()].filter(fresh).map((e) => ({ id: `mmm:${e.user}:${e.player}`, title: e.title, artist: e.artist || '', album: e.album || '', cover: e.cover || null, user: e.user || '', player: e.player || 'Master Music Manager', minutesAgo: Math.floor((now() - e.at) / 60_000), duration: e.duration || null, type: 'music' }));
      const fromPlugin = (pluginNowPlaying?.() || []).map((e) => ({ id: `nd:${e.username}:${e.playerId || ''}`, title: e.track?.title || e.title || '', artist: e.track?.artist || e.artist || '', album: e.track?.album || e.album || '', cover: null, user: e.username || '', player: e.playerName || e.client || 'Navidrome', minutesAgo: Math.floor((now() - e.at) / 60_000), duration: e.track?.duration || null, type: 'music' }));
      return [...own, ...fromPlugin].filter((e) => e.title);
    }),
  );

  app.get(
    '/api/integration/recent',
    requireUser,
    json((req) => {
      const size = clamp(req.query.size, 1, 40, 12);
      const ids = profilesFor(req.user).map((p) => p.id);
      if (!ids.length) return [];
      const rows = db
        .prepare(`SELECT profile_id, album, COALESCE(NULLIF(album_artist, ''), artist) AS artist, MAX(year) AS year, COUNT(*) AS n, MAX(added_at) AS added, MAX(id) AS id, MAX(has_cover) AS cover FROM tracks WHERE profile_id IN (${ids.map(() => '?').join(',')}) AND album IS NOT NULL AND album != '' GROUP BY profile_id, album, COALESCE(NULLIF(album_artist, ''), artist) ORDER BY added DESC LIMIT ?`)
        .all(...ids, size);
      return rows.map((r) => ({ id: `${r.profile_id}|${r.album}`, title: r.album, subtitle: r.artist || '', year: r.year || null, cover: r.cover ? `${r.profile_id}|l:${r.id}` : null, count: r.n, type: 'album', link: base() ? `${base()}/library?q=${encodeURIComponent(`album:"${r.album}"`)}` : undefined }));
    }),
  );

  app.get(
    '/api/integration/stats',
    requireUser,
    json((req) => {
      const ids = profilesFor(req.user).map((p) => p.id);
      const where = ids.length ? `profile_id IN (${ids.map(() => '?').join(',')})` : '0';
      const t = db.prepare(`SELECT COUNT(*) songs, COUNT(DISTINCT COALESCE(NULLIF(album_artist, ''), artist)) artists, COUNT(DISTINCT album) albums, COALESCE(SUM(duration), 0) seconds, COALESCE(SUM(size), 0) bytes FROM tracks WHERE ${where}`).get(...ids);
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      const plays = (since) => db.prepare('SELECT COUNT(*) n FROM scrobbles WHERE ts >= ?').get(Math.floor(since / 1000)).n;
      return {
        songs: t.songs,
        artists: t.artists,
        albums: t.albums,
        hours: Math.round(t.seconds / 360) / 10,
        bytes: t.bytes,
        playsToday: plays(day.getTime()),
        playsWeek: plays(Date.now() - 7 * 86_400_000),
        waiting: db.prepare("SELECT COUNT(*) n FROM inbox WHERE status = 'pending'").get().n,
        running: db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued', 'running')").get().n,
        libraries: profilesFor(req.user).map((p) => p.name),
      };
    }),
  );

  app.get(
    '/api/integration/search',
    requireUser,
    json((req) => {
      const words = str(req.query.q, 200).trim();
      if (words.length < 2) return [];
      const size = clamp(req.query.size, 1, 20, 4);
      const out = [];
      for (const p of profilesFor(req.user)) {
        for (const t of lib.query(p.id, { q: words, limit: size }).list) {
          out.push({ id: `${p.id}|${t.id}`, title: t.title || t.filename, subtitle: [t.artist, t.album].filter(Boolean).join(' · '), cover: t.cover ? `${p.id}|l:${t.id}` : null, type: 'song', link: base() ? `${base()}/library?ids=${t.id}` : undefined });
          if (out.length >= size) return out;
        }
      }
      return out;
    }),
  );

  // Covers: the id from an answer above ("<library>|<cover id>").
  app.get('/api/integration/cover', requireUser, (req, res, next) => {
    const [pid, cid] = String(req.query.id || '').split('|');
    const p = getProfile(pid);
    if (!p || !cid || !canUse(req.user, p)) return next(httpError(404, 'No such cover'));
    const size = clamp(req.query.size, 32, 1200, 300);
    req.url = `/api/p/${encodeURIComponent(pid)}/cover/${encodeURIComponent(cid)}?size=${size}`;
    app.handle(req, res, next);
  });
}

