// Recognizing what a file really is, from its sound (open "Shazam"):
// Chromaprint fingerprint (fpcalc) → AcoustID → MusicBrainz recording.
// Results come with a match score, proposed tags, and links to Spotify /
// YouTube Music so you can check by ear before applying anything.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as settings from './settings.js';
import * as lib from './library/index.js';
import { httpError, json, str } from './lib/http.js';
import { requireUser } from './auth.js';
import { profileOf } from './library/routes.js';
import { db } from './db.js';
import { VERSION } from './config.js';

const UA = `MasterMusicManager/${VERSION} (https://github.com/Master3307/master-music-manager)`;
// AcoustID client key for this app (free, rate limited to 3 requests/s). Users can set their own.
const DEFAULT_CLIENT = process.env.MMM_ACOUSTID_KEY || '';

export function fingerprint(file) {
  return new Promise((resolve, reject) =>
    execFile('fpcalc', ['-json', '-length', '120', file], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
      if (e) return reject(e.code === 'ENOENT' ? httpError(424, 'fpcalc (Chromaprint) is not installed. Install it under Get music → Tools.') : e);
      try {
        resolve(JSON.parse(out));
      } catch (err) {
        reject(err);
      }
    }),
  );
}

let last = 0;
async function acoustid(fp, key) {
  const wait = 350 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const body = new URLSearchParams({ client: key, format: 'json', duration: String(Math.round(fp.duration)), fingerprint: fp.fingerprint, meta: 'recordings releasegroups releases tracks compress sources' });
  const r = await fetch('https://api.acoustid.org/v2/lookup', { method: 'POST', body, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }).then((x) => x.json());
  if (r.status !== 'ok') throw httpError(502, `AcoustID: ${r.error?.message || 'lookup failed'}${r.error?.code === 4 ? ' (check the AcoustID key in Settings → Privacy & online)' : ''}`);
  return r.results || [];
}

function candidates(results, duration) {
  const out = [];
  for (const res of results) {
    for (const rec of res.recordings || []) {
      if (!rec.title) continue;
      const artist = (rec.artists || []).map((a) => a.name + (a.joinphrase || '')).join('').trim();
      const rg = rec.releasegroups?.[0];
      const release = rg?.releases?.[0];
      const durDiff = rec.duration && duration ? Math.abs(rec.duration - duration) : null;
      const score = Math.round(res.score * 100 * (durDiff == null ? 1 : durDiff < 3 ? 1 : durDiff < 10 ? 0.9 : 0.7));
      const term = `${artist} ${rec.title}`;
      out.push({
        score,
        sources: rec.sources || 0,
        recordingId: rec.id,
        title: rec.title,
        artist,
        artists: (rec.artists || []).map((a) => a.name),
        album: rg?.title,
        albumType: rg?.type,
        year: release?.date?.year,
        date: release?.date ? [release.date.year, release.date.month, release.date.day].filter(Boolean).map((x) => String(x).padStart(2, '0')).join('-') : undefined,
        country: release?.country,
        track: release?.mediums?.[0]?.tracks?.[0]?.position,
        tracktotal: release?.mediums?.[0]?.track_count,
        releaseId: release?.id,
        releaseGroupId: rg?.id,
        duration: rec.duration,
        links: {
          musicbrainz: `https://musicbrainz.org/recording/${rec.id}`,
          spotify: `https://open.spotify.com/search/${encodeURIComponent(term)}/tracks`,
          ytmusic: `https://music.youtube.com/search?q=${encodeURIComponent(term)}`,
          youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`,
        },
      });
    }
  }
  // Same recording from several AcoustID results: keep the best.
  const best = new Map();
  for (const c of out) if (!best.has(c.recordingId) || best.get(c.recordingId).score < c.score) best.set(c.recordingId, c);
  return [...best.values()].sort((a, b) => b.score - a.score || b.sources - a.sources).slice(0, 8);
}

export const RECOGNIZERS = {
  acoustid: { label: 'AcoustID', note: 'Free and open. Best for whole files of released songs; weaker on clips, live versions and odd uploads.', default: true },
  shazam: { label: 'Shazam (unofficial)', note: 'Uses Shazam’s private API through shazamio. Free and great with snippets, remixes and YouTube rips, but against Shazam’s terms and may stop working any day.', optIn: true },
  audd: { label: 'AudD', note: 'Commercial recognition API with a small free tier. Needs a key from audd.io.', needsKey: true },
};

const SHAZAM_PY = `
import asyncio, json, sys
from shazamio import Shazam
async def main():
    s = Shazam()
    fn = getattr(s, 'recognize', None) or getattr(s, 'recognize_song')
    print(json.dumps(await fn(sys.argv[1])))
asyncio.run(main())
`;

async function shazam(file, duration) {
  const { PATHS } = await import('./config.js');
  const py = [`${PATHS.data}/venv-shazam/bin/python`, 'python3'].find((p) => p === 'python3' || fs.existsSync(p));
  const out = await new Promise((resolve, reject) =>
    execFile(py, ['-c', SHAZAM_PY, file], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) return reject(/No module named/.test(stderr) ? httpError(424, 'shazamio is not installed. Install it under Get music → Tools.') : new Error(`Shazam: ${(stderr || e.message).trim().split('\n').pop()}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(err);
      }
    }),
  );
  const t = out.track;
  if (!t) return [];
  const meta = Object.fromEntries((t.sections?.find((s) => s.type === 'SONG')?.metadata || []).map((m) => [m.title.toLowerCase(), m.text]));
  const term = `${t.subtitle} ${t.title}`;
  const spotify = t.hub?.providers?.find((p) => p.type === 'SPOTIFY')?.actions?.find((a) => a.uri)?.uri;
  return [
    {
      provider: 'shazam',
      // Shazam gives no confidence value; one hit with matching length is a strong match.
      score: out.matches?.length ? (duration && t.duration && Math.abs(t.duration - duration) > 15 ? 70 : 90) : 50,
      scoreNote: 'Shazam does not report a confidence; this is an estimate.',
      title: t.title,
      artist: t.subtitle,
      album: meta.album,
      year: meta.released ? Number(meta.released) : undefined,
      genre: t.genres?.primary,
      label: meta.label,
      isrc: t.isrc,
      cover: t.images?.coverarthq || t.images?.coverart,
      links: {
        shazam: t.url,
        spotify: spotify ? `https://open.spotify.com/track/${spotify.split(':').pop()}` : `https://open.spotify.com/search/${encodeURIComponent(term)}/tracks`,
        ytmusic: `https://music.youtube.com/search?q=${encodeURIComponent(term)}`,
        apple: t.hub?.options?.find((o) => o.providername === 'applemusic')?.actions?.find((a) => a.uri)?.uri,
      },
    },
  ];
}

async function audd(file, key) {
  const { run } = await import('./media/ffmpeg.js');
  // AudD wants a short clip: 20 s from the middle-ish, as MP3.
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', '30', '-t', '20', '-i', file, '-ac', '1', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { binary: true });
  const form = new FormData();
  form.append('api_token', key);
  form.append('return', 'spotify,apple_music,musicbrainz');
  form.append('file', new Blob([stdout], { type: 'audio/mpeg' }), 'clip.mp3');
  const r = await fetch('https://api.audd.io/', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
  if (r.status !== 'success') throw new Error(`AudD: ${r.error?.error_message || 'failed'}`);
  const x = r.result;
  if (!x) return [];
  const term = `${x.artist} ${x.title}`;
  return [
    {
      provider: 'audd',
      score: x.score ? Number(x.score) : 85,
      title: x.title,
      artist: x.artist,
      album: x.album,
      year: x.release_date ? Number(x.release_date.slice(0, 4)) : undefined,
      date: x.release_date,
      label: x.label,
      isrc: x.spotify?.external_ids?.isrc,
      recordingId: x.musicbrainz?.[0]?.id,
      links: { spotify: x.spotify?.external_urls?.spotify || `https://open.spotify.com/search/${encodeURIComponent(term)}/tracks`, ytmusic: `https://music.youtube.com/search?q=${encodeURIComponent(term)}`, audd: x.song_link },
    },
  ];
}

/** Run every enabled recognizer; each result says where it came from and how sure it is. */
export async function recognize(file, key, { providers } = {}) {
  if (!settings.online()) throw httpError(403, 'Privacy mode is on: recognizing songs needs online services');
  const pv = settings.get('privacy');
  const want = providers || ['acoustid', ...(pv.shazam ? ['shazam'] : []), ...(pv.auddKey ? ['audd'] : [])];
  const { probe } = await import('./media/ffmpeg.js');
  const duration = (await probe(file).catch(() => ({}))).duration;
  const errors = [];
  const all = [];
  await Promise.all(
    want.map(async (p) => {
      try {
        if (p === 'acoustid') {
          if (!settings.online('musicbrainz')) throw new Error('MusicBrainz lookups are off');
          const k = key || pv.acoustidKey || DEFAULT_CLIENT;
          if (!k) throw new Error('Add a free AcoustID application key in Settings → Privacy & online (acoustid.org/new-application)');
          const fp = await fingerprint(file);
          all.push(...candidates(await acoustid(fp, k), fp.duration).map((c) => ({ ...c, provider: 'acoustid' })));
        } else if (p === 'shazam') all.push(...(await shazam(file, duration)));
        else if (p === 'audd') all.push(...(await audd(file, pv.auddKey)));
      } catch (e) {
        errors.push({ provider: p, error: e.message });
      }
    }),
  );
  return { duration, candidates: all.sort((a, b) => b.score - a.score), errors, providers: want };
}

/** The tags a candidate would set (shown as a diff before applying). */
export function tagsFrom(c) {
  return clean({
    title: c.title,
    artist: c.artist,
    album: c.album,
    year: c.year,
    date: c.date,
    track: c.track,
    tracktotal: c.tracktotal,
    releasecountry: c.country,
    musicbrainz_trackid: c.recordingId,
    musicbrainz_albumid: c.releaseId,
    musicbrainz_releasegroupid: c.releaseGroupId,
    genre: c.genre ? [c.genre] : undefined,
    label: c.label ? [c.label] : undefined,
    isrc: c.isrc ? [c.isrc] : undefined,
  });
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export function register(app) {
  app.get('/api/recognize/providers', requireUser, json(() => {
    const pv = settings.get('privacy');
    return Object.fromEntries(Object.entries(RECOGNIZERS).map(([k, v]) => [k, { ...v, enabled: k === 'acoustid' ? true : k === 'shazam' ? pv.shazam : Boolean(pv.auddKey) }]));
  }));
  app.post(
    '/api/p/:pid/tracks/:id/recognize',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = lib.byId(p.id, req.params.id);
      if (!t) throw httpError(404, 'Track not found');
      const r = await recognize(lib.absPath(p, t.path), str(req.body.key, 100) || undefined, { providers: req.body.providers });
      return { ...r, candidates: r.candidates.map((c) => ({ ...c, tags: tagsFrom(c), current: { title: t.title, artist: t.artist, album: t.album, year: t.year, duration: t.duration } })) };
    }),
  );
  app.post(
    '/api/inbox/:id/recognize',
    requireUser,
    json(async (req) => {
      const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
      if (!row) throw httpError(404, 'Not in the inbox');
      const r = await recognize(row.file, str(req.body.key, 100) || undefined, { providers: req.body.providers });
      return { ...r, candidates: r.candidates.map((c) => ({ ...c, tags: tagsFrom(c) })) };
    }),
  );
}
