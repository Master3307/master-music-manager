// Finding the right details for a song online (MusicBrainz + Cover Art Archive):
// for downloads with messy names, and the "fill in missing details" helper.
// Every candidate gets a match score from title, artist and length.
import { db } from './db.js';
import * as settings from './settings.js';
import { httpError, json, str } from './lib/http.js';
import { requireUser } from './auth.js';
import { VERSION } from './config.js';
import { log } from './lib/log.js';

const UA = `MasterMusicManager/${VERSION} (https://github.com/Master3307/master-music-manager)`;
// MusicBrainz asks for at most one request per second: every call waits its turn.
let chain = Promise.resolve();
export function mb(path) {
  const run = chain.then(() => mbFetch(path));
  chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}
async function mbFetch(path) {
  // MusicBrainz is often "busy" (503) for a moment: try again a few times.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://musicbrainz.org/ws/2/${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (r.ok) return r.json();
    if ((r.status === 503 || r.status === 429) && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    throw Object.assign(new Error(r.status === 503 || r.status === 429 ? 'MusicBrainz is busy right now. Try again in a minute.' : `MusicBrainz answered ${r.status}`), { status: 503, expected: true });
  }
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
const esc = (s) => String(s).replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

function closeness(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0.5;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  return 0;
}

export async function search({ title, artist, album, duration }) {
  if (!settings.online('musicbrainz')) throw httpError(403, 'Online lookups are off (Settings → Privacy & online)');
  if (!title) throw httpError(400, 'Need at least a title');
  // A broken tag can hold a list of file paths: only sane values are searched for.
  const sane = (v) => (v && String(v).length <= 150 && (String(v).match(/\//g) || []).length < 4 ? v : undefined);
  album = sane(album);
  artist = sane(artist);
  const q = [`recording:"${esc(title)}"`, artist && `artist:"${esc(artist)}"`, album && `release:"${esc(album)}"`].filter(Boolean).join(' AND ');
  let r = await mb(`recording?query=${encodeURIComponent(q)}&limit=15&fmt=json`);
  if (!r.recordings?.length && album) r = await mb(`recording?query=${encodeURIComponent([`recording:"${esc(title)}"`, artist && `artist:"${esc(artist)}"`].filter(Boolean).join(' AND '))}&limit=15&fmt=json`);
  const out = [];
  for (const rec of r.recordings || []) {
    const credit = (rec['artist-credit'] || []).map((c) => c.name + (c.joinphrase || '')).join('').trim();
    // Prefer an official album release, then anything official, then the first.
    const releases = rec.releases || [];
    const rel =
      releases.find((x) => x.status === 'Official' && x['release-group']?.['primary-type'] === 'Album' && !x['release-group']?.['secondary-types']?.length) ||
      releases.find((x) => x.status === 'Official') ||
      releases[0];
    const len = rec.length ? rec.length / 1000 : null;
    let lenScore = 0.6;
    if (duration && len) {
      const d = Math.abs(duration - len);
      lenScore = d <= 2 ? 1 : d <= 6 ? 0.7 : d <= 20 ? 0.3 : 0;
    }
    const score = Math.round((closeness(title, rec.title) * 0.4 + (artist ? closeness(artist, credit) : 0.6) * 0.3 + lenScore * 0.2 + (rec.score / 100) * 0.1) * 100);
    const media = rel?.media?.[0];
    out.push({
      score,
      recordingId: rec.id,
      title: rec.title,
      artist: credit,
      album: rel?.title,
      albumArtist: rel?.['artist-credit']?.map((c) => c.name + (c.joinphrase || '')).join('').trim() || undefined,
      date: rel?.date,
      year: rel?.date ? Number(rel.date.slice(0, 4)) : undefined,
      track: media?.track?.[0]?.number ? Number(media.track[0].number) || undefined : undefined,
      tracktotal: media?.['track-count'],
      releaseId: rel?.id,
      releaseGroupId: rel?.['release-group']?.id,
      releaseType: rel?.['release-group']?.['primary-type'],
      country: rel?.country,
      duration: len,
      isrc: rec.isrcs?.[0],
      cover: rel?.id ? `https://coverartarchive.org/release/${rel.id}/front-500` : null,
      links: {
        musicbrainz: `https://musicbrainz.org/recording/${rec.id}`,
        spotify: `https://open.spotify.com/search/${encodeURIComponent(`${credit} ${rec.title}`)}/tracks`,
        ytmusic: `https://music.youtube.com/search?q=${encodeURIComponent(`${credit} ${rec.title}`)}`,
      },
    });
  }
  // One result per recording, best first.
  const best = new Map();
  for (const c of out) if (!best.has(c.recordingId) || best.get(c.recordingId).score < c.score) best.set(c.recordingId, c);
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

export function tagsFrom(c) {
  return Object.fromEntries(
    Object.entries({
      title: c.title,
      artist: c.artist,
      album: c.album,
      albumartist: c.albumArtist,
      year: c.year,
      date: c.date,
      track: c.track,
      tracktotal: c.tracktotal,
      releasetype: c.releaseType ? [c.releaseType.toLowerCase()] : undefined,
      releasecountry: c.country,
      isrc: c.isrc ? [c.isrc] : undefined,
      musicbrainz_trackid: c.recordingId,
      musicbrainz_albumid: c.releaseId,
      musicbrainz_releasegroupid: c.releaseGroupId,
    }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}

/** Look up inbox items in the background (downloads with guessed names). */
export async function suggestFor(inboxId) {
  if (!settings.online('musicbrainz')) return;
  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(inboxId);
  if (!row) return;
  const meta = JSON.parse(row.meta);
  const info = JSON.parse(row.info);
  try {
    const list = await search({ title: meta.tags.title, artist: meta.tags.artist, duration: info.duration });
    if (list[0]) db.prepare("UPDATE inbox SET info = json_set(info, '$.suggestion', json(?)) WHERE id = ?").run(JSON.stringify({ ...list[0], tags: tagsFrom(list[0]) }), inboxId);
  } catch (e) {
    log.debug(`lookup for ${inboxId}: ${e.message}`);
  }
}

export function register(app) {
  app.get(
    '/api/lookup',
    requireUser,
    json(async (req) => (await search({ title: str(req.query.title, 300), artist: str(req.query.artist, 300), album: str(req.query.album, 300), duration: Number(req.query.duration) || null })).map((c) => ({ ...c, tags: tagsFrom(c) }))),
  );
}
