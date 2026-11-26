// "Take the details from here": links (Spotify, Deezer, MusicBrainz, YouTube,
// SoundCloud, Bandcamp, Apple Music, any page with music tags …) and/or a file.
// Every source is read on its own; what they agree on is used, where they
// disagree the person picks (the most common answer is preselected). A link
// that doesn't work is reported and the rest still count.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { safeFetch } from './lib/net.js';
import { httpError, json } from './lib/http.js';
import { requireUser } from './auth.js';
import * as settings from './settings.js';
import { take } from './uploads.js';
import { guessFromName } from './inbox.js';

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const year = (v) => Number((String(v ?? '').match(/\b(1[89]\d\d|20\d\d)\b/) || [])[1]) || undefined;
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)));

/** <meta property="og:…" content="…"> and friends from an HTML page. */
function metaTags(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\s+[^>]*?(?:property|name)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*>/gi)) out[m[1].toLowerCase()] = out[m[1].toLowerCase()] || decode(m[2]);
  for (const m of html.matchAll(/<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']([^"']+)["'][^>]*>/gi)) out[m[2].toLowerCase()] = out[m[2].toLowerCase()] || decode(m[1]);
  return out;
}
async function page(url) {
  const r = await safeFetch(url, { maxBytes: 4 * 1024 * 1024, timeout: 15000, headers: { 'Accept-Language': 'en', Accept: 'text/html' } });
  return r.body.toString('utf8');
}

const getJson = async (url) => JSON.parse((await safeFetch(url, { maxBytes: 2 * 1024 * 1024, timeout: 15000, headers: { Accept: 'application/json' } })).body.toString());

/** A Deezer track with its album: BPM, ISRC, label, genres, track and disc counts, barcode. */
async function deezerTrack(id) {
  const t = await getJson(`https://api.deezer.com/track/${id}`);
  if (t.error) throw new Error(t.error.message || 'not found');
  const a = t.album?.id ? await getJson(`https://api.deezer.com/album/${t.album.id}`).catch(() => ({})) : {};
  return clean({
    title: t.title,
    artist: t.contributors?.length ? t.contributors.map((c) => c.name).join(' / ') : t.artist?.name,
    artists: t.contributors?.map((c) => c.name),
    album: t.album?.title,
    albumartist: a.artist?.name,
    year: year(t.release_date || a.release_date),
    date: t.release_date || a.release_date,
    track: t.track_position,
    tracktotal: a.nb_tracks,
    disc: t.disk_number,
    isrc: t.isrc ? [t.isrc] : undefined,
    bpm: t.bpm > 0 ? Math.round(t.bpm) : undefined,
    label: a.label ? [a.label] : undefined,
    barcode: a.upc,
    genre: a.genres?.data?.map((g) => g.name),
    releasetype: a.record_type ? [a.record_type] : undefined,
    duration: t.duration,
    cover: t.album?.cover_xl || a.cover_xl,
  });
}

const simple = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const fits = (want, title, artist, duration) => {
  if (simple(title) !== simple(want.title) && !simple(title).includes(simple(want.title))) return false;
  if (want.artist && !simple(artist).includes(simple(String(want.artist).split(/\s*[/,&]\s*/)[0]))) return false;
  if (want.duration && duration && Math.abs(want.duration - duration) > 8) return false;
  return true;
};

/** Found by name, without a link: Deezer and iTunes (good covers, BPM, label, counts). */
const SEARCHES = [
  {
    name: 'Deezer',
    find: async (w) => {
      const r = await getJson(`https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${w.artist || ''}" track:"${w.title}"`)}&limit=8`);
      const ok = (r.data || []).filter((x) => fits(w, x.title, x.artist?.name, x.duration));
      // The album you have, else not a compilation ("Best of", "Hits of the 80s" …).
      const hit = ok.find((x) => w.album && simple(x.album?.title) === simple(w.album)) || ok.find((x) => !/best of|greatest|hits|collection|anthology|decades|essential|compilation|various/i.test(x.album?.title || '')) || ok[0];
      return hit ? deezerTrack(hit.id) : null;
    },
  },
  {
    name: 'Apple Music',
    find: async (w) => {
      const r = await getJson(`https://itunes.apple.com/search?term=${encodeURIComponent(`${w.artist || ''} ${w.title}`)}&entity=song&limit=10`);
      const x = (r.results || []).find((i) => fits(w, i.trackName, i.artistName, i.trackTimeMillis / 1000));
      if (!x) return null;
      return clean({
        title: x.trackName,
        artist: x.artistName,
        album: x.collectionName?.replace(/ - (Single|EP)$/, ''),
        albumartist: x.collectionArtistName,
        year: year(x.releaseDate),
        track: x.trackNumber,
        tracktotal: x.trackCount,
        disc: x.discNumber,
        disctotal: x.discCount,
        genre: x.primaryGenreName && x.primaryGenreName !== 'Music' ? [x.primaryGenreName] : undefined,
        duration: x.trackTimeMillis / 1000,
        cover: x.artworkUrl100?.replace(/\/\d+x\d+bb\./, '/1200x1200bb.'),
      });
    },
  },
];

const READERS = [
  {
    // Spotify's public page: "Song · Artist · Album · Year" style tags.
    name: 'Spotify',
    test: (u) => /(^|\.)spotify\.com$/i.test(u.hostname) && /\/track\//.test(u.pathname),
    read: async (u) => {
      const id = u.pathname.match(/track\/([A-Za-z0-9]+)/)?.[1];
      const m = metaTags(await page(`https://open.spotify.com/track/${id}`));
      // og:description: "Artist · Album · Song · 2020"
      const parts = (m['og:description'] || '').split(' · ').map((x) => x.trim());
      return clean({ title: m['og:title'], artist: m['music:musician_description'] || parts[0], album: parts[1], year: Number(year(m['music:release_date'] || parts.at(-1))) || undefined, track: Number(m['music:album:track']) || undefined, duration: Number(m['music:duration']) || undefined, cover: m['og:image'] });
    },
  },
  {
    name: 'Deezer',
    test: (u) => /(^|\.)deezer\.com$/i.test(u.hostname) && /\/track\//.test(u.pathname),
    read: async (u) => deezerTrack(u.pathname.match(/track\/(\d+)/)?.[1]),
  },
  {
    name: 'MusicBrainz',
    test: (u) => /(^|\.)musicbrainz\.org$/i.test(u.hostname) && /\/recording\//.test(u.pathname),
    read: async (u) => {
      const id = u.pathname.match(/recording\/([0-9a-f-]{36})/)?.[1];
      // Through the shared MusicBrainz queue (its User-Agent, one request a second).
      const r = await (await import('./lookup.js')).mb(`recording/${id}?inc=artist-credits+releases+isrcs+genres&fmt=json`);
      const rel = r.releases?.[0];
      return clean({ title: r.title, artist: (r['artist-credit'] || []).map((a) => a.name + (a.joinphrase || '')).join('').trim(), album: rel?.title, year: year(r['first-release-date'] || rel?.date), isrc: r.isrcs?.[0], genre: r.genres?.slice(0, 3).map((g) => g.name), duration: r.length ? r.length / 1000 : undefined, cover: rel ? `https://coverartarchive.org/release/${rel.id}/front-500` : undefined });
    },
  },
  {
    // YouTube, SoundCloud, Bandcamp, Vimeo and ~1800 more: yt-dlp reads the details, downloads nothing.
    name: 'yt-dlp',
    test: (u) => /(youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com|vimeo\.com|mixcloud\.com|tiktok\.com|audiomack\.com|music\.apple\.com|tidal\.com)$/i.test(u.hostname.replace(/^www\.|^m\./, '')) || /bandcamp\.com$/i.test(u.hostname),
    read: async (u) => {
      const bin = settings.get('downloads').ytdlpBin || 'yt-dlp';
      const raw = await new Promise((res, rej) =>
        execFile(bin, ['-J', '--no-playlist', '--no-warnings', '--skip-download', u.href], { timeout: 90000, maxBuffer: 32 * 1024 * 1024 }, (e, out, err) => {
          if (!e) return res(out);
          if (e.killed) return rej(new Error('it took too long to answer'));
          if (e.code === 'ENOENT' || /ENOENT/.test(e.message)) return rej(new Error('yt-dlp isn’t installed (Settings → Downloads)'));
          const lines = String(err || e.message).split('\n').map((l) => l.trim()).filter(Boolean);
          rej(new Error((lines.find((l) => /ERROR/.test(l)) || lines.at(-1) || 'couldn’t read it').replace(/^.*ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 160)));
        }),
      );
      const j = JSON.parse(raw);
      // Music sites fill track/artist/album; plain videos only have a title like "Artist - Song (Official Video)".
      const guess = j.track ? {} : guessFromName(j.title || '');
      return clean({
        title: j.track || guess.title || j.title,
        artist: j.artists?.join(' / ') || j.artist || j.creator || guess.artist || (j.track ? undefined : j.uploader?.replace(/ - Topic$/, '')),
        album: j.album,
        albumartist: j.album_artist,
        year: year(j.release_year || j.release_date || j.upload_date),
        track: j.track_number,
        genre: j.genre ? [j.genre] : j.genres,
        duration: j.duration,
        cover: j.thumbnail,
        site: j.extractor_key,
      });
    },
  },
  {
    // Anything else with Open Graph / music tags (Apple Music, Tidal, label pages, shops …).
    name: 'page',
    test: () => true,
    read: async (u) => {
      const m = metaTags(await page(u.href));
      const title = m['og:title'] || m['twitter:title'];
      if (!title) throw new Error('no song details on that page');
      const g = guessFromName(title);
      return clean({ title: g.title || title, artist: m['music:musician_description'] || m['og:music:artist'] || g.artist, album: m['music:album'], year: year(m['music:release_date']), cover: m['og:image'] || m['twitter:image'], site: m['og:site_name'] });
    },
  },
];

async function fromFile(upload) {
  const tags = await import('./library/tags.js');
  try {
    const r = await tags.read(upload.file);
    const t = r.tags || {};
    const c = await tags.readCover(upload.file).catch(() => null);
    return clean({
      title: t.title || guessFromName(upload.name || '').title,
      artist: Array.isArray(t.artists) && t.artists.length ? t.artists.join(' / ') : t.artist || guessFromName(upload.name || '').artist,
      album: t.album,
      albumartist: t.albumartist,
      year: year(t.year || t.date),
      track: t.track?.no ?? t.track,
      disc: t.disk?.no ?? t.disc,
      genre: t.genre,
      isrc: Array.isArray(t.isrc) ? t.isrc[0] : t.isrc,
      cover: c && c.data.length < 8 * 1024 * 1024 ? `data:${c.format};base64,${Buffer.from(c.data).toString('base64')}` : undefined,
    });
  } finally {
    fs.rmSync(upload.file, { force: true });
  }
}

const norm = (v) =>
  String(Array.isArray(v) ? v.join(' / ') : v)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([](official|lyrics?|audio|video|hd|hq|remaster(ed)?|explicit)[^)\]]*[)\]]/g, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+/g, ' / ')
    .replace(/[^\p{L}\p{N}]+/gu, '');

// Lists from several sources are combined; single values have to agree or become a choice.
const LISTS = new Set(['genre', 'artists', 'composer', 'lyricist', 'writer', 'producer', 'engineer', 'mixer', 'remixer', 'arranger', 'conductor', 'djmixer', 'label', 'isrc', 'releasetype', 'musicbrainz_artistid', 'musicbrainz_albumartistid']);
const SKIP = new Set(['cover', 'duration', 'site']);
// Who to believe first for the spelling of a single value.
const RANK = { MusicBrainz: 0, file: 1, Deezer: 2, Spotify: 2, 'Apple Music': 3, sound: 4, 'yt-dlp': 5, page: 6 };

/** Agree → one value; disagree → choices (most sources, then the most trusted, first). */
export function merge(sources) {
  const fields = {};
  const from = {};
  const conflicts = [];
  const keys = [...new Set(sources.flatMap((s) => Object.keys(s.data)))].filter((k) => !SKIP.has(k));
  // What you gave us comes before what we found by ourselves.
  const ranked = [...sources].sort((a, b) => Number(Boolean(a.auto)) - Number(Boolean(b.auto)) || (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9));
  for (const f of keys) {
    if (LISTS.has(f)) {
      const seen = new Map();
      for (const s of ranked)
        for (const v of [].concat(s.data[f] ?? [])) {
          const k = norm(v);
          if (k && !seen.has(k)) seen.set(k, { v, from: s.label });
        }
      if (!seen.size) continue;
      fields[f] = [...seen.values()].map((x) => x.v).slice(0, f === 'genre' ? 5 : 20);
      from[f] = [...new Set([...seen.values()].map((x) => x.from))];
      continue;
    }
    const groups = new Map();
    for (const s of ranked) {
      const v = s.data[f];
      if (v == null || v === '') continue;
      const k = norm(v);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, { value: v, from: [] });
      groups.get(k).from.push(s.label);
    }
    // Most sources first; on a tie, the order above (yours, then the most trusted).
    const opts = [...groups.values()].sort((a, b) => b.from.length - a.from.length);
    if (!opts.length) continue;
    fields[f] = opts[0].value;
    from[f] = opts[0].from;
    if (opts.length > 1) conflicts.push({ field: f, options: opts });
  }
  const covers = [...new Map(ranked.filter((s) => s.data.cover).map((s) => [s.data.cover, { url: s.data.cover, from: s.label }])).values()];
  return { fields, from, conflicts, covers };
}

export function register(app) {
  app.post(
    '/api/details-from',
    requireUser,
    json(async (req) => {
      const urls = [...new Set((Array.isArray(req.body.urls) ? req.body.urls : String(req.body.urls || '').split(/\s+/)).map((x) => String(x).trim()).filter(Boolean))].slice(0, 10);
      const upload = req.body.uploadId ? take(String(req.body.uploadId), req.user.id) : null;
      // The song we're filling in (its current tags help to find the right matches).
      const lib = await import('./library/index.js');
      const { getProfile, canUse } = await import('./services/index.js');
      const tp = req.body.track?.pid ? getProfile(String(req.body.track.pid)) : null;
      const track = tp && canUse(req.user, tp) ? lib.byId(tp.id, req.body.track.id) : null;
      const online = settings.online();
      if (!urls.length && !upload && !track) throw httpError(400, 'Paste a link or pick a file');
      if (!online && urls.length) throw httpError(400, 'Privacy mode is on, so nothing is looked up online');
      const sources = [];
      const errors = [];
      const say = (url, message) => errors.push({ url, message });

      // 1. What you gave us.
      await Promise.all(
        urls.map(async (raw) => {
          let u;
          try {
            u = new URL(raw);
            if (!/^https?:$/.test(u.protocol)) throw new Error();
          } catch {
            return say(raw, 'that isn’t a link');
          }
          const reader = READERS.find((r) => r.test(u));
          try {
            const data = await reader.read(u);
            if (!data.title && !data.artist && !data.album) throw new Error('no song details found there');
            sources.push({ label: data.site && reader.name !== 'Spotify' ? data.site : reader.name === 'page' ? u.hostname.replace(/^www\./, '') : reader.name === 'yt-dlp' ? u.hostname.replace(/^www\.|^m\.|^music\./, '').replace(/\.com$/, '') : reader.name, kind: reader.name, url: u.href, data, mbid: reader.name === 'MusicBrainz' ? u.pathname.match(/recording\/([0-9a-f-]{36})/)?.[1] : undefined });
          } catch (e) {
            say(raw, e.message || 'didn’t work');
          }
        }),
      );
      if (upload) {
        try {
          sources.push({ label: upload.name || 'your file', kind: 'file', data: await fromFile(upload) });
        } catch (e) {
          say(upload.name, `couldn’t read that file (${e.message})`);
        }
      }
      // What we know so far, to search with.
      const first = merge(sources).fields;
      // The length from your links first (the file may be something else, e.g. before replacing its audio).
      const want = { title: first.title || track?.title, artist: first.artist || track?.artist, album: first.album || track?.album, duration: sources.find((s) => s.data.duration)?.data.duration || track?.duration, isrc: first.isrc || track?.isrc };
      const enrich = await import('./enrich.js');

      // 2. Found by name, by ourselves.
      if (online && want.title) {
        await Promise.all(
          SEARCHES.filter((x) => !sources.some((s) => s.kind === x.name)).map(async (x) => {
            const data = await x.find(want).catch(() => null);
            if (data) sources.push({ label: x.name, kind: x.name, data, auto: true });
          }),
        );
      }

      // 3. MusicBrainz, everything it has.
      if (online && settings.online('musicbrainz')) {
        try {
          const isrcs = [...new Set(sources.flatMap((s) => [].concat(s.data.isrc || [])).concat(want.isrc || []))];
          const id = sources.find((s) => s.mbid)?.mbid || (await enrich.findRecording({ ...want, isrc: isrcs }))?.id;
          if (id) {
            const deep = await enrich.musicbrainz(id, { album: want.album });
            const i = sources.findIndex((s) => s.kind === 'MusicBrainz');
            const entry = { label: 'MusicBrainz', kind: 'MusicBrainz', url: deep.link, data: { ...deep.tags, cover: deep.cover, duration: deep.duration }, custom: deep.custom, auto: i < 0 };
            if (i >= 0) sources[i] = entry;
            else sources.push(entry);
          }
        } catch (e) {
          say('MusicBrainz', e.message);
        }
      }

      // 4. BPM and key from the sound, when nobody knows them.
      let merged = merge(sources);
      if (track && (!merged.fields.bpm || !merged.fields.key) && tp.local_path) {
        try {
          const a = await enrich.analyze(lib.absPath(tp, track.path), { duration: track.duration });
          sources.push({ label: 'measured from the sound', kind: 'sound', auto: true, data: clean({ bpm: merged.fields.bpm ? undefined : a.bpm, key: a.key }), note: `key ${a.key} (${a.camelot})` });
          merged = merge(sources);
        } catch (e) {
          say('BPM and key', `couldn’t measure them (${e.message})`);
        }
      }

      // 5. Lyrics to look at (never used without you choosing them).
      let lyrics = null;
      if (online && (merged.fields.title || want.title)) {
        try {
          const { search } = await import('./lyrics.js');
          const list = (await search({ title: merged.fields.title || want.title, artist: merged.fields.artist || want.artist, album: merged.fields.album || want.album, duration: want.duration })).filter((r) => !r.error && r.text);
          if (list[0] && list[0].score >= 55) lyrics = { provider: list[0].provider, score: list[0].score, synced: Boolean(list[0].synced), text: list[0].text };
        } catch {}
      }

      const custom = Object.assign({}, ...sources.map((s) => s.custom || {}));
      return {
        ...merged,
        custom,
        lyrics,
        current: track ? Object.fromEntries(Object.keys(merged.fields).map((k) => [k, track[k] ?? null])) : null,
        sources: sources.map(({ label, url, data, auto }) => ({ label, url, auto: Boolean(auto), fields: Object.keys(data).filter((k) => !SKIP.has(k)).length })),
        errors,
      };
    }),
  );
}
