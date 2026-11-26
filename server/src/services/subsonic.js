// OpenSubsonic client (Navidrome, Gonic, Airsonic, Ampache, LMS, ...).
// Auth uses the salted token scheme, so the password never travels; it lives
// sealed in the database and is only unsealed here.
import { md5, token as rnd } from '../lib/crypto.js';
import { VERSION } from '../config.js';

const CLIENT = 'MasterMusicManager';

export class ServiceError extends Error {
  constructor(message, { offline = false, code, status } = {}) {
    super(message);
    this.offline = offline;
    this.code = code;
    this.status = status;
  }
}

const base = (url) => String(url || '').replace(/\/+$/, '');

export function authParams(username, password) {
  const salt = rnd(9).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'mmmsalt01';
  return { u: username, t: md5(password + salt), s: salt, v: '1.16.1', c: CLIENT, f: 'json' };
}

export function restUrl(profile, password, method, params = {}) {
  const q = new URLSearchParams(authParams(profile.username, password));
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) q.append(k, String(x));
    else q.append(k, String(v));
  }
  return `${base(profile.url)}/rest/${method}?${q}`;
}

async function request(url, { timeout = 15000, raw = false, init = {} } = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeout), headers: { 'User-Agent': `${CLIENT}/${VERSION}`, ...(init.headers || {}) } });
  } catch (e) {
    throw new ServiceError(e.name === 'TimeoutError' ? 'The server did not answer in time' : `Can't reach the server (${e.cause?.code || e.message})`, { offline: true });
  }
  if (raw) return res;
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ServiceError(res.status >= 500 ? `The server answered with ${res.status}` : 'This does not look like a Subsonic server (no JSON answer)', { status: res.status });
  }
  const r = body['subsonic-response'];
  if (!r) throw new ServiceError('This does not look like a Subsonic server', { status: res.status });
  if (r.status !== 'ok') throw new ServiceError(r.error?.message || 'The server refused the request', { code: r.error?.code });
  return r;
}

export function client(profile, password) {
  const call = (method, params, opts) => request(restUrl(profile, password, method, params), opts);
  const raw = (method, params, init) => request(restUrl(profile, password, method, params), { raw: true, timeout: 60000, init });
  const isNavidrome = profile.kind === 'navidrome';
  let jwt = null;

  async function native(path, { method = 'GET', body, query } = {}) {
    if (!isNavidrome) throw new ServiceError('Only Navidrome has this API');
    const login = async () => {
      const r = await request(`${base(profile.url)}/auth/login`, {
        raw: true,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: profile.username, password }) },
      });
      if (!r.ok) throw new ServiceError('Navidrome refused the login');
      jwt = (await r.json()).token;
    };
    if (!jwt) await login();
    const url = `${base(profile.url)}/api/${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const go = () =>
      request(url, {
        raw: true,
        init: { method, headers: { 'x-nd-authorization': `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
      });
    let r = await go();
    if (r.status === 401) {
      await login();
      r = await go();
    }
    const fresh = r.headers.get('x-nd-authorization');
    if (fresh) jwt = fresh.replace(/^Bearer /, '');
    if (!r.ok) throw new ServiceError(`Navidrome answered ${r.status}: ${(await r.text()).slice(0, 200)}`, { status: r.status });
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  /** Upload an image to Navidrome's native API (playlist / artist covers; GIFs stay animated). */
  async function nativeImage(path, data, type, { remove = false } = {}) {
    if (!isNavidrome) throw new ServiceError('Only Navidrome stores uploaded images');
    if (!jwt) await native('keepalive/keepalive').catch(() => null);
    if (!jwt) await native('playlist', { query: { _end: 1 } });
    const url = `${base(profile.url)}/api/${path}/image`;
    let body;
    if (!remove) {
      body = new FormData();
      const ext = /gif/.test(type) ? 'gif' : /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : 'jpg';
      body.append('image', new Blob([data], { type }), `cover.${ext}`);
    }
    const r = await request(url, { raw: true, timeout: 60000, init: { method: remove ? 'DELETE' : 'POST', headers: { 'x-nd-authorization': `Bearer ${jwt}` }, body } });
    if (r.status === 403) throw new ServiceError('Navidrome refused: artwork upload is off for non-admins (EnableArtworkUpload)', { status: 403 });
    if (!r.ok) throw new ServiceError(`Navidrome answered ${r.status}: ${(await r.text()).slice(0, 200)}`, { status: r.status });
    return true;
  }

  return {
    call,
    raw,
    native,
    nativeImage,
    streamUrl: (id, params = {}) => restUrl(profile, password, 'stream', { id, ...params }),
    coverUrl: (id, size) => restUrl(profile, password, 'getCoverArt', { id, size }),
    async ping() {
      const r = await call('ping');
      let extensions = [];
      if (r.openSubsonic) {
        try {
          extensions = (await call('getOpenSubsonicExtensions')).openSubsonicExtensions || [];
        } catch {}
      }
      return { type: r.type || null, serverVersion: r.serverVersion || null, apiVersion: r.version, openSubsonic: Boolean(r.openSubsonic), extensions };
    },
  };
}

/** Normalize a Subsonic "child" into the song shape the UI uses everywhere. */
export function song(s) {
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    artist: s.displayArtist || s.artist,
    artists: s.artists?.map((a) => ({ id: a.id, name: a.name })) || (s.artistId ? [{ id: s.artistId, name: s.artist }] : []),
    album: s.album,
    albumId: s.albumId,
    albumArtist: s.displayAlbumArtist || s.albumArtists?.map((a) => a.name).join(' / ') || null,
    artistId: s.artistId,
    track: s.track,
    disc: s.discNumber,
    year: s.year,
    genre: s.genre,
    genres: s.genres?.map((g) => g.name) || (s.genre ? [s.genre] : []),
    duration: s.duration,
    bitRate: s.bitRate,
    bitDepth: s.bitDepth,
    sampleRate: s.samplingRate,
    channels: s.channelCount,
    size: s.size,
    suffix: s.suffix,
    contentType: s.contentType,
    path: s.path,
    coverArt: s.coverArt,
    starred: s.starred || null,
    rating: s.userRating || 0,
    playCount: s.playCount || 0,
    played: s.played || null,
    created: s.created,
    bpm: s.bpm,
    comment: s.comment,
    musicBrainzId: s.musicBrainzId,
    replayGain: s.replayGain,
    moods: s.moods,
    explicit: s.explicitStatus,
    isrc: s.isrc,
    contributors: s.contributors,
    mediaType: s.mediaType,
  };
}

export function album(a) {
  if (!a) return null;
  return {
    id: a.id,
    name: a.name || a.title || a.album,
    artist: a.displayArtist || a.artist,
    artistId: a.artistId,
    artists: a.artists?.map((x) => ({ id: x.id, name: x.name })) || [],
    year: a.year,
    genre: a.genre,
    genres: a.genres?.map((g) => g.name) || [],
    songCount: a.songCount,
    duration: a.duration,
    coverArt: a.coverArt,
    starred: a.starred || null,
    rating: a.userRating || 0,
    playCount: a.playCount || 0,
    created: a.created,
    played: a.played,
    releaseTypes: a.releaseTypes,
    recordLabels: a.recordLabels?.map((l) => l.name),
    isCompilation: a.isCompilation,
    musicBrainzId: a.musicBrainzId,
    songs: a.song?.map(song),
  };
}

export function artist(a) {
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    albumCount: a.albumCount,
    coverArt: a.coverArt,
    image: a.artistImageUrl,
    starred: a.starred || null,
    rating: a.userRating || 0,
    roles: a.roles,
    musicBrainzId: a.musicBrainzId,
    albums: a.album?.map(album),
  };
}

export function playlist(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    comment: p.comment,
    owner: p.owner,
    public: p.public,
    songCount: p.songCount,
    duration: p.duration,
    coverArt: p.coverArt,
    created: p.created,
    changed: p.changed,
    readonly: p.readonly,
    validUntil: p.validUntil,
    songs: p.entry?.map(song),
  };
}

// Methods the browser may call through the generic proxy. Everything a
// Subsonic / OpenSubsonic server offers, minus account administration that
// should go through the server's own UI.
export const READ_METHODS = new Set([
  'ping', 'getLicense', 'getOpenSubsonicExtensions', 'getMusicFolders', 'getIndexes', 'getMusicDirectory', 'getGenres', 'getArtists', 'getArtist',
  'getAlbum', 'getSong', 'getVideos', 'getVideoInfo', 'getArtistInfo', 'getArtistInfo2', 'getAlbumInfo', 'getAlbumInfo2', 'getSimilarSongs',
  'getSimilarSongs2', 'getTopSongs', 'getAlbumList', 'getAlbumList2', 'getRandomSongs', 'getSongsByGenre', 'getNowPlaying', 'getStarred', 'getStarred2',
  'search', 'search2', 'search3', 'getPlaylists', 'getPlaylist', 'getLyrics', 'getLyricsBySongId', 'getPodcasts', 'getNewestPodcasts', 'getPodcastEpisode',
  'getInternetRadioStations', 'getChatMessages', 'getUser', 'getUsers', 'getBookmarks', 'getPlayQueue', 'getPlayQueueByIndex', 'getShares', 'getScanStatus',
  'getTranscodeDecision', 'tokenInfo',
]);
export const WRITE_METHODS = new Set([
  'createPlaylist', 'updatePlaylist', 'deletePlaylist', 'star', 'unstar', 'setRating', 'scrobble', 'createShare', 'updateShare', 'deleteShare',
  'createInternetRadioStation', 'updateInternetRadioStation', 'deleteInternetRadioStation', 'refreshPodcasts', 'createPodcastChannel',
  'deletePodcastChannel', 'deletePodcastEpisode', 'downloadPodcastEpisode', 'createBookmark', 'deleteBookmark', 'savePlayQueue', 'savePlayQueueByIndex',
  'startScan', 'addChatMessage', 'jukeboxControl',
]);
