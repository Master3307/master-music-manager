// Profiles = a music service account (Navidrome / OpenSubsonic / Jellyfin),
// a local folder, or both linked together. Everything the UI shows goes
// through `forProfile(p)`, which hides the differences between the services.
import fs from 'node:fs';
import path from 'node:path';
import * as sub from './subsonic.js';
import * as jf from './jellyfin.js';
import { ServiceError } from './subsonic.js';
import { db, now, audit } from '../db.js';
import { seal, unseal, uuid } from '../lib/crypto.js';
import { httpError, json, str, bool } from '../lib/http.js';
import { requireUser, requireAdmin } from '../auth.js';
import { log } from '../lib/log.js';

export const KINDS = {
  navidrome: { label: 'Navidrome', port: 4533 },
  subsonic: { label: 'OpenSubsonic', port: 4040 },
  jellyfin: { label: 'Jellyfin', port: 8096 },
  local: { label: 'Local folder only' },
};

/** What each kind can do. The UI hides what is missing and explains why. */
export function features(p, info = {}) {
  const ext = new Set((info.extensions || []).map((e) => e.name));
  if (p.kind === 'local' || !p.url) return { service: false };
  const common = { service: true, playlists: true, favorites: true, scan: true, stream: true, lyrics: true, search: true, similar: true };
  if (p.kind === 'jellyfin')
    return { ...common, ratings: false, likes: true, radio: false, shares: false, smart: false, podcasts: false, bookmarks: false, queue: false, fullScan: true, nowPlaying: true };
  return {
    ...common,
    ratings: true,
    radio: true,
    shares: true,
    podcasts: true,
    bookmarks: true,
    queue: true,
    nowPlaying: true,
    smart: p.kind === 'navidrome',
    native: p.kind === 'navidrome',
    fullScan: p.kind === 'navidrome',
    plugin: p.kind === 'navidrome',
    songLyrics: ext.has('songLyrics'),
    transcodeOffset: ext.has('transcodeOffset'),
    multipleGenres: ext.size > 0,
  };
}

export const getProfile = (id) => db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);

export function visibleProfiles(user) {
  if (!user) return [];
  if (user.role === 'admin') return db.prepare('SELECT * FROM profiles ORDER BY sort, created_at').all();
  return db.prepare('SELECT * FROM profiles WHERE owner_id IS NULL OR owner_id = ? ORDER BY sort, created_at').all(user.id);
}

export function canUse(user, p) {
  if (!p || !user) return false;
  return user.role === 'admin' || !p.owner_id || p.owner_id === user.id;
}

const clients = new Map();
export function clientFor(p) {
  if (!p.url || p.kind === 'local') throw httpError(400, 'This profile has no music service');
  const key = `${p.id}:${p.secret}:${p.url}:${p.username}`;
  if (!clients.has(key)) {
    const secret = unseal(p.secret);
    clients.set(key, p.kind === 'jellyfin' ? { kind: 'jellyfin', c: jf.client(p, secret) } : { kind: 'subsonic', c: sub.client(p, secret) });
  }
  return clients.get(key);
}

// ---- Health: offline servers are shown as offline, never removed ----
const health = new Map();
export async function status(p, { fresh = false } = {}) {
  if (!p.url || p.kind === 'local') return { online: null, checkedAt: now() };
  const cached = health.get(p.id);
  if (!fresh && cached && now() - cached.checkedAt < 30_000) return cached;
  const started = now();
  let result;
  try {
    const info = await clientFor(p).c.ping();
    result = { online: true, ...info, latency: now() - started, checkedAt: now() };
  } catch (e) {
    result = { online: false, offline: e.offline !== false, error: e.message, checkedAt: now() };
  }
  health.set(p.id, result);
  return result;
}
export const lastStatus = (id) => health.get(id) || null;

export function publicProfile(p) {
  const h = health.get(p.id);
  const opts = JSON.parse(p.options || '{}');
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    kindLabel: KINDS[p.kind]?.label || p.kind,
    url: p.url,
    publicUrl: p.public_url,
    username: p.username,
    hasSecret: Boolean(p.secret),
    localPath: p.local_path,
    linkCheckedAt: p.link_checked_at,
    linkScore: p.link_score,
    owner: p.owner_id,
    shared: !p.owner_id,
    options: opts,
    status: h || null,
    features: features(p, h || {}),
  };
}

/** Wrap a service call so an unreachable server becomes a 503 with a clear message. */
async function svc(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ServiceError) throw httpError(e.offline ? 503 : 502, e.message, { offline: e.offline });
    throw e;
  }
}

// ---- The unified API ----
export function forProfile(p) {
  const { kind, c } = clientFor(p);
  if (kind === 'jellyfin') return jellyfinFacade(p, c);
  return subsonicFacade(p, c);
}

function subsonicFacade(p, c) {
  const s = sub;
  return {
    kind: p.kind,
    c,
    async songs({ query = '', offset = 0, size = 200 } = {}) {
      const r = await c.call('search3', { query: query || '""', songCount: size, songOffset: offset, artistCount: 0, albumCount: 0 });
      return (r.searchResult3?.song || []).map(s.song);
    },
    async *allSongs() {
      for (let offset = 0; ; offset += 500) {
        const r = await c.call('search3', { query: '""', songCount: 500, songOffset: offset, artistCount: 0, albumCount: 0 }, { timeout: 60000 });
        const list = r.searchResult3?.song || [];
        yield list.map(s.song);
        if (list.length < 500) break;
      }
    },
    async search(query, n = 20) {
      const r = await c.call('search3', { query, songCount: n, artistCount: Math.ceil(n / 2), albumCount: Math.ceil(n / 2) });
      const x = r.searchResult3 || {};
      return { songs: (x.song || []).map(s.song), albums: (x.album || []).map(s.album), artists: (x.artist || []).map(s.artist) };
    },
    async albums({ type = 'newest', size = 60, offset = 0, genre, fromYear, toYear } = {}) {
      const r = await c.call('getAlbumList2', { type, size, offset, genre, fromYear, toYear });
      return (r.albumList2?.album || []).map(s.album);
    },
    async album(id) {
      const r = await c.call('getAlbum', { id });
      let info = null;
      try {
        info = (await c.call('getAlbumInfo2', { id })).albumInfo || null;
      } catch {}
      return { ...s.album(r.album), info };
    },
    async artists() {
      const r = await c.call('getArtists');
      return (r.artists?.index || []).flatMap((i) => i.artist || []).map(s.artist);
    },
    async artist(id) {
      const r = await c.call('getArtist', { id });
      const a = s.artist(r.artist);
      let info = null;
      let top = [];
      try {
        info = (await c.call('getArtistInfo2', { id, count: 12 })).artistInfo2 || null;
      } catch {}
      try {
        top = ((await c.call('getTopSongs', { artist: a.name, count: 10 })).topSongs?.song || []).map(s.song);
      } catch {}
      return { ...a, info, top };
    },
    async song(id) {
      return s.song((await c.call('getSong', { id })).song);
    },
    async genres() {
      return ((await c.call('getGenres')).genres?.genre || []).map((g) => ({ name: g.value, songCount: g.songCount, albumCount: g.albumCount }));
    },
    async random(size = 50, genre) {
      return ((await c.call('getRandomSongs', { size, genre })).randomSongs?.song || []).map(s.song);
    },
    async starred() {
      const r = (await c.call('getStarred2')).starred2 || {};
      return { songs: (r.song || []).map(s.song), albums: (r.album || []).map(s.album), artists: (r.artist || []).map(s.artist) };
    },
    async star(ids, type = 'song', on = true) {
      const key = type === 'album' ? 'albumId' : type === 'artist' ? 'artistId' : 'id';
      await c.call(on ? 'star' : 'unstar', { [key]: ids });
    },
    async rate(id, rating) {
      await c.call('setRating', { id, rating });
    },
    async scrobble(id, { time, submission = true } = {}) {
      await c.call('scrobble', { id, time, submission });
    },
    async playlists() {
      return ((await c.call('getPlaylists')).playlists?.playlist || []).map(s.playlist);
    },
    async playlist(id) {
      return s.playlist((await c.call('getPlaylist', { id })).playlist);
    },
    async createPlaylist(name, songIds = []) {
      const r = await c.call('createPlaylist', { name, songId: songIds });
      return s.playlist(r.playlist);
    },
    async updatePlaylist(id, { name, comment, public: isPublic, add = [], removeIndexes = [] } = {}) {
      await c.call('updatePlaylist', { playlistId: id, name, comment, public: isPublic, songIdToAdd: add, songIndexToRemove: removeIndexes });
    },
    async replacePlaylist(id, songIds) {
      // createPlaylist with an id replaces the song list in one call.
      await c.call('createPlaylist', { playlistId: id, songId: songIds });
    },
    async deletePlaylist(id) {
      await c.call('deletePlaylist', { id });
    },
    async radios() {
      return ((await c.call('getInternetRadioStations')).internetRadioStations?.internetRadioStation || []).map((r) => ({
        id: r.id,
        name: r.name,
        streamUrl: r.streamUrl,
        homepageUrl: r.homePageUrl || r.homepageUrl,
      }));
    },
    async saveRadio({ id, name, streamUrl, homepageUrl }) {
      if (id) await c.call('updateInternetRadioStation', { id, name, streamUrl, homepageUrl });
      else await c.call('createInternetRadioStation', { name, streamUrl, homepageUrl });
    },
    async deleteRadio(id) {
      await c.call('deleteInternetRadioStation', { id });
    },
    async shares() {
      return ((await c.call('getShares')).shares?.share || []).map((x) => ({
        id: x.id,
        url: x.url,
        description: x.description,
        username: x.username,
        created: x.created,
        expires: x.expires,
        lastVisited: x.lastVisited,
        visitCount: x.visitCount,
        songs: (x.entry || []).map(s.song),
      }));
    },
    async createShare(ids, { description, expires } = {}) {
      const r = await c.call('createShare', { id: ids, description, expires });
      return r.shares?.share?.[0] || null;
    },
    async updateShare(id, { description, expires }) {
      await c.call('updateShare', { id, description, expires });
    },
    async deleteShare(id) {
      await c.call('deleteShare', { id });
    },
    async scan(full = false) {
      const r = await c.call('startScan', full ? { fullScan: true } : {});
      return r.scanStatus;
    },
    async scanStatus() {
      return (await c.call('getScanStatus')).scanStatus;
    },
    async lyrics(song) {
      try {
        const r = await c.call('getLyricsBySongId', { id: song.id });
        const list = r.lyricsList?.structuredLyrics || [];
        if (list.length) return list.map((l) => ({ lang: l.lang, synced: l.synced, offset: l.offset, lines: l.line || [] }));
      } catch {}
      const r = await c.call('getLyrics', { artist: song.artist, title: song.title });
      return r.lyrics?.value ? [{ lang: 'xxx', synced: false, lines: r.lyrics.value.split('\n').map((value) => ({ value })) }] : [];
    },
    async similar(id, count = 30) {
      return ((await c.call('getSimilarSongs2', { id, count })).similarSongs2?.song || []).map(s.song);
    },
    async nowPlaying() {
      return ((await c.call('getNowPlaying')).nowPlaying?.entry || []).map((e) => ({ ...s.song(e), username: e.username, minutesAgo: e.minutesAgo, playerName: e.playerName }));
    },
    async folders() {
      return (await c.call('getMusicFolders')).musicFolders?.musicFolder || [];
    },
    async directory(id) {
      if (!id) {
        const r = await c.call('getIndexes');
        return { id: null, name: 'Library', children: (r.indexes?.index || []).flatMap((i) => i.artist || []).map((a) => ({ id: a.id, title: a.name, isDir: true })) };
      }
      const r = (await c.call('getMusicDirectory', { id })).directory;
      return { id: r.id, name: r.name, parent: r.parent, children: (r.child || []).map((x) => (x.isDir ? { id: x.id, title: x.title, isDir: true, coverArt: x.coverArt } : s.song(x))) };
    },
    async queue() {
      return (await c.call('getPlayQueue')).playQueue || null;
    },
    async saveQueue(ids, current, position) {
      await c.call('savePlayQueue', { id: ids, current, position });
    },
    stream: (id, range, params) => fetch(c.streamUrl(id, params), { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(30000) }),
    cover: (id, size) => fetch(c.coverUrl(id, size), { signal: AbortSignal.timeout(20000) }),
  };
}

function jellyfinFacade(p, c) {
  const toSong = jf.song;
  const map = (r) => r.items.map((i) => toSong(i));
  const userId = p.user_id;
  return {
    kind: 'jellyfin',
    c,
    async songs({ query = '', offset = 0, size = 200 } = {}) {
      return map(await c.items({ IncludeItemTypes: 'Audio', SearchTerm: query, StartIndex: offset, Limit: size, SortBy: 'SortName' }));
    },
    async *allSongs() {
      for (let offset = 0; ; offset += 500) {
        const r = await c.items({ IncludeItemTypes: 'Audio', StartIndex: offset, Limit: 500, SortBy: 'SortName' });
        yield map(r);
        if (r.items.length < 500) break;
      }
    },
    async search(query, n = 20) {
      const [songs, albums, artists] = await Promise.all([
        c.items({ IncludeItemTypes: 'Audio', SearchTerm: query, Limit: n }),
        c.items({ IncludeItemTypes: 'MusicAlbum', SearchTerm: query, Limit: n }),
        c.get('/Artists', { userId, SearchTerm: query, Limit: n }),
      ]);
      return { songs: map(songs), albums: albums.items.map(jf.album), artists: (artists.Items || []).map((a) => ({ id: a.Id, name: a.Name, coverArt: a.ImageTags?.Primary ? a.Id : null })) };
    },
    async albums({ type = 'newest', size = 60, offset = 0, genre } = {}) {
      const sort = { newest: 'DateCreated', recent: 'DatePlayed', frequent: 'PlayCount', random: 'Random', alphabeticalByName: 'SortName', alphabeticalByArtist: 'AlbumArtist', byYear: 'ProductionYear' }[type] || 'DateCreated';
      const order = ['alphabeticalByName', 'alphabeticalByArtist'].includes(type) ? 'Ascending' : 'Descending';
      const filters = type === 'starred' ? 'IsFavorite' : undefined;
      return (await c.items({ IncludeItemTypes: 'MusicAlbum', SortBy: sort, SortOrder: order, StartIndex: offset, Limit: size, Genres: genre, Filters: filters })).items.map(jf.album);
    },
    async album(id) {
      const a = await c.get(`/Items/${id}`, { userId, Fields: FIELDS_ALL });
      const songs = await c.items({ ParentId: id, IncludeItemTypes: 'Audio', SortBy: 'ParentIndexNumber,IndexNumber' });
      return { ...jf.album(a), songs: map(songs), info: a.Overview ? { notes: a.Overview } : null };
    },
    async artists() {
      const r = await c.get('/Artists/AlbumArtists', { userId, Fields: 'ChildCount' });
      return (r.Items || []).map((a) => ({ id: a.Id, name: a.Name, albumCount: a.AlbumCount || a.ChildCount, coverArt: a.ImageTags?.Primary ? a.Id : null }));
    },
    async artist(id) {
      const a = await c.get(`/Items/${id}`, { userId, Fields: 'Overview' });
      const albums = await c.items({ IncludeItemTypes: 'MusicAlbum', AlbumArtistIds: id, SortBy: 'ProductionYear', SortOrder: 'Descending' });
      return { id: a.Id, name: a.Name, coverArt: a.ImageTags?.Primary ? a.Id : null, albums: albums.items.map(jf.album), info: a.Overview ? { biography: a.Overview } : null, top: [] };
    },
    async song(id) {
      return toSong(await c.get(`/Items/${id}`, { userId, Fields: FIELDS_ALL }));
    },
    async genres() {
      const r = await c.get('/MusicGenres', { userId });
      return (r.Items || []).map((g) => ({ name: g.Name, songCount: g.SongCount, albumCount: g.AlbumCount }));
    },
    async random(size = 50, genre) {
      return map(await c.items({ IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: size, Genres: genre }));
    },
    async starred() {
      const [songs, albums] = await Promise.all([c.items({ IncludeItemTypes: 'Audio', Filters: 'IsFavorite' }), c.items({ IncludeItemTypes: 'MusicAlbum', Filters: 'IsFavorite' })]);
      return { songs: map(songs), albums: albums.items.map(jf.album), artists: [] };
    },
    async star(ids, _type, on = true) {
      for (const id of [].concat(ids)) await c.send(on ? 'POST' : 'DELETE', `/UserFavoriteItems/${id}`, { userId });
    },
    async rate(id, rating) {
      // Jellyfin only knows like / dislike.
      if (rating >= 4) await c.send('POST', `/UserItems/${id}/Rating`, { userId, likes: true });
      else if (rating > 0 && rating <= 2) await c.send('POST', `/UserItems/${id}/Rating`, { userId, likes: false });
      else await c.send('DELETE', `/UserItems/${id}/Rating`, { userId });
    },
    async scrobble(id, { time } = {}) {
      await c.send('POST', `/UserPlayedItems/${id}`, { userId, datePlayed: time ? new Date(time).toISOString() : undefined });
    },
    async playlists() {
      const r = await c.items({ IncludeItemTypes: 'Playlist', Fields: 'ChildCount,DateCreated' });
      return r.items.map((x) => ({ id: x.Id, name: x.Name, songCount: x.ChildCount, duration: x.RunTimeTicks ? Math.round(x.RunTimeTicks / jf.TICKS_PER_SECOND) : null, coverArt: x.ImageTags?.Primary ? x.Id : null, created: x.DateCreated }));
    },
    async playlist(id) {
      const meta = await c.get(`/Items/${id}`, { userId });
      const r = await c.get(`/Playlists/${id}/Items`, { userId, Fields: FIELDS_ALL });
      return { id, name: meta.Name, songCount: r.TotalRecordCount, songs: (r.Items || []).map((i) => ({ ...toSong(i), entryId: i.PlaylistItemId })) };
    },
    async createPlaylist(name, songIds = []) {
      const r = await c.send('POST', '/Playlists', null, { Name: name, Ids: songIds, UserId: userId, MediaType: 'Audio' });
      return { id: r.Id, name };
    },
    async updatePlaylist(id, { name, add = [], removeIndexes = [] } = {}) {
      if (name) await c.send('POST', `/Playlists/${id}`, null, { Name: name });
      if (add.length) await c.send('POST', `/Playlists/${id}/Items`, { ids: add.join(','), userId });
      if (removeIndexes.length) {
        const pl = await this.playlist(id);
        const entryIds = removeIndexes.map((i) => pl.songs[i]?.entryId).filter(Boolean);
        if (entryIds.length) await c.send('DELETE', `/Playlists/${id}/Items`, { entryIds: entryIds.join(',') });
      }
    },
    async replacePlaylist(id, songIds) {
      const pl = await this.playlist(id);
      const entryIds = pl.songs.map((x) => x.entryId).filter(Boolean);
      if (entryIds.length) await c.send('DELETE', `/Playlists/${id}/Items`, { entryIds: entryIds.join(',') });
      if (songIds.length) await c.send('POST', `/Playlists/${id}/Items`, { ids: songIds.join(','), userId });
    },
    async deletePlaylist(id) {
      await c.send('DELETE', `/Items/${id}`);
    },
    async scan() {
      await c.send('POST', '/Library/Refresh');
      return { scanning: true };
    },
    async scanStatus() {
      const tasks = await c.get('/ScheduledTasks');
      const t = (tasks || []).find((x) => x.Key === 'RefreshLibrary');
      return { scanning: t?.State === 'Running', progress: t?.CurrentProgressPercentage };
    },
    async lyrics(song) {
      try {
        const r = await c.get(`/Audio/${song.id}/Lyrics`);
        const synced = r.Lyrics?.some((l) => l.Start != null);
        return [{ lang: r.Metadata?.Language || 'xxx', synced, lines: (r.Lyrics || []).map((l) => ({ start: l.Start != null ? Math.round(l.Start / 10000) : undefined, value: l.Text })) }];
      } catch {
        return [];
      }
    },
    async similar(id, count = 30) {
      const r = await c.get(`/Items/${id}/Similar`, { userId, Limit: count });
      return (r.Items || []).map((i) => toSong(i));
    },
    async nowPlaying() {
      const sessions = await c.get('/Sessions', { activeWithinSeconds: 600 });
      return (sessions || []).filter((x) => x.NowPlayingItem?.Type === 'Audio').map((x) => ({ ...toSong(x.NowPlayingItem), username: x.UserName, playerName: x.Client }));
    },
    async folders() {
      const r = await c.get('/Library/MediaFolders');
      return (r.Items || []).filter((x) => x.CollectionType === 'music').map((x) => ({ id: x.Id, name: x.Name }));
    },
    async directory(id) {
      const r = await c.get('/Items', { userId, ParentId: id, Fields: FIELDS_ALL, SortBy: 'IsFolder,SortName' });
      return { id, children: (r.Items || []).map((x) => (x.IsFolder ? { id: x.Id, title: x.Name, isDir: true } : toSong(x))) };
    },
    radios: notSupported('Jellyfin has no internet radio'),
    saveRadio: notSupported('Jellyfin has no internet radio'),
    deleteRadio: notSupported('Jellyfin has no internet radio'),
    shares: async () => [],
    createShare: notSupported('Jellyfin has no public share links. Master Music Manager shares still work.'),
    updateShare: notSupported('Jellyfin has no public share links'),
    deleteShare: notSupported('Jellyfin has no public share links'),
    queue: async () => null,
    saveQueue: async () => {},
    stream: (id, range) => fetch(c.streamUrl(id), { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(30000) }),
    cover: (id, size) => fetch(c.coverUrl(id, size), { signal: AbortSignal.timeout(20000) }),
  };
}
const FIELDS_ALL = 'Path,Genres,DateCreated,MediaSources,ProviderIds,ParentId,UserData,Overview';
const notSupported = (msg) => async () => {
  throw httpError(501, msg);
};

/** Check a login without saving anything (used by the login page). */
export async function verifyLogin(base, username, password) {
  if (base.kind === 'jellyfin') {
    const r = await jf.login(base, username, password);
    return { id: r.userId, name: r.name, admin: r.admin, userId: r.userId, secret: r.token };
  }
  const c = sub.client({ ...base, username }, password);
  await c.ping();
  let admin = false;
  try {
    const u = (await c.call('getUser', { username })).user;
    admin = Boolean(u?.adminRole);
  } catch {}
  return { id: username.toLowerCase(), name: username, admin };
}

// ---- Linking a local folder to a service ----
const MEDIA_EXT = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|wv|ape|wma|aiff?|alac|dsf|dff|mpc|m4b|mka|webm|mp4)$/i;

/**
 * Compare what the service reports with what's on disk. Navidrome reports
 * library-relative paths; Jellyfin absolute ones from its own machine, so we
 * find the longest suffix that exists under the folder and remember the prefix.
 */
export async function checkLink(p, folder) {
  if (!folder) throw httpError(400, 'Pick a folder');
  const abs = path.resolve(folder);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw httpError(400, `${abs} is not a folder this server can see`);
  let sample = [];
  try {
    const s = forProfile(p);
    if (p.kind === 'navidrome') {
      // Native API: real library-relative paths (Subsonic may report made-up ones).
      try {
        const total = (await s.random(1)).length ? 5000 : 0;
        const start = Math.floor(Math.random() * Math.max(1, total - 200));
        sample = (await s.c.native('song', { query: { _start: start, _end: start + 200, _sort: 'title' } })) || [];
        if (sample.length < 20) sample = (await s.c.native('song', { query: { _start: 0, _end: 200 } })) || [];
        sample = sample.sort(() => Math.random() - 0.5).slice(0, 60);
      } catch {
        sample = await s.random(60);
      }
    } else sample = await s.random(60);
  } catch (e) {
    throw httpError(503, `Can't check the link while ${p.name} is unreachable: ${e.message}`);
  }
  if (!sample.length) return { ok: false, score: 0, checked: 0, found: 0, abs, reason: 'The service returned no songs to compare with.' };
  let found = 0;
  let prefix = null;
  const misses = [];
  for (const s of sample) {
    if (!s.path) continue;
    const parts = s.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let hit = false;
    for (let i = 0; i < parts.length; i++) {
      const rel = parts.slice(i).join('/');
      if (fs.existsSync(path.join(abs, rel))) {
        hit = true;
        if (i > 0 && !prefix) prefix = `/${parts.slice(0, i).join('/')}`;
        break;
      }
    }
    if (!hit) hit = byName(abs, s);
    if (hit) found++;
    else if (misses.length < 5) misses.push(s.path);
  }
  const checked = sample.filter((s) => s.path).length;
  if (!checked) return { ok: false, score: 0, checked: 0, found: 0, abs, reason: 'The service does not report file paths. In Navidrome, turn on "Report real path" for this player, or link by folder name.' };
  const score = found / checked;
  return { ok: score >= 0.6, score, checked, found, abs, remotePrefix: prefix, misses, reason: score >= 0.6 ? null : `Only ${found} of ${checked} songs the service knows were found in ${abs}.` };
}

// Fallback when the reported path is made up: look for "<album>/…<title>…" in the folder.
const nameCache = new Map();
function byName(root, s) {
  if (!s.title) return false;
  let names = nameCache.get(root);
  if (!names || Date.now() - names.at > 120_000) {
    const list = [];
    const walk = (dir, depth) => {
      if (depth > 6 || list.length > 300_000) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (MEDIA_EXT.test(e.name)) list.push(full.slice(root.length + 1).toLowerCase());
      }
    };
    walk(root, 0);
    names = { at: Date.now(), list };
    nameCache.set(root, names);
  }
  const title = s.title.toLowerCase();
  const album = (s.album || '').toLowerCase();
  return names.list.some((n) => n.includes(title) && (!album || n.includes(album)));
}

// ---- Auto-detection of local servers ----
export async function detect() {
  const found = [];
  const add = (x) => !found.some((f) => f.url === x.url) && found.push(x);
  // Navidrome config files and environment.
  for (const file of ['/etc/navidrome/navidrome.toml', '/var/lib/navidrome/navidrome.toml', '/opt/navidrome/navidrome.toml', `${process.env.HOME}/.config/navidrome/navidrome.toml`]) {
    try {
      const t = fs.readFileSync(file, 'utf8');
      const v = (k) => t.match(new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\n]+)["']?`, 'mi'))?.[1]?.trim();
      const port = v('Port') || '4533';
      const addr = v('Address') || '127.0.0.1';
      const host = addr === '0.0.0.0' || addr === '' ? '127.0.0.1' : addr;
      add({ kind: 'navidrome', url: `http://${host}:${port}${v('BaseUrl') || ''}`, musicFolder: v('MusicFolder'), dataFolder: v('DataFolder'), source: file, confidence: 'config' });
    } catch {}
  }
  if (process.env.ND_MUSICFOLDER) add({ kind: 'navidrome', url: `http://127.0.0.1:${process.env.ND_PORT || 4533}`, musicFolder: process.env.ND_MUSICFOLDER, source: 'environment', confidence: 'config' });
  // Ports on this machine.
  const probes = [
    { kind: 'navidrome', url: 'http://127.0.0.1:4533' },
    { kind: 'jellyfin', url: 'http://127.0.0.1:8096' },
    { kind: 'subsonic', url: 'http://127.0.0.1:4040' },
    { kind: 'subsonic', url: 'http://127.0.0.1:4747' }, // gonic
  ];
  await Promise.all(
    probes.map(async (pr) => {
      try {
        if (pr.kind === 'jellyfin') {
          const r = await fetch(`${pr.url}/System/Info/Public`, { signal: AbortSignal.timeout(1500) }).then((x) => x.json());
          add({ ...pr, name: r.ServerName, version: r.Version, source: 'port', confidence: 'found' });
        } else {
          const r = await fetch(`${pr.url}/rest/ping?f=json&v=1.16.1&c=mmm`, { signal: AbortSignal.timeout(1500) }).then((x) => x.json());
          const s = r['subsonic-response'];
          if (s) add({ ...pr, kind: s.type === 'navidrome' ? 'navidrome' : pr.kind, version: s.serverVersion, source: 'port', confidence: 'found' });
        }
      } catch {}
    }),
  );
  // Common music folders.
  const folders = ['/mnt/music', '/music', '/srv/music', '/data/music', '/media/music', `${process.env.HOME}/Music`].filter((f) => {
    try {
      return fs.statSync(f).isDirectory();
    } catch {
      return false;
    }
  });
  for (const f of found) if (f.musicFolder && !folders.includes(f.musicFolder)) folders.unshift(f.musicFolder);
  // Tools.
  const { execFileSync } = await import('node:child_process');
  const has = (bin) => {
    try {
      execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  const tools = Object.fromEntries(['ffmpeg', 'ffprobe', 'spotdl', 'yt-dlp', 'bsdtar', '7z', 'unzip', 'git'].map((b) => [b, has(b)]));
  // Where a brand-new music folder would go if someone has none yet.
  const os = await import('node:os');
  const suggestedNew = process.getuid?.() === 0 ? '/srv/music' : path.join(os.homedir(), 'Music');
  // Count music files at the top of each folder, so the choice is easy.
  const counted = folders.map((f) => {
    let n = 0;
    const walk = (d, depth) => {
      if (depth > 3 || n > 5000) return;
      let es = [];
      try {
        es = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of es) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        else if (MEDIA_EXT.test(e.name)) n++;
      }
    };
    walk(f, 0);
    return { path: f, songs: n, more: n > 5000 };
  });
  return { servers: found, folders, counted, tools, suggestedNew };
}

async function testProfile(body, existing) {
  const p = {
    id: existing?.id || 'test',
    kind: body.kind,
    url: str(body.url, 500).replace(/\/+$/, ''),
    username: str(body.username, 128),
    user_id: existing?.user_id,
  };
  if (p.kind === 'jellyfin') {
    if (body.password) {
      const r = await jf.login(p, p.username, body.password);
      p.user_id = r.userId;
      const info = await jf.client(p, r.token).ping();
      return { ok: true, info, secret: r.token, userId: r.userId };
    }
    const info = await jf.client(p, unseal(existing?.secret)).ping();
    return { ok: true, info };
  }
  const pw = body.password || unseal(existing?.secret);
  const info = await sub.client(p, pw).ping();
  // Navidrome identifies itself; correct the kind if needed.
  return { ok: true, info, kind: info.type === 'navidrome' ? 'navidrome' : p.kind === 'navidrome' && info.type && info.type !== 'navidrome' ? 'subsonic' : p.kind, secret: body.password || null };
}

export function register(app) {
  app.get('/api/detect', requireAdmin, json(() => detect()));

  app.get(
    '/api/profiles',
    requireUser,
    json(async (req) => {
      const list = visibleProfiles(req.user);
      await Promise.all(list.map((p) => status(p).catch(() => null)));
      return list.map(publicProfile);
    }),
  );

  app.post(
    '/api/profiles/test',
    requireUser,
    json(async (req) => {
      const existing = req.body.id ? getProfile(req.body.id) : null;
      if (existing && !canUse(req.user, existing)) throw httpError(403, 'Not yours');
      try {
        const r = await testProfile(req.body, existing);
        return { ok: true, info: r.info, kind: r.kind };
      } catch (e) {
        return { ok: false, offline: Boolean(e.offline), error: e.message };
      }
    }),
  );

  app.post(
    '/api/profiles',
    requireUser,
    json(async (req) => {
      const kind = KINDS[req.body.kind] ? req.body.kind : 'navidrome';
      const name = str(req.body.name, 80).trim() || KINDS[kind].label;
      const id = uuid();
      let secret = null;
      let userId = null;
      let finalKind = kind;
      let offline = false;
      if (kind !== 'local') {
        if (!req.body.url) throw httpError(400, 'Enter the server address');
        try {
          const r = await testProfile(req.body);
          secret = r.secret;
          userId = r.userId || null;
          finalKind = r.kind || kind;
        } catch (e) {
          // An offline server can still be added; we'll tell the user it can't be reached.
          if (!e.offline || !bool(req.body.saveOffline)) throw httpError(e.offline ? 503 : 400, e.message, { offline: e.offline });
          offline = true;
          secret = req.body.password || null;
        }
      }
      if (kind === 'local' && !req.body.localPath) throw httpError(400, 'Pick the music folder');
      if (kind === 'local' && bool(req.body.createFolder)) fs.mkdirSync(path.resolve(req.body.localPath), { recursive: true });
      if (kind === 'local' && !fs.existsSync(path.resolve(req.body.localPath))) throw httpError(400, `${req.body.localPath} doesn't exist on the machine Master Music Manager runs on`);
      db.prepare(
        'INSERT INTO profiles (id, name, kind, url, public_url, username, secret, user_id, local_path, options, owner_id, created_at, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM profiles))',
      ).run(
        id,
        name,
        finalKind,
        kind === 'local' ? null : str(req.body.url, 500).replace(/\/+$/, ''),
        str(req.body.publicUrl, 500).replace(/\/+$/, '') || null,
        kind === 'local' ? null : str(req.body.username, 128),
        secret ? seal(secret) : null,
        userId,
        kind === 'local' ? path.resolve(req.body.localPath) : null,
        JSON.stringify(req.body.options || {}),
        req.user.role === 'admin' && !bool(req.body.private) ? null : req.user.id,
        now(),
      );
      audit(req.user.id, 'profile.create', { id, kind: finalKind, name });
      const p = getProfile(id);
      if (!offline) await status(p, { fresh: true });
      // A folder is read right away, so the music shows up by itself.
      let scanJob = null;
      if (p.local_path) scanJob = (await import('../library/index.js')).scan(p, { full: true, userId: req.user.id });
      return { ...publicProfile(p), offline, scanJob };
    }),
  );

  app.patch(
    '/api/profiles/:id',
    requireUser,
    json(async (req) => {
      const p = getProfile(req.params.id);
      if (!canUse(req.user, p) || (p.owner_id === null && req.user.role !== 'admin')) throw httpError(403, 'Only admins can change shared profiles');
      const b = req.body;
      const next = { ...p };
      if (b.name !== undefined) next.name = str(b.name, 80);
      if (b.url !== undefined) next.url = str(b.url, 500).replace(/\/+$/, '') || null;
      if (b.publicUrl !== undefined) next.public_url = str(b.publicUrl, 500).replace(/\/+$/, '') || null;
      if (b.username !== undefined) next.username = str(b.username, 128);
      if (b.options) next.options = JSON.stringify({ ...JSON.parse(p.options || '{}'), ...b.options });
      if (b.password || b.url !== undefined || b.username !== undefined) {
        if (next.url) {
          try {
            const r = await testProfile({ ...b, kind: p.kind, url: next.url, username: next.username }, p);
            if (r.secret) next.secret = seal(r.secret);
            if (r.userId) next.user_id = r.userId;
          } catch (e) {
            if (!e.offline) throw httpError(400, e.message);
            if (b.password) next.secret = seal(b.password);
          }
        }
      }
      // Removing the service turns the profile into a local one (and back).
      if (b.removeService) {
        if (!p.local_path) throw httpError(400, 'Link a folder first, or the profile would be empty');
        Object.assign(next, { kind: 'local', url: null, public_url: null, username: null, secret: null, user_id: null });
      }
      if (b.kind && b.kind !== 'local' && p.kind === 'local') next.kind = b.kind;
      db.prepare('UPDATE profiles SET name=?, kind=?, url=?, public_url=?, username=?, secret=?, user_id=?, options=? WHERE id=?').run(
        next.name,
        next.kind,
        next.url,
        next.public_url,
        next.username,
        next.secret,
        next.user_id,
        next.options,
        p.id,
      );
      health.delete(p.id);
      audit(req.user.id, 'profile.update', { id: p.id });
      const fresh = getProfile(p.id);
      await status(fresh, { fresh: true }).catch(() => null);
      return publicProfile(fresh);
    }),
  );

  app.post(
    '/api/profiles/:id/link',
    requireUser,
    json(async (req) => {
      const p = getProfile(req.params.id);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      if (req.user.role !== 'admin') throw httpError(403, 'Only admins can link folders');
      const folder = str(req.body.path, 1000);
      if (p.kind === 'local' || !p.url) {
        if (!fs.existsSync(folder)) throw httpError(400, `${folder} does not exist on this server`);
        db.prepare('UPDATE profiles SET local_path = ?, link_checked_at = ?, link_score = 1 WHERE id = ?').run(path.resolve(folder), now(), p.id);
        const scanJob = (await import('../library/index.js')).scan(getProfile(p.id), { full: true, userId: req.user.id });
        return { ...publicProfile(getProfile(p.id)), scanJob };
      }
      const r = await checkLink(p, folder);
      if (!r.ok && !bool(req.body.dryRun)) throw httpError(400, r.reason || 'The folder does not match the service', r);
      if (bool(req.body.dryRun)) return r;
      const opts = { ...JSON.parse(p.options || '{}'), remotePrefix: r.remotePrefix || null };
      db.prepare('UPDATE profiles SET local_path = ?, link_checked_at = ?, link_score = ?, options = ? WHERE id = ?').run(r.abs, now(), r.score, JSON.stringify(opts), p.id);
      // Profiles of people who logged in with this server share the link.
      db.prepare('UPDATE profiles SET local_path = ?, link_checked_at = ?, link_score = ?, options = ? WHERE url = ? AND owner_id IS NOT NULL').run(r.abs, now(), r.score, JSON.stringify(opts), p.url);
      audit(req.user.id, 'profile.link', { id: p.id, path: r.abs, score: r.score });
      const scanJob = (await import('../library/index.js')).scan(getProfile(p.id), { full: true, userId: req.user.id });
      return { ...publicProfile(getProfile(p.id)), check: r, scanJob };
    }),
  );

  app.delete(
    '/api/profiles/:id/link',
    requireAdmin,
    json((req) => {
      const p = getProfile(req.params.id);
      if (!p) throw httpError(404, 'No such profile');
      if (!p.url) throw httpError(400, 'A local profile needs its folder. Delete the profile instead.');
      db.prepare('UPDATE profiles SET local_path = NULL, link_checked_at = NULL, link_score = NULL WHERE id = ?').run(p.id);
      db.prepare('DELETE FROM tracks WHERE profile_id = ?').run(p.id);
      audit(req.user.id, 'profile.unlink', { id: p.id });
      return publicProfile(getProfile(p.id));
    }),
  );

  app.delete(
    '/api/profiles/:id',
    requireUser,
    json((req) => {
      const p = getProfile(req.params.id);
      if (!canUse(req.user, p) || (p.owner_id === null && req.user.role !== 'admin')) throw httpError(403, 'Only admins can remove shared profiles');
      db.prepare('DELETE FROM tracks WHERE profile_id = ?').run(p.id);
      db.prepare('DELETE FROM profiles WHERE id = ?').run(p.id);
      audit(req.user.id, 'profile.delete', { id: p.id, name: p.name });
      return { ok: true };
    }),
  );

  app.post(
    '/api/profiles/order',
    requireAdmin,
    json((req) => {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      ids.forEach((id, i) => db.prepare('UPDATE profiles SET sort = ? WHERE id = ?').run(i, id));
      return { ok: true };
    }),
  );

  app.get(
    '/api/profiles/:id/status',
    requireUser,
    json(async (req) => {
      const p = getProfile(req.params.id);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      return status(p, { fresh: true });
    }),
  );

  // Generic OpenSubsonic passthrough: any read or write method the server offers.
  app.all(
    '/api/p/:pid/rest/:method',
    requireUser,
    json(async (req) => {
      const p = getProfile(req.params.pid);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      const m = req.params.method.replace(/\.view$/, '');
      const write = sub.WRITE_METHODS.has(m);
      if (!sub.READ_METHODS.has(m) && !write) throw httpError(400, `${m} is not available through Master Music Manager`);
      if (write && req.method === 'GET') throw httpError(405, 'Use POST for changes');
      const { kind, c } = clientFor(p);
      if (kind !== 'subsonic') throw httpError(400, 'This is a Subsonic method; the profile is Jellyfin');
      return svc(() => c.call(m, { ...req.query, ...(req.method !== 'GET' ? req.body : {}) }));
    }),
  );

  // Jellyfin passthrough (GET only, for views we don't have yet).
  app.get(
    '/api/p/:pid/jf/*rest',
    requireUser,
    json(async (req) => {
      const p = getProfile(req.params.pid);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      const { kind, c } = clientFor(p);
      if (kind !== 'jellyfin') throw httpError(400, 'Not a Jellyfin profile');
      const rest = [].concat(req.params.rest).join('/');
      if (/^(Users\/[^/]+\/Policy|Auth|Startup|System\/Configuration)/i.test(rest)) throw httpError(403, 'Not available here');
      return svc(() => c.get(`/${rest}`, req.query));
    }),
  );

  log.info('services ready');
}

export { svc, ServiceError };
