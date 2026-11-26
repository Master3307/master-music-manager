// Jellyfin (and Emby, which shares the API) client, normalized to the same
// shapes as the Subsonic client. We keep the access token, never the password.
import { ServiceError } from './subsonic.js';
import { VERSION } from '../config.js';

const base = (url) => String(url || '').replace(/\/+$/, '');
const TICKS = 10_000_000;
const FIELDS = 'Path,Genres,DateCreated,MediaSources,ProviderIds,ParentId,PrimaryImageAspectRatio,UserData,Overview';

export function authHeader(profileId, accessToken) {
  const parts = [`Client="Master Music Manager"`, `Device="Server"`, `DeviceId="mmm-${profileId}"`, `Version="${VERSION}"`];
  if (accessToken) parts.push(`Token="${accessToken}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

async function request(url, { method = 'GET', headers = {}, body, raw = false, timeout = 15000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new ServiceError(e.name === 'TimeoutError' ? 'The server did not answer in time' : `Can't reach the server (${e.cause?.code || e.message})`, { offline: true });
  }
  if (raw) return res;
  if (res.status === 401) throw new ServiceError('Jellyfin refused the login (token expired or revoked)', { status: 401 });
  if (!res.ok) throw new ServiceError(`Jellyfin answered ${res.status}`, { status: res.status });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function login(profile, username, password) {
  const r = await request(`${base(profile.url)}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { Authorization: authHeader(profile.id || 'login') },
    body: { Username: username, Pw: password },
  });
  return { token: r.AccessToken, userId: r.User?.Id, name: r.User?.Name, admin: Boolean(r.User?.Policy?.IsAdministrator) };
}

export function song(i, cover) {
  if (!i) return null;
  const src = i.MediaSources?.[0];
  return {
    id: i.Id,
    title: i.Name,
    artist: i.Artists?.join(' / ') || i.AlbumArtist,
    artists: (i.ArtistItems || []).map((a) => ({ id: a.Id, name: a.Name })),
    album: i.Album,
    albumId: i.AlbumId,
    albumArtist: i.AlbumArtist,
    artistId: i.ArtistItems?.[0]?.Id,
    track: i.IndexNumber,
    disc: i.ParentIndexNumber,
    year: i.ProductionYear,
    genre: i.Genres?.[0],
    genres: i.Genres || [],
    duration: i.RunTimeTicks ? Math.round(i.RunTimeTicks / TICKS) : null,
    bitRate: src?.Bitrate ? Math.round(src.Bitrate / 1000) : null,
    size: src?.Size,
    suffix: src?.Container,
    path: i.Path,
    coverArt: i.AlbumId && i.AlbumPrimaryImageTag ? i.AlbumId : i.ImageTags?.Primary ? i.Id : null,
    starred: i.UserData?.IsFavorite ? i.UserData.LastPlayedDate || true : null,
    rating: 0,
    playCount: i.UserData?.PlayCount || 0,
    played: i.UserData?.LastPlayedDate || null,
    created: i.DateCreated,
    musicBrainzId: i.ProviderIds?.MusicBrainzTrack,
    comment: i.Overview,
  };
}

export function album(i) {
  return {
    id: i.Id,
    name: i.Name,
    artist: i.AlbumArtist || i.Artists?.join(' / '),
    artistId: i.AlbumArtists?.[0]?.Id,
    artists: (i.AlbumArtists || []).map((a) => ({ id: a.Id, name: a.Name })),
    year: i.ProductionYear,
    genre: i.Genres?.[0],
    genres: i.Genres || [],
    songCount: i.ChildCount,
    duration: i.RunTimeTicks ? Math.round(i.RunTimeTicks / TICKS) : null,
    coverArt: i.ImageTags?.Primary ? i.Id : null,
    starred: i.UserData?.IsFavorite ? true : null,
    playCount: i.UserData?.PlayCount || 0,
    created: i.DateCreated,
  };
}

export function client(profile, accessToken) {
  const url = base(profile.url);
  const userId = profile.user_id;
  const headers = { Authorization: authHeader(profile.id, accessToken) };
  const get = (path, query) => request(`${url}${path}${query ? `?${new URLSearchParams(clean(query))}` : ''}`, { headers });
  const send = (method, path, query, body) => request(`${url}${path}${query ? `?${new URLSearchParams(clean(query))}` : ''}`, { method, headers, body });

  const items = async (query) => {
    const r = await get('/Items', { userId, Recursive: true, Fields: FIELDS, ...query });
    return { items: r.Items || [], total: r.TotalRecordCount || 0 };
  };

  return {
    headers,
    get,
    send,
    items,
    streamUrl: (id) => `${url}/Audio/${id}/stream?static=true&api_key=${encodeURIComponent(accessToken)}`,
    coverUrl: (id, size) => `${url}/Items/${id}/Images/Primary?quality=90${size ? `&maxWidth=${size}&maxHeight=${size}` : ''}&api_key=${encodeURIComponent(accessToken)}`,
    async ping() {
      const info = await get('/System/Info');
      return { type: info.ProductName || 'Jellyfin', serverVersion: info.Version, serverName: info.ServerName, openSubsonic: false, extensions: [] };
    },
    async me() {
      return get('/Users/Me');
    },
  };
}

function clean(q) {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export const TICKS_PER_SECOND = TICKS;
