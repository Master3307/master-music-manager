// External links for artists, albums and songs, found automatically.
// Search links are built without any network request; with privacy mode off,
// MusicBrainz relations add the exact pages (Spotify, Bandcamp, Wikipedia …).
import * as settings from './settings.js';
import { json, str } from './lib/http.js';
import { requireUser } from './auth.js';
import { VERSION } from './config.js';

const cache = new Map();
const UA = `MasterMusicManager/${VERSION} (https://github.com/Master3307/master-music-manager)`;
const q = encodeURIComponent;

const KNOWN = [
  [/open\.spotify\.com/, 'spotify', 'Spotify'],
  [/music\.apple\.com|itunes\.apple\.com/, 'apple', 'Apple Music'],
  [/bandcamp\.com/, 'bandcamp', 'Bandcamp'],
  [/soundcloud\.com/, 'soundcloud', 'SoundCloud'],
  [/youtube\.com|youtu\.be/, 'youtube', 'YouTube'],
  [/deezer\.com/, 'deezer', 'Deezer'],
  [/tidal\.com/, 'tidal', 'Tidal'],
  [/wikipedia\.org/, 'wikipedia', 'Wikipedia'],
  [/wikidata\.org/, 'wikidata', 'Wikidata'],
  [/discogs\.com/, 'discogs', 'Discogs'],
  [/instagram\.com/, 'instagram', 'Instagram'],
  [/twitter\.com|x\.com/, 'x', 'X'],
  [/genius\.com/, 'genius', 'Genius'],
  [/last\.fm/, 'lastfm', 'Last.fm'],
  [/allmusic\.com/, 'allmusic', 'AllMusic'],
  [/rateyourmusic\.com/, 'rym', 'Rate Your Music'],
];

function searchLinks(kind, { name, artist, title, mbid }) {
  const term = kind === 'artist' ? name : `${artist || ''} ${title || name || ''}`.trim();
  const links = [];
  if (kind === 'artist') links.push({ id: 'lastfm', label: 'Last.fm', url: `https://www.last.fm/music/${q(name).replace(/%20/g, '+')}` });
  else if (kind === 'album') links.push({ id: 'lastfm', label: 'Last.fm', url: `https://www.last.fm/music/${q(artist || '').replace(/%20/g, '+')}/${q(name || '').replace(/%20/g, '+')}` });
  else links.push({ id: 'lastfm', label: 'Last.fm', url: `https://www.last.fm/music/${q(artist || '').replace(/%20/g, '+')}/_/${q(title || '').replace(/%20/g, '+')}` });
  if (mbid) {
    const t = { artist: 'artist', album: 'release', track: 'recording' }[kind];
    links.push({ id: 'musicbrainz', label: 'MusicBrainz', url: `https://musicbrainz.org/${t}/${mbid}` });
    if (kind === 'artist') links.push({ id: 'listenbrainz', label: 'ListenBrainz', url: `https://listenbrainz.org/artist/${mbid}/` });
  } else links.push({ id: 'musicbrainz', label: 'MusicBrainz', url: `https://musicbrainz.org/search?type=${kind === 'track' ? 'recording' : kind === 'album' ? 'release' : 'artist'}&query=${q(term)}`, search: true });
  links.push({ id: 'spotify', label: 'Spotify', url: `https://open.spotify.com/search/${q(term)}${kind === 'artist' ? '/artists' : kind === 'album' ? '/albums' : '/tracks'}`, search: true });
  links.push({ id: 'ytmusic', label: 'YouTube Music', url: `https://music.youtube.com/search?q=${q(term)}`, search: true });
  links.push({ id: 'discogs', label: 'Discogs', url: `https://www.discogs.com/search/?q=${q(term)}&type=${kind === 'artist' ? 'artist' : kind === 'album' ? 'release' : 'all'}`, search: true });
  links.push({ id: 'genius', label: 'Genius', url: `https://genius.com/search?q=${q(term)}`, search: true });
  return links;
}

async function mb(path) {
  const r = await fetch(`https://musicbrainz.org/ws/2/${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`MusicBrainz ${r.status}`);
  return r.json();
}

export async function find(kind, info) {
  const key = JSON.stringify([kind, info]);
  if (cache.has(key)) return cache.get(key);
  const links = searchLinks(kind, info);
  let about = null;
  if (settings.online('musicbrainz')) {
    try {
      let mbid = info.mbid;
      if (!mbid && kind === 'artist' && info.name) {
        const r = await mb(`artist?query=${q(`artist:"${info.name}"`)}&limit=3&fmt=json`);
        const hit = r.artists?.find((a) => a.score >= 95 && a.name.toLowerCase() === info.name.toLowerCase());
        mbid = hit?.id;
        if (hit) about = { type: hit.type, country: hit.country, area: hit.area?.name, disambiguation: hit.disambiguation, lifeSpan: hit['life-span'], tags: hit.tags?.slice(0, 8).map((t) => t.name) };
      }
      if (mbid) {
        const ent = { artist: 'artist', album: 'release', track: 'recording' }[kind];
        const r = await mb(`${ent}/${mbid}?inc=url-rels${kind === 'artist' ? '+tags' : ''}&fmt=json`);
        for (const rel of r.relations || []) {
          const url = rel.url?.resource;
          if (!url) continue;
          const m = KNOWN.find(([re]) => re.test(url));
          if (!m) continue;
          const existing = links.findIndex((l) => l.id === m[1]);
          if (existing >= 0) links[existing] = { id: m[1], label: m[2], url };
          else links.push({ id: m[1], label: m[2], url });
        }
        const mbIndex = links.findIndex((l) => l.id === 'musicbrainz');
        links[mbIndex] = { id: 'musicbrainz', label: 'MusicBrainz', url: `https://musicbrainz.org/${ent}/${mbid}` };
        if (kind === 'artist' && !links.some((l) => l.id === 'listenbrainz')) links.push({ id: 'listenbrainz', label: 'ListenBrainz', url: `https://listenbrainz.org/artist/${mbid}/` });
        if (kind === 'artist') about = { ...(about || {}), type: r.type, country: r.country, area: r.area?.name, lifeSpan: r['life-span'], disambiguation: r.disambiguation, tags: (r.tags || []).sort((a, b) => b.count - a.count).slice(0, 8).map((t) => t.name), mbid };
      }
    } catch {}
  }
  const result = { links, about };
  cache.set(key, result);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return result;
}

export function register(app) {
  app.get(
    '/api/links/:kind',
    requireUser,
    json((req) => find(req.params.kind, { name: str(req.query.name, 300), artist: str(req.query.artist, 300), title: str(req.query.title, 300), mbid: /^[0-9a-f-]{36}$/i.test(req.query.mbid || '') ? req.query.mbid : undefined })),
  );
}
