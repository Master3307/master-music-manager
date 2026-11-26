// Browsing and playing. With a service, data comes from it (play counts, stars,
// playlists). Without one, the local index answers the same questions. Playback
// prefers the service's stream (so it counts like any client); when it's down,
// the linked local file plays instead, then another linked instance.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { PATHS } from '../config.js';
import { db, now, audit } from '../db.js';
import * as settings from '../settings.js';
import * as lib from '../library/index.js';
import { getProfile, canUse, forProfile, svc, status, features } from '../services/index.js';
import { requireUser } from '../auth.js';
import { httpError, json, str, bool } from '../lib/http.js';
import { sha256, uuid } from '../lib/crypto.js';
import * as tags from '../library/tags.js';
import { compile } from '../library/query.js';
import { splitArtists } from '../library/naming.js';
import { log } from '../lib/log.js';

function prof(req) {
  const p = getProfile(req.params.pid);
  if (!p) throw httpError(404, 'No such profile');
  if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
  return p;
}
const hasService = (p) => Boolean(p.url && p.kind !== 'local');
async function serviceUp(p) {
  if (!hasService(p)) return false;
  return (await status(p)).online;
}

// ---- local fallbacks (same shapes as the service) ----
const enc = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const dec = (s) => Buffer.from(String(s), 'base64url').toString('utf8');
function localSong(t, a) {
  return {
    starred: a?.starred ? new Date(a.starred).toISOString() : null,
    rating: a?.rating || 0,
    playCount: a?.play_count || 0,
    id: `l:${t.id}`,
    localId: t.id,
    remoteId: t.remoteId,
    title: t.title || t.filename,
    artist: t.artist,
    album: t.album,
    albumId: `la:${enc(`${t.albumartist || t.artist || ''}|${t.album || ''}`)}`,
    albumArtist: t.albumartist,
    track: t.track,
    disc: t.disc,
    year: t.year,
    genre: t.genre?.[0],
    genres: t.genre || [],
    duration: t.duration,
    bitRate: t.bitrate,
    size: t.size,
    suffix: t.ext,
    path: t.path,
    coverArt: t.cover ? `l:${t.id}` : null,
    created: t.added,
    local: true,
  };
}
function localAlbums(p) {
  const map = new Map();
  for (const t of lib.all(p.id)) {
    const k = `${t.albumartist || t.artist || ''}|${t.album || ''}`;
    if (!map.has(k)) map.set(k, { id: `la:${enc(k)}`, name: t.album || 'Unknown Album', artist: t.albumartist || t.artist, year: t.year, genre: t.genre?.[0], songCount: 0, duration: 0, coverArt: null, created: t.added, local: true });
    const a = map.get(k);
    a.songCount++;
    a.duration += t.duration || 0;
    if (!a.coverArt && t.cover) a.coverArt = `l:${t.id}`;
    if (t.added > a.created) a.created = t.added;
  }
  return [...map.values()];
}

export function register(app) {
  // Home: a bit of everything, like a music app's start page.
  app.get(
    '/api/p/:pid/home',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const up = await serviceUp(p);
      if (up) {
        const s = forProfile(p);
        const safe = (f) => f().catch(() => []);
        const [recent, newest, frequent, random, genres, playlists] = await Promise.all([
          safe(() => s.albums({ type: 'recent', size: 20 })),
          safe(() => s.albums({ type: 'newest', size: 20 })),
          safe(() => s.albums({ type: 'frequent', size: 20 })),
          safe(() => s.albums({ type: 'random', size: 12 })),
          safe(() => s.genres()),
          safe(() => s.playlists()),
        ]);
        return { source: 'service', recent, newest, frequent, random, genres: genres.sort((a, b) => b.songCount - a.songCount).slice(0, 18), playlists: playlists.slice(0, 12) };
      }
      if (!p.local_path) return { source: 'offline', offline: hasService(p), recent: [], newest: [], frequent: [], random: [], genres: [], playlists: [] };
      const albums = localAlbums(p);
      const genres = new Map();
      for (const t of lib.all(p.id)) for (const g of t.genre || []) genres.set(g, (genres.get(g) || 0) + 1);
      return {
        source: 'local',
        offline: hasService(p),
        newest: albums.slice().sort((a, b) => b.created - a.created).slice(0, 20),
        random: albums.sort(() => Math.random() - 0.5).slice(0, 12),
        recent: [],
        frequent: [],
        genres: [...genres].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([name, songCount]) => ({ name, songCount })),
        playlists: localPlaylists(p),
      };
    }),
  );

  app.get(
    '/api/p/:pid/albums',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const q = { type: str(req.query.type, 40) || 'alphabeticalByName', size: Math.min(Number(req.query.size) || 60, 500), offset: Number(req.query.offset) || 0, genre: req.query.genre, fromYear: req.query.fromYear, toYear: req.query.toYear };
      if (await serviceUp(p)) return svc(() => forProfile(p).albums(q));
      let list = localAlbums(p);
      if (q.genre) list = list.filter((a) => a.genre === q.genre);
      const by = { newest: (a, b) => b.created - a.created, alphabeticalByArtist: (a, b) => String(a.artist).localeCompare(String(b.artist)), byYear: (a, b) => (b.year || 0) - (a.year || 0), random: () => Math.random() - 0.5 }[q.type] || ((a, b) => String(a.name).localeCompare(String(b.name)));
      return list.sort(by).slice(q.offset, q.offset + q.size);
    }),
  );

  app.get(
    '/api/p/:pid/albums/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      if (req.params.id.startsWith('la:')) {
        const [artist, album] = dec(req.params.id.slice(3)).split('|');
        const songs = lib.all(p.id).filter((t) => (t.albumartist || t.artist || '') === artist && (t.album || '') === album).sort((a, b) => (a.disc || 1) - (b.disc || 1) || (a.track || 0) - (b.track || 0));
        const a = localAlbums(p).find((x) => x.id === req.params.id);
        return { ...a, songs: songs.map(localSong) };
      }
      return svc(() => forProfile(p).album(req.params.id)).then((a) => withLocal(p, a));
    }),
  );

  app.get(
    '/api/p/:pid/artists',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      if (await serviceUp(p)) return svc(() => forProfile(p).artists());
      // Every artist of every song, also the featured ones.
      const lc = settings.get('library');
      const map = new Map();
      for (const t of lib.all(p.id)) {
        const names = new Set([...splitArtists(t.artist || '', lc, { noSplit: t.nosplit }), ...splitArtists(t.albumartist || '', lc, { noSplit: t.nosplit })]);
        if (!names.size) names.add('Unknown Artist');
        for (const name of names) {
          const k = name.toLowerCase();
          if (!map.has(k)) map.set(k, { id: `lr:${enc(name)}`, name, albumCount: new Set(), songCount: 0, coverArt: null, local: true });
          const a = map.get(k);
          a.songCount++;
          if (t.album) a.albumCount.add(t.album);
          if (!a.coverArt && t.cover) a.coverArt = `l:${t.id}`;
        }
      }
      return [...map.values()].map((a) => ({ ...a, albumCount: a.albumCount.size })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }),
  );

  app.get(
    '/api/p/:pid/artists/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      if (req.params.id.startsWith('lr:')) {
        const name = dec(req.params.id.slice(3));
        const lc = settings.get('library');
        const k = name.toLowerCase();
        const has = (v, t) => splitArtists(v || '', lc, { noSplit: t.nosplit }).some((x) => x.toLowerCase() === k);
        const songs = lib.all(p.id).filter((t) => has(t.artist, t) || has(t.albumartist, t));
        const own = localAlbums(p).filter((a) => splitArtists(a.artist || '', lc).some((x) => x.toLowerCase() === k));
        const ownIds = new Set(own.map((a) => a.id));
        const appears = [...new Map(songs.map((t) => [`${t.albumartist || t.artist || ''}|${t.album || ''}`, t])).values()].map((t) => localAlbums(p).find((a) => a.id === `la:${enc(`${t.albumartist || t.artist || ''}|${t.album || ''}`)}`)).filter((a) => a && !ownIds.has(a.id));
        const annMap = new Map(db.prepare('SELECT * FROM local_annotations WHERE profile_id = ? AND user_key = ?').all(p.id, userKey(req)).map((a) => [a.track_path, a]));
        const sorted = songs.slice().sort((a, b) => (annMap.get(b.path)?.play_count || 0) - (annMap.get(a.path)?.play_count || 0) || String(a.album).localeCompare(String(b.album)) || (a.track || 0) - (b.track || 0));
        return { id: req.params.id, name, albums: own, appearsOn: appears, top: sorted.map((t) => localSong(t, annMap.get(t.path))), songCount: songs.length, info: null, local: true };
      }
      return svc(() => forProfile(p).artist(req.params.id));
    }),
  );

  app.get(
    '/api/p/:pid/genres',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      if (await serviceUp(p)) return svc(() => forProfile(p).genres());
      const m = new Map();
      for (const t of lib.all(p.id)) for (const g of t.genre || []) m.set(g, (m.get(g) || 0) + 1);
      return [...m].map(([name, songCount]) => ({ name, songCount })).sort((a, b) => b.songCount - a.songCount);
    }),
  );

  app.get(
    '/api/p/:pid/search',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const q = str(req.query.q, 300);
      if (!q) return { songs: [], albums: [], artists: [] };
      if (await serviceUp(p)) return svc(() => forProfile(p).search(q, 20));
      const { list } = lib.query(p.id, { q, limit: 40 });
      return { songs: list.map(localSong), albums: localAlbums(p).filter((a) => String(a.name).toLowerCase().includes(q.toLowerCase())).slice(0, 20), artists: [] };
    }),
  );

  app.get(
    '/api/p/:pid/random',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const n = Math.min(Number(req.query.size) || 50, 500);
      if (await serviceUp(p)) return svc(() => forProfile(p).random(n, req.query.genre));
      return lib.all(p.id).slice().sort(() => Math.random() - 0.5).slice(0, n).map(localSong);
    }),
  );

  // Service-only views. Offline → 503 with a clear message.
  const only = (name, fn) =>
    json(async (req) => {
      const p = prof(req);
      if (!hasService(p)) throw httpError(400, `${name} needs a music service on this profile`, { needsService: true });
      return svc(() => fn(forProfile(p), req, p));
    });
  app.get(
    '/api/p/:pid/starred',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const local = p.local_path
        ? db
            .prepare('SELECT * FROM local_annotations WHERE profile_id = ? AND user_key = ? AND starred IS NOT NULL ORDER BY starred DESC')
            .all(p.id, userKey(req))
            .map((a) => {
              const t = lib.all(p.id).find((x) => x.path === a.track_path);
              return t ? localSong(t, a) : null;
            })
            .filter(Boolean)
        : [];
      if (hasService(p) && (await serviceUp(p))) {
        const r = await svc(() => forProfile(p).starred());
        const seen = new Set(r.songs.map((x) => x.id));
        return { ...r, songs: [...r.songs, ...local.filter((x) => !x.remoteId || !seen.has(x.remoteId))] };
      }
      return { songs: local, albums: [], artists: [], local: true };
    }),
  );
  app.post(
    '/api/p/:pid/star',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const ids = [].concat(req.body.ids || []);
      const on = req.body.on !== false;
      const remote = [];
      for (const id of ids) {
        if (isLocalId(id)) {
          const t = lib.byId(p.id, String(id).replace(/^l:/, ''));
          if (!t) continue;
          if (t.remoteId && hasService(p)) remote.push(t.remoteId);
          else setAnn(p, req, t, { starred: on ? Date.now() : null });
        } else remote.push(id);
      }
      if (remote.length) await svc(() => forProfile(p).star(remote, req.body.type, on));
      return { ok: true };
    }),
  );
  app.post(
    '/api/p/:pid/rate',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const id = String(req.body.id);
      const rating = Math.max(0, Math.min(5, Number(req.body.rating) || 0));
      if (isLocalId(id)) {
        const t = lib.byId(p.id, id.replace(/^l:/, ''));
        if (t?.remoteId && hasService(p)) await svc(() => forProfile(p).rate(t.remoteId, rating));
        else if (t) setAnn(p, req, t, { rating });
        return { ok: true };
      }
      await svc(() => forProfile(p).rate(id, rating));
      return { ok: true };
    }),
  );
  app.get('/api/p/:pid/songs/:id', requireUser, only('Songs', (s, req) => s.song(req.params.id)));
  app.get('/api/p/:pid/similar/:id', requireUser, only('Similar songs', (s, req) => s.similar(req.params.id, 40)));
  app.get('/api/p/:pid/now-playing', requireUser, only('Now playing', (s) => s.nowPlaying()));
  app.get('/api/p/:pid/folders', requireUser, only('Folders', (s) => s.folders()));
  app.get('/api/p/:pid/directory', requireUser, only('Folders', (s, req) => s.directory(req.query.id || null)));
  // Radio: the server's stations, plus stations kept here (for folder libraries, or copied).
  app.get(
    '/api/p/:pid/radios',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const local = db.prepare('SELECT * FROM local_radios WHERE profile_id = ? OR profile_id IS NULL ORDER BY name').all(p.id).map((r) => ({ id: `lr-${r.id}`, name: r.name, streamUrl: r.stream_url, homepageUrl: r.homepage_url, local: true }));
      let remote = [];
      let error = null;
      if (hasService(p) && p.kind !== 'jellyfin') {
        try {
          remote = await forProfile(p).radios();
        } catch (e) {
          error = e.message;
        }
      }
      return { stations: [...remote, ...local], error, canSaveOnServer: hasService(p) && p.kind !== 'jellyfin' };
    }),
  );
  app.post(
    '/api/p/:pid/radios',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const b = req.body;
      if (!str(b.name, 200) || !/^https?:\/\//.test(b.streamUrl || '')) throw httpError(400, 'Give the station a name and a stream address (http…)');
      if (String(b.id || '').startsWith('lr-') || b.local || !hasService(p) || p.kind === 'jellyfin') {
        if (b.id) db.prepare('UPDATE local_radios SET name = ?, stream_url = ?, homepage_url = ? WHERE id = ?').run(str(b.name, 200), str(b.streamUrl, 1000), str(b.homepageUrl, 1000) || null, String(b.id).slice(3));
        else db.prepare('INSERT INTO local_radios (id, profile_id, name, stream_url, homepage_url, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(uuid(), p.id, str(b.name, 200), str(b.streamUrl, 1000), str(b.homepageUrl, 1000) || null, now());
        return { ok: true };
      }
      await svc(() => forProfile(p).saveRadio(b));
      return { ok: true };
    }),
  );
  app.delete(
    '/api/p/:pid/radios/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      if (req.params.id.startsWith('lr-')) db.prepare('DELETE FROM local_radios WHERE id = ?').run(req.params.id.slice(3));
      else await svc(() => forProfile(p).deleteRadio(req.params.id));
      return { ok: true };
    }),
  );
  // Copy stations between this app and the server, or from another library.
  app.post(
    '/api/p/:pid/radios/copy',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const from = req.body.fromProfile ? getProfile(req.body.fromProfile) : p;
      if (!canUse(req.user, from)) throw httpError(403, 'Not yours');
      const list = req.body.direction === 'toServer' ? db.prepare('SELECT * FROM local_radios WHERE profile_id = ?').all(p.id).map((r) => ({ name: r.name, streamUrl: r.stream_url, homepageUrl: r.homepage_url })) : await svc(() => forProfile(from).radios());
      let n = 0;
      for (const r of list) {
        if (req.body.direction === 'toServer') await svc(() => forProfile(p).saveRadio(r));
        else if (!db.prepare('SELECT 1 FROM local_radios WHERE profile_id = ? AND stream_url = ?').get(p.id, r.streamUrl)) db.prepare('INSERT INTO local_radios (id, profile_id, name, stream_url, homepage_url, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(uuid(), p.id, r.name, r.streamUrl, r.homepageUrl || null, now());
        else continue;
        n++;
      }
      return { copied: n };
    }),
  );
  app.get('/api/p/:pid/queue', requireUser, only('Play queue', (s) => s.queue()));
  app.post('/api/p/:pid/queue', requireUser, only('Play queue', (s, req) => s.saveQueue(req.body.ids || [], req.body.current, req.body.position).then(() => ({ ok: true }))));
  app.post(
    '/api/p/:pid/service-scan',
    requireUser,
    only('Rescanning', async (s, req, p) => {
      const r = await s.scan(bool(req.body.full));
      audit(req.user.id, 'service.scan', { profile: p.id, full: bool(req.body.full) });
      return r || { scanning: true };
    }),
  );
  app.get('/api/p/:pid/service-scan', requireUser, only('Rescanning', (s) => s.scanStatus()));

  app.get(
    '/api/p/:pid/lyrics/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const id = req.params.id;
      if (id.startsWith('l:')) {
        const t = lib.byId(p.id, id.slice(2));
        if (!t) throw httpError(404, 'Track not found');
        const data = await tags.read(lib.absPath(p, t.path));
        const lrc = lib.absPath(p, t.path).replace(/\.[^.]+$/, '.lrc');
        const out = data.lyrics.map((l) => ({ lang: l.language || 'xxx', synced: l.synced, lines: l.synced ? l.syncText.map((s) => ({ start: s.timestamp, value: s.text })) : l.text.split('\n').map((value) => ({ value })) }));
        if (fs.existsSync(lrc)) out.unshift(parseLrc(fs.readFileSync(lrc, 'utf8')));
        return out;
      }
      if (!(await serviceUp(p))) return [];
      return svc(async () => {
        const s = forProfile(p);
        const song = await s.song(id);
        return s.lyrics(song);
      });
    }),
  );

  // ---- playlists ----
  app.get(
    '/api/p/:pid/playlists',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const local = localPlaylists(p);
      if (!hasService(p)) return local;
      try {
        const remote = await forProfile(p).playlists();
        let smart = new Map();
        if (p.kind === 'navidrome') {
          try {
            const native = await forProfile(p).c.native('playlist', { query: { _start: 0, _end: 1000 } });
            smart = new Map((native || []).filter((x) => x.rules).map((x) => [x.id, { rules: x.rules, path: x.path, sync: x.sync }]));
          } catch {}
        }
        return [...remote.map((x) => ({ ...x, smart: smart.get(x.id) || null })), ...local];
      } catch (e) {
        if (e.offline) return local.length ? local : Promise.reject(httpError(503, e.message, { offline: true }));
        throw e;
      }
    }),
  );
  app.get(
    '/api/p/:pid/playlists/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      if (req.params.id.startsWith('lp:')) {
        const pl = db.prepare('SELECT * FROM local_playlists WHERE id = ?').get(req.params.id.slice(3));
        if (!pl) throw httpError(404, 'No such playlist');
        const songs = JSON.parse(pl.track_ids).map((id) => lib.byId(p.id, id)).filter(Boolean).map(localSong);
        return { id: req.params.id, name: pl.name, comment: pl.comment, songs, songCount: songs.length, duration: songs.reduce((a, s) => a + (s.duration || 0), 0), local: true };
      }
      return svc(() => forProfile(p).playlist(req.params.id)).then((pl) => withLocal(p, pl));
    }),
  );
  app.post(
    '/api/p/:pid/playlists',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const name = str(req.body.name, 200).trim() || 'New playlist';
      const ids = req.body.songIds || [];
      if (!hasService(p) || req.body.local || (req.user.role !== 'admin' && !p.owner_id)) {
        const id = uuid();
        db.prepare('INSERT INTO local_playlists (id, profile_id, name, comment, track_ids, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, p.id, name, str(req.body.comment, 2000), JSON.stringify(ids.map((x) => Number(String(x).replace(/^l:/, '')))), req.user.id, now(), now());
        return { id: `lp:${id}`, name };
      }
      const remoteIds = toRemote(p, ids);
      return svc(() => forProfile(p).createPlaylist(name, remoteIds));
    }),
  );
  app.patch(
    '/api/p/:pid/playlists/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const b = req.body;
      if (req.params.id.startsWith('lp:')) {
        const pl = db.prepare('SELECT * FROM local_playlists WHERE id = ?').get(req.params.id.slice(3));
        if (!pl) throw httpError(404, 'No such playlist');
        let ids = JSON.parse(pl.track_ids);
        if (b.songIds) ids = b.songIds.map((x) => Number(String(x).replace(/^l:/, '')));
        if (b.add) ids.push(...b.add.map((x) => Number(String(x).replace(/^l:/, ''))));
        if (b.removeIndexes) ids = ids.filter((_, i) => !b.removeIndexes.includes(i));
        db.prepare('UPDATE local_playlists SET name = COALESCE(?, name), comment = COALESCE(?, comment), track_ids = ?, updated_at = ? WHERE id = ?').run(b.name ?? null, b.comment ?? null, JSON.stringify(ids), now(), pl.id);
        return { ok: true };
      }
      const s = forProfile(p);
      return svc(async () => {
        if (b.songIds) await s.replacePlaylist(req.params.id, toRemote(p, b.songIds));
        await s.updatePlaylist(req.params.id, { name: b.name, comment: b.comment, public: b.public, add: toRemote(p, b.add || []), removeIndexes: b.removeIndexes || [] });
        return { ok: true };
      });
    }),
  );
  app.delete(
    '/api/p/:pid/playlists/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      if (req.params.id.startsWith('lp:')) {
        db.prepare('DELETE FROM local_playlists WHERE id = ?').run(req.params.id.slice(3));
        return { ok: true };
      }
      return svc(() => forProfile(p).deletePlaylist(req.params.id).then(() => ({ ok: true })));
    }),
  );

  // ---- smart playlists (Navidrome .nsp files) ----
  app.get('/api/smart/fields', requireUser, json(() => SMART_FIELDS));
  app.post(
    '/api/p/:pid/smart/preview',
    requireUser,
    json((req) => {
      const p = prof(req);
      if (!p.local_path) return { approximate: true, tracks: [], total: 0, note: 'Link a folder to preview here. The playlist still works on the server.' };
      const { test, approximate } = compileNsp(req.body.rules || {});
      let list = lib.all(p.id).filter(test);
      const rules = req.body.rules || {};
      if (rules.sort) {
        const k = NSP_TO_LOCAL[rules.sort.replace(/^[-+]/, '')] || rules.sort;
        const desc = rules.order === 'desc' || rules.sort.startsWith('-');
        list = list.sort((a, b) => (String(a[k] ?? '').localeCompare(String(b[k] ?? ''), undefined, { numeric: true }) * (desc ? -1 : 1)));
      }
      if (rules.limit) list = list.slice(0, Number(rules.limit));
      return { approximate, total: list.length, tracks: list.slice(0, 300).map(localSong) };
    }),
  );
  app.post(
    '/api/p/:pid/smart',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const name = str(req.body.name, 200).trim();
      if (!name) throw httpError(400, 'Give the playlist a name');
      if (!p.local_path) throw httpError(400, 'Smart playlists are files in your music folder. Link the folder first.');
      const rules = { name, comment: str(req.body.comment, 1000) || undefined, ...(req.body.rules || {}) };
      const folder = req.body.path ? path.dirname(lib.absPath(p, req.body.path)) : lib.absPath(p, settings.get('library').playlistsFolder || 'Playlists');
      fs.mkdirSync(folder, { recursive: true });
      const file = req.body.path ? lib.absPath(p, req.body.path) : path.join(folder, `${name.replace(/[/\\?%*:|"<>]/g, '-')}.nsp`);
      fs.writeFileSync(file, `${JSON.stringify(rules, null, 2)}\n`);
      audit(req.user.id, 'smart.save', { name, file: path.relative(p.local_path, file) });
      if (hasService(p)) forProfile(p).scan(false).catch(() => {});
      return { ok: true, path: path.relative(p.local_path, file) };
    }),
  );
  app.get(
    '/api/p/:pid/smart',
    requireUser,
    json((req) => {
      const p = prof(req);
      if (!p.local_path) return [];
      const out = [];
      const walk = (d, depth) => {
        if (depth > 4) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f, depth + 1);
          else if (e.name.endsWith('.nsp')) {
            try {
              out.push({ path: path.relative(p.local_path, f), rules: JSON.parse(fs.readFileSync(f, 'utf8')) });
            } catch (err) {
              out.push({ path: path.relative(p.local_path, f), error: err.message });
            }
          }
        }
      };
      walk(p.local_path, 0);
      return out;
    }),
  );
  app.delete(
    '/api/p/:pid/smart',
    requireUser,
    json((req) => {
      const p = prof(req);
      const f = lib.absPath(p, str(req.query.path, 1000));
      if (!f.endsWith('.nsp')) throw httpError(400, 'Not a smart playlist');
      fs.rmSync(f, { force: true });
      if (hasService(p)) forProfile(p).scan(false).catch(() => {});
      return { ok: true };
    }),
  );

  // ---- streaming ----
  app.get('/api/p/:pid/stream/:key', requireUser, async (req, res, next) => {
    try {
      const p = prof(req);
      await stream(p, req.params.key, req, res);
    } catch (e) {
      next(e);
    }
  });

  app.post(
    '/api/p/:pid/scrobble',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const { key, submission = true, time } = req.body;
      const t = key?.startsWith('l:') ? lib.byId(p.id, key.slice(2)) : null;
      const remote = key?.startsWith('l:') ? t?.remoteId : key;
      let sent = false;
      if (remote && hasService(p) && settings.get('player').scrobble) {
        try {
          await forProfile(p).scrobble(remote, { submission, time: time || Date.now() });
          sent = true;
        } catch (e) {
          log.debug(`scrobble to ${p.name} failed: ${e.message}`);
        }
      }
      if (submission && t) setAnn(p, req, t, { play_count: (ann(p, req, t).play_count || 0) + 1, last_played: Date.now() });
      if (submission) {
        const song = req.body.song || {};
        db.prepare('INSERT OR IGNORE INTO scrobbles (profile_id, username, ts, title, artist, album, album_artist, duration, remote_id, player, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          p.id,
          p.username || req.user.username,
          Math.floor((time || Date.now()) / 1000),
          song.title || t?.title,
          song.artist || t?.artist,
          song.album || t?.album,
          song.albumArtist || t?.albumartist,
          song.duration || t?.duration,
          remote || null,
          'Master Music Manager',
          sent ? 'mmm-player' : 'mmm-player-local',
        );
      }
      return { ok: true, sent };
    }),
  );

  // ---- covers (cached a day on disk) ----
  app.get('/api/p/:pid/cover/:id', requireUser, async (req, res, next) => {
    try {
      const p = prof(req);
      await cover(p, req.params.id, Number(req.query.size) || 0, res);
    } catch (e) {
      next(e);
    }
  });

  // ---- playlist / artist / radio pictures: any image, GIFs and animated WebP stay animated ----
  const customFile = (p, kind, id) => {
    const dir = path.join(PATHS.covers, 'custom', p.id);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${kind}-${sha256(String(id)).slice(0, 24)}`);
    return { base, find: () => ['gif', 'webp', 'png', 'jpg'].map((e) => `${base}.${e}`).find((f) => fs.existsSync(f)) };
  };
  app.put(
    '/api/p/:pid/image/:kind/:id',
    requireUser,
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '30mb' }),
    json(async (req) => {
      const p = prof(req);
      const kind = req.params.kind;
      if (!['playlist', 'artist', 'radio'].includes(kind)) throw httpError(400, 'Unknown picture kind');
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'Send an image');
      const type = req.get('content-type');
      const ext = /gif/.test(type) ? 'gif' : /webp/.test(type) ? 'webp' : /png/.test(type) ? 'png' : 'jpg';
      const f = customFile(p, kind, req.params.id);
      for (const e of ['gif', 'webp', 'png', 'jpg']) fs.rmSync(`${f.base}.${e}`, { force: true });
      fs.writeFileSync(`${f.base}.${ext}`, req.body);
      let synced = false;
      let note = null;
      if (p.kind === 'navidrome' && kind !== 'radio' && !String(req.params.id).startsWith('lp:') && !String(req.params.id).startsWith('lr:')) {
        try {
          await forProfile(p).c.nativeImage(`${kind}/${req.params.id}`, req.body, type);
          synced = true;
        } catch (e) {
          note = e.message;
        }
      } else if (hasService(p) && kind !== 'radio') note = `${p.kindLabel || p.kind} can't store this picture; it shows in Master Music Manager only.`;
      audit(req.user.id, 'image.set', { kind, id: req.params.id, synced });
      return { ok: true, synced, note, animated: ext === 'gif' || ext === 'webp' };
    }),
  );
  app.delete(
    '/api/p/:pid/image/:kind/:id',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const f = customFile(p, req.params.kind, req.params.id);
      for (const e of ['gif', 'webp', 'png', 'jpg']) fs.rmSync(`${f.base}.${e}`, { force: true });
      if (p.kind === 'navidrome' && req.params.kind !== 'radio') await forProfile(p).c.nativeImage(`${req.params.kind}/${req.params.id}`, null, null, { remove: true }).catch(() => null);
      return { ok: true };
    }),
  );
  app.get('/api/p/:pid/image/:kind/:id', requireUser, async (req, res, next) => {
    try {
      const p = prof(req);
      const own = customFile(p, req.params.kind, req.params.id).find();
      if (own) return res.set('Cache-Control', 'private, max-age=300').sendFile(own);
      // The service's own picture, at full size so animations survive.
      const coverId = req.query.cover || (req.params.kind === 'playlist' ? `pl-${req.params.id}` : req.params.kind === 'artist' ? `ar-${req.params.id}` : null);
      if (!coverId || !hasService(p)) return res.status(404).end();
      await cover(p, String(coverId), 0, res);
    } catch (e) {
      next(e);
    }
  });

  app.get(
    '/api/p/:pid/features',
    requireUser,
    json(async (req) => {
      const p = prof(req);
      const st = await status(p);
      return { ...features(p, st), status: st, local: Boolean(p.local_path) };
    }),
  );
}

// Favorites, ratings and play counts for folder libraries (kept per person).
const userKey = (req) => (req.user && !req.user.anonymous ? req.user.id : '');
function ann(p, req, track) {
  return db.prepare('SELECT * FROM local_annotations WHERE profile_id = ? AND user_key = ? AND track_path = ?').get(p.id, userKey(req), track.path) || {};
}
function setAnn(p, req, track, patch) {
  const cur = ann(p, req, track);
  const next = { starred: cur.starred ?? null, rating: cur.rating ?? null, play_count: cur.play_count ?? 0, last_played: cur.last_played ?? null, ...patch };
  db.prepare('INSERT INTO local_annotations (profile_id, user_key, track_path, starred, rating, play_count, last_played) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, user_key, track_path) DO UPDATE SET starred = excluded.starred, rating = excluded.rating, play_count = excluded.play_count, last_played = excluded.last_played').run(
    p.id, userKey(req), track.path, next.starred, next.rating, next.play_count, next.last_played,
  );
}
const isLocalId = (id) => String(id).startsWith('l:') || /^\d+$/.test(String(id));

function localPlaylists(p) {
  return db
    .prepare('SELECT * FROM local_playlists WHERE profile_id = ? ORDER BY name')
    .all(p.id)
    .map((x) => {
      const ids = JSON.parse(x.track_ids);
      const first = ids.map((id) => lib.byId(p.id, id)).find((t) => t?.cover);
      return { id: `lp:${x.id}`, name: x.name, comment: x.comment, songCount: ids.length, coverArt: first ? `l:${first.id}` : null, local: true, changed: x.updated_at };
    });
}

/** Add our local id to every service song we also have on disk. */
function withLocal(p, obj) {
  if (!obj?.songs || !p.local_path) return obj;
  const byRemote = new Map(lib.all(p.id).filter((t) => t.remoteId).map((t) => [t.remoteId, t.id]));
  return { ...obj, songs: obj.songs.map((s) => ({ ...s, localId: byRemote.get(s.id) || null })) };
}

function toRemote(p, ids) {
  return (ids || [])
    .map((id) => {
      const s = String(id);
      if (s.startsWith('l:')) return lib.byId(p.id, s.slice(2))?.remoteId;
      return s;
    })
    .filter(Boolean);
}

async function pipeResponse(r, req, res) {
  res.status(r.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = r.headers.get(h);
    if (v) res.set(h, v);
  }
  res.set('Cache-Control', 'private, max-age=3600');
  if (!r.body) return res.end();
  const body = Readable.fromWeb(r.body);
  req.on('close', () => body.destroy());
  body.pipe(res);
}

async function stream(p, key, req, res) {
  const range = req.get('range');
  let local = null;
  let remote = null;
  if (key.startsWith('l:')) {
    local = lib.byId(p.id, key.slice(2));
    remote = local?.remoteId;
  } else {
    remote = key;
    if (p.local_path) local = lib.all(p.id).find((t) => t.remoteId === key);
  }
  const prefer = req.query.source || 'auto';
  const params = req.query.format ? { format: String(req.query.format), maxBitRate: req.query.maxBitRate } : {};
  if (prefer !== 'local' && remote && hasService(p) && (await serviceUp(p))) {
    try {
      const r = await forProfile(p).stream(remote, range, params);
      if (r.ok || r.status === 206) return pipeResponse(r, req, res);
    } catch (e) {
      log.debug(`service stream failed, trying local: ${e.message}`);
    }
  }
  if (local) {
    const abs = lib.absPath(p, local.path);
    if (fs.existsSync(abs)) return res.sendFile(abs, { acceptRanges: true, headers: { 'Cache-Control': 'private, max-age=3600', 'X-MMM-Source': 'local' } });
  }
  // Another linked instance that has exactly this audio.
  try {
    const fed = await import('../federation.js');
    const hash = local ? db.prepare('SELECT audio_hash FROM tracks WHERE id = ?').get(local.id)?.audio_hash : null;
    if (hash && (await fed.streamFromPeers(hash, req, res))) return;
  } catch (e) {
    log.debug(`peer stream failed: ${e.message}`);
  }
  throw httpError(hasService(p) ? 503 : 404, hasService(p) ? `${p.name} can't be reached and no copy of this song is available elsewhere` : 'This song is not available anywhere right now');
}

async function cover(p, id, size, res) {
  const dir = path.join(PATHS.covers, p.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha256(`${id}:${size}`).slice(0, 32)}`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 86400e3) {
      const meta = fs.existsSync(`${file}.type`) ? fs.readFileSync(`${file}.type`, 'utf8') : 'image/jpeg';
      return res.set('Cache-Control', 'private, max-age=86400').type(meta).sendFile(file);
    }
  } catch {}
  if (id.startsWith('l:')) {
    const t = lib.byId(p.id, id.slice(2));
    if (!t) return res.status(404).end();
    const c = await tags.readCover(lib.absPath(p, t.path)).catch(() => null);
    if (!c) return res.status(404).end();
    return res.set('Cache-Control', 'private, max-age=3600').type(c.format).send(c.data);
  }
  if (!hasService(p)) return res.status(404).end();
  try {
    const r = await forProfile(p).cover(id, size || undefined);
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'image/jpeg';
    fs.writeFileSync(file, buf);
    fs.writeFileSync(`${file}.type`, type);
    res.set('Cache-Control', 'private, max-age=86400').type(type).send(buf);
  } catch {
    // Offline: an older cached copy is better than nothing.
    if (fs.existsSync(file)) return res.type(fs.existsSync(`${file}.type`) ? fs.readFileSync(`${file}.type`, 'utf8') : 'image/jpeg').sendFile(file);
    res.status(503).end();
  }
}

function parseLrc(text) {
  const lines = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:([+-]?\d+)\]/i);
    if (off) offset = Number(off[1]);
    const times = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const value = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of times) lines.push({ start: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), value });
  }
  lines.sort((a, b) => a.start - b.start);
  return { lang: 'xxx', synced: lines.length > 0, offset, lines, source: 'lrc' };
}

// ---- Navidrome smart playlist rules ----
export const SMART_FIELDS = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'album', label: 'Album', type: 'text' },
  { key: 'artist', label: 'Artist', type: 'text' },
  { key: 'albumartist', label: 'Album artist', type: 'text' },
  { key: 'genre', label: 'Genre', type: 'text' },
  { key: 'year', label: 'Year', type: 'number' },
  { key: 'tracknumber', label: 'Track number', type: 'number' },
  { key: 'discnumber', label: 'Disc number', type: 'number' },
  { key: 'duration', label: 'Length (seconds)', type: 'number' },
  { key: 'bitrate', label: 'Bitrate', type: 'number' },
  { key: 'bitdepth', label: 'Bit depth', type: 'number' },
  { key: 'bpm', label: 'BPM', type: 'number' },
  { key: 'channels', label: 'Channels', type: 'number' },
  { key: 'size', label: 'File size', type: 'number' },
  { key: 'filetype', label: 'File type', type: 'text' },
  { key: 'filepath', label: 'File path', type: 'text' },
  { key: 'comment', label: 'Comment', type: 'text' },
  { key: 'lyrics', label: 'Lyrics', type: 'text' },
  { key: 'mood', label: 'Mood', type: 'text' },
  { key: 'compilation', label: 'Compilation', type: 'bool' },
  { key: 'hascoverart', label: 'Has cover', type: 'bool' },
  { key: 'dateadded', label: 'Date added', type: 'date' },
  { key: 'datemodified', label: 'Date modified', type: 'date' },
  { key: 'loved', label: 'Loved (starred)', type: 'bool', service: true },
  { key: 'dateloved', label: 'Date loved', type: 'date', service: true },
  { key: 'playcount', label: 'Play count', type: 'number', service: true },
  { key: 'lastplayed', label: 'Last played', type: 'date', service: true },
  { key: 'rating', label: 'Rating', type: 'number', service: true },
  { key: 'albumrating', label: 'Album rating', type: 'number', service: true },
  { key: 'albumloved', label: 'Album loved', type: 'bool', service: true },
  { key: 'artistloved', label: 'Artist loved', type: 'bool', service: true },
  { key: 'catalognumber', label: 'Catalog number', type: 'text' },
  { key: 'releasetype', label: 'Release type', type: 'text' },
  { key: 'recordlabel', label: 'Record label', type: 'text' },
  { key: 'sorttitle', label: 'Sort title', type: 'text' },
  { key: 'discsubtitle', label: 'Disc subtitle', type: 'text' },
  { key: 'library_id', label: 'Library ID', type: 'number' },
];
export const SMART_OPERATORS = {
  text: ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith'],
  number: ['is', 'isNot', 'gt', 'lt', 'inTheRange'],
  date: ['before', 'after', 'inTheLast', 'notInTheLast', 'inTheRange'],
  bool: ['is', 'isNot'],
};
const NSP_TO_LOCAL = { tracknumber: 'track', discnumber: 'disc', filetype: 'ext', filepath: 'path', hascoverart: 'cover', dateadded: 'added', datemodified: 'modified', bitdepth: 'bits', recordlabel: 'label', sorttitle: 'titlesort' };

function compileNsp(rules) {
  let approximate = false;
  const node = (n) => {
    if (n.all) {
      const parts = n.all.map(node);
      return (t) => parts.every((p) => p(t));
    }
    if (n.any) {
      const parts = n.any.map(node);
      return (t) => parts.some((p) => p(t));
    }
    const [op, cond] = Object.entries(n)[0] || [];
    if (!op) return () => true;
    const [field, value] = Object.entries(cond || {})[0] || [];
    const def = SMART_FIELDS.find((f) => f.key === field);
    if (!def || def.service || op === 'inPlaylist' || op === 'notInPlaylist') {
      approximate = true;
      return () => true;
    }
    const k = NSP_TO_LOCAL[field] || field;
    const get = (t) => {
      const v = t[k];
      return Array.isArray(v) ? v.join(' ') : v;
    };
    const low = (v) => String(v ?? '').toLowerCase();
    const day = 86400e3;
    switch (op) {
      case 'is':
        return (t) => (def.type === 'bool' ? Boolean(get(t)) === Boolean(value) : low(get(t)) === low(value));
      case 'isNot':
        return (t) => (def.type === 'bool' ? Boolean(get(t)) !== Boolean(value) : low(get(t)) !== low(value));
      case 'contains':
        return (t) => low(get(t)).includes(low(value));
      case 'notContains':
        return (t) => !low(get(t)).includes(low(value));
      case 'startsWith':
        return (t) => low(get(t)).startsWith(low(value));
      case 'endsWith':
        return (t) => low(get(t)).endsWith(low(value));
      case 'gt':
        return (t) => Number(get(t)) > Number(value);
      case 'lt':
        return (t) => Number(get(t)) < Number(value);
      case 'inTheRange':
        return (t) => {
          const v = def.type === 'date' ? Number(get(t)) : Number(get(t));
          const [a, b] = def.type === 'date' ? value.map((x) => Date.parse(x)) : value.map(Number);
          return v >= a && v <= b;
        };
      case 'before':
        return (t) => Number(get(t)) < Date.parse(value);
      case 'after':
        return (t) => Number(get(t)) > Date.parse(value);
      case 'inTheLast':
        return (t) => Number(get(t)) > Date.now() - Number(value) * day;
      case 'notInTheLast':
        return (t) => !(Number(get(t)) > Date.now() - Number(value) * day);
      default:
        approximate = true;
        return () => true;
    }
  };
  const test = node({ all: rules.all, any: rules.any, ...(rules.all || rules.any ? {} : { all: [] }) });
  return { test, approximate };
}
export { compile };
