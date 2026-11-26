// Listening history: one table, filled from the Navidrome plugin, our own
// player, Navidrome's database, and imports (Last.fm, ListenBrainz, Spotify,
// Rockbox, any CSV / JSON). Imports merge: a listen that's already there
// (same song within 90 s) is never counted twice.
import fs from 'node:fs';
import express from 'express';
import { db, now, audit, tx } from './db.js';
import * as settings from './settings.js';
import * as jobs from './jobs.js';
import { httpError, json, str, bool } from './lib/http.js';
import { requireUser } from './auth.js';
import { take } from './uploads.js';
import { getProfile, canUse, forProfile } from './services/index.js';
import { splitArtists } from './library/naming.js';
import * as lib from './library/index.js';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

// ---- parsing every format we know ----
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const sep = (() => {
    const head = text.split(/\r?\n/, 1)[0];
    return [',', ';', '\t', '|'].map((s) => [s, head.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  })();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function toTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const t = Date.parse(String(v).replace(/^(\d{1,2}) (\w{3}) (\d{4}),? (\d{1,2}:\d{2})$/, '$2 $1 $3 $4 UTC'));
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

const COLS = {
  artist: ['artist', 'artist name', 'artistname', 'artist_name', 'master_metadata_album_artist_name', 'creator', 'artists', 'artist(s)'],
  title: ['track', 'title', 'track name', 'trackname', 'track_name', 'song', 'name', 'master_metadata_track_name', 'recording', 'song name'],
  album: ['album', 'album name', 'albumname', 'album_name', 'master_metadata_album_album_name', 'release', 'release_name'],
  albumArtist: ['album artist', 'albumartist', 'album_artist'],
  ts: ['date', 'time', 'timestamp', 'played_at', 'playedat', 'listened_at', 'ts', 'uts', 'utc_time', 'date#text', 'scrobble time', 'datetime', 'endtime', 'played'],
  duration: ['duration', 'length', 'ms_played', 'msplayed', 'duration_ms', 'seconds'],
  mbid: ['mbid', 'recording_mbid', 'track mbid', 'track_mbid'],
};
function mapColumns(header) {
  const h = header.map((x) => x.trim().toLowerCase());
  const m = {};
  for (const [k, names] of Object.entries(COLS)) {
    const i = h.findIndex((x) => names.includes(x));
    if (i >= 0) m[k] = i;
  }
  return m;
}

/** Turn any supported file into [{ ts, title, artist, album, duration }]. Returns { format, items }. */
export function parse(text, name = '') {
  const trimmed = text.trim();
  // Rockbox / portable players: .scrobbler.log
  if (/^#AUDIOSCROBBLER/m.test(trimmed)) {
    const items = trimmed
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('\t'))
      .filter((c) => c[5] !== 'S')
      .map((c) => ({ artist: c[0], album: c[1], title: c[2], duration: Number(c[4]) || null, ts: Number(c[6]) || null }));
    return { format: 'Rockbox .scrobbler.log', items };
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // JSON lines (ListenBrainz exports)
      data = trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    }
    if (!Array.isArray(data)) data = data.listens || data.payload?.listens || data.recenttracks?.track || data.scrobbles || data.items || data.tracks || [data];
    const first = data[0] || {};
    // Spotify extended streaming history.
    if ('master_metadata_track_name' in first || 'ms_played' in first) {
      const min = 30_000;
      return {
        format: 'Spotify streaming history',
        items: data
          .filter((d) => d.master_metadata_track_name && (d.ms_played ?? 0) >= min)
          .map((d) => ({ title: d.master_metadata_track_name, artist: d.master_metadata_album_artist_name, album: d.master_metadata_album_album_name, ts: toTs(d.ts), duration: d.ms_played ? d.ms_played / 1000 : null, spotify: d.spotify_track_uri })),
      };
    }
    // Spotify account data (StreamingHistory0.json).
    if ('trackName' in first && 'endTime' in first) {
      return { format: 'Spotify account data', items: data.filter((d) => (d.msPlayed ?? 0) >= 30_000).map((d) => ({ title: d.trackName, artist: d.artistName, ts: toTs(`${d.endTime}Z`), duration: d.msPlayed / 1000 })) };
    }
    // ListenBrainz.
    if ('listened_at' in first || 'track_metadata' in first) {
      return {
        format: 'ListenBrainz',
        items: data.map((d) => ({ ts: toTs(d.listened_at), title: d.track_metadata?.track_name, artist: d.track_metadata?.artist_name, album: d.track_metadata?.release_name, mbid: d.track_metadata?.additional_info?.recording_mbid || d.track_metadata?.mbid_mapping?.recording_mbid, duration: d.track_metadata?.additional_info?.duration_ms ? d.track_metadata.additional_info.duration_ms / 1000 : null })),
      };
    }
    // Last.fm API JSON (user.getRecentTracks pages).
    if (first.date?.uts || first['@attr']) {
      return { format: 'Last.fm JSON', items: data.filter((d) => d.date?.uts).map((d) => ({ ts: Number(d.date.uts), title: d.name, artist: d.artist?.['#text'] || d.artist?.name, album: d.album?.['#text'], mbid: d.mbid || null })) };
    }
    // Our own export / Spindle / anything with obvious keys.
    const pick = (o, names) => {
      for (const n of names) {
        const k = Object.keys(o).find((x) => x.toLowerCase() === n);
        if (k && o[k] != null && o[k] !== '') return typeof o[k] === 'object' ? o[k].name || o[k]['#text'] || o[k].title : o[k];
      }
      return null;
    };
    return {
      format: 'JSON',
      items: data.map((d) => ({ ts: toTs(pick(d, COLS.ts)), title: pick(d, COLS.title), artist: pick(d, COLS.artist), album: pick(d, COLS.album), albumArtist: pick(d, COLS.albumArtist), duration: Number(pick(d, COLS.duration)) || null, mbid: pick(d, COLS.mbid) })),
    };
  }
  // CSV / TSV
  const rows = parseCsv(text);
  if (!rows.length) return { format: 'empty', items: [] };
  let m = mapColumns(rows[0]);
  let body = rows.slice(1);
  if (m.title === undefined || m.artist === undefined) {
    // lastfm-to-csv exports have no header: artist, album, track, date
    if (rows[0].length >= 4 && toTs(rows[0][3])) {
      m = { artist: 0, album: 1, title: 2, ts: 3 };
      body = rows;
    } else throw httpError(400, 'Could not find artist and title columns. Name them "artist" and "title" (or "track").');
  }
  const durIsMs = m.duration !== undefined && /ms/i.test(rows[0][m.duration] || '');
  return {
    format: name.toLowerCase().includes('lastfm') || m.ts === 3 ? 'Last.fm CSV' : 'CSV',
    items: body.map((r) => ({ artist: r[m.artist], title: r[m.title], album: m.album !== undefined ? r[m.album] : null, albumArtist: m.albumArtist !== undefined ? r[m.albumArtist] : null, ts: m.ts !== undefined ? toTs(r[m.ts]) : null, duration: m.duration !== undefined ? Number(r[m.duration]) / (durIsMs ? 1000 : 1) || null : null, mbid: m.mbid !== undefined ? r[m.mbid] : null })),
  };
}

/** Insert listens, skipping ones we already have (same song within 90 s). */
export function merge(items, { profileId, username, source }) {
  const valid = items.filter((i) => i.title && i.artist && i.ts && i.ts > 946684800 && i.ts < Date.now() / 1000 + 86400);
  const near = db.prepare('SELECT title, artist FROM scrobbles WHERE ts BETWEEN ? AND ? AND (username = ? OR ? IS NULL)');
  const ins = db.prepare('INSERT OR IGNORE INTO scrobbles (profile_id, username, ts, title, artist, album, album_artist, duration, mbid, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  let skipped = 0;
  tx(() => {
    for (const i of valid) {
      const close = near.all(i.ts - 90, i.ts + 90, username ?? null, username ?? null);
      if (close.some((c) => norm(c.title) === norm(i.title) && norm(c.artist).slice(0, 12) === norm(i.artist).slice(0, 12))) {
        skipped++;
        continue;
      }
      const r = ins.run(profileId ?? null, username ?? null, i.ts, String(i.title).slice(0, 500), String(i.artist).slice(0, 500), i.album ? String(i.album).slice(0, 500) : null, i.albumArtist || null, i.duration || null, i.mbid || null, source);
      if (r.changes) added++;
      else skipped++;
    }
  });
  return { added, skipped, invalid: items.length - valid.length };
}

// ---- statistics ----
function range(period, from, to) {
  const n = Math.floor(Date.now() / 1000);
  const d = 86400;
  if (from || to) return [Number(from) || 0, Number(to) || n];
  const y = new Date().getFullYear();
  return (
    {
      day: [n - d, n],
      week: [n - 7 * d, n],
      month: [n - 30 * d, n],
      quarter: [n - 91 * d, n],
      halfyear: [n - 182 * d, n],
      year: [n - 365 * d, n],
      thisyear: [Math.floor(new Date(y, 0, 1) / 1000), n],
      lastyear: [Math.floor(new Date(y - 1, 0, 1) / 1000), Math.floor(new Date(y, 0, 1) / 1000)],
      all: [0, n],
    }[period] || [0, n]
  );
}

export function stats({ period = 'year', from, to, username, profileId, limit = 50 } = {}) {
  const [a, b] = range(period, from, to);
  const where = 'ts >= ? AND ts < ?' + (username ? ' AND username = ?' : '') + (profileId ? ' AND (profile_id = ? OR profile_id IS NULL)' : '');
  const args = [a, b, ...(username ? [username] : []), ...(profileId ? [profileId] : [])];
  const rows = db.prepare(`SELECT ts, title, artist, album, album_artist, duration FROM scrobbles WHERE ${where} ORDER BY ts`).all(...args);
  // Durations: from the listen, else from the library, else 3:30.
  const lengths = new Map();
  if (profileId) for (const t of lib.all(profileId)) if (t.duration) lengths.set(`${norm(t.title)}|${norm(t.artist)}`, t.duration);
  const lenOf = (r) => r.duration || lengths.get(`${norm(r.title)}|${norm(r.artist)}`) || 210;
  const lc = settings.get('library');
  const tally = (keyFn, labelFn) => {
    const m = new Map();
    for (const r of rows) {
      for (const k of [].concat(keyFn(r))) {
        if (!k) continue;
        const id = norm(k.id ?? k);
        if (!m.has(id)) m.set(id, { ...labelFn(r, k), plays: 0, seconds: 0, first: r.ts, last: r.ts });
        const e = m.get(id);
        e.plays++;
        e.seconds += lenOf(r);
        e.last = r.ts;
      }
    }
    return [...m.values()].sort((x, y) => y.plays - x.plays);
  };
  const artists = tally(
    (r) => splitArtists(r.artist, lc),
    (_r, k) => ({ name: k }),
  );
  const tracks = tally(
    (r) => ({ id: `${r.title}|${splitArtists(r.artist, lc)[0]}` }),
    (r) => ({ title: r.title, artist: r.artist, album: r.album }),
  );
  const albums = tally(
    (r) => (r.album ? { id: `${r.album}|${r.album_artist || splitArtists(r.artist, lc)[0]}` } : null),
    (r) => ({ name: r.album, artist: r.album_artist || splitArtists(r.artist, lc)[0] }),
  );
  // Genres from the library tags.
  const genreOf = new Map();
  if (profileId) for (const t of lib.all(profileId)) if (t.genre?.length) genreOf.set(`${norm(t.title)}|${norm(t.artist)}`, t.genre);
  const genres = tally(
    (r) => genreOf.get(`${norm(r.title)}|${norm(r.artist)}`) || [],
    (_r, k) => ({ name: k }),
  );
  const seconds = rows.reduce((s, r) => s + lenOf(r), 0);
  // Heatmap: weekday × hour (local time of the server).
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const perDay = new Map();
  for (const r of rows) {
    const d = new Date(r.ts * 1000);
    heat[d.getDay()][d.getHours()]++;
    const day = d.toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  // Streaks.
  const days = [...perDay.keys()].sort();
  let best = 0;
  let cur = 0;
  let bestEnd = null;
  let prev = null;
  for (const dStr of days) {
    const t = Date.parse(dStr);
    cur = prev && t - prev === 86400e3 ? cur + 1 : 1;
    if (cur > best) {
      best = cur;
      bestEnd = dStr;
    }
    prev = t;
  }
  const today = new Date().toISOString().slice(0, 10);
  let current = 0;
  for (let t = Date.parse(today); perDay.has(new Date(t).toISOString().slice(0, 10)); t -= 86400e3) current++;
  // Discoveries: artists whose first listen ever is inside the range.
  const firstEver = new Map(db.prepare('SELECT artist, MIN(ts) t FROM scrobbles GROUP BY artist').all().map((r) => [norm(splitArtists(r.artist, lc)[0]), r.t]));
  const discovered = artists.filter((x) => (firstEver.get(norm(x.name)) ?? 0) >= a).slice(0, 20);
  const busiest = [...perDay].sort((x, y) => y[1] - x[1])[0];
  const hourTotals = heat.reduce((acc, row) => row.map((v, i) => acc[i] + v), Array(24).fill(0));
  const peakHour = hourTotals.indexOf(Math.max(...hourTotals));
  const timeline = [...perDay].sort().map(([day, plays]) => ({ day, plays }));
  const prevRange = [a - (b - a), a];
  const prevPlays = db.prepare(`SELECT COUNT(*) n FROM scrobbles WHERE ts >= ? AND ts < ?${username ? ' AND username = ?' : ''}`).get(...prevRange, ...(username ? [username] : [])).n;
  return {
    range: { from: a, to: b, period },
    plays: rows.length,
    previousPlays: prevPlays,
    seconds,
    uniqueTracks: tracks.length,
    uniqueArtists: artists.length,
    uniqueAlbums: albums.length,
    topArtists: artists.slice(0, limit),
    topTracks: tracks.slice(0, limit),
    topAlbums: albums.slice(0, limit),
    topGenres: genres.slice(0, limit),
    heatmap: heat,
    peakHour,
    busiestDay: busiest ? { day: busiest[0], plays: busiest[1] } : null,
    streak: { best, bestEnd, current },
    discovered,
    timeline,
    firstListen: rows[0] || null,
    sources: db.prepare(`SELECT source, COUNT(*) n FROM scrobbles WHERE ${where} GROUP BY source`).all(...args),
  };
}

/** Facts about the library itself (no listening needed). */
export function libraryStats(profileId) {
  const list = lib.all(profileId);
  const lc = settings.get('library');
  const artists = new Map();
  for (const t of list) {
    for (const a of splitArtists(t.artist, lc)) {
      const k = norm(a);
      if (!artists.has(k)) artists.set(k, { name: a, tracks: 0, seconds: 0, albums: new Set() });
      const e = artists.get(k);
      e.tracks++;
      e.seconds += t.duration || 0;
      if (t.album) e.albums.add(t.album);
    }
  }
  const years = new Map();
  for (const t of list) if (t.year) years.set(Math.floor(t.year / 10) * 10, (years.get(Math.floor(t.year / 10) * 10) || 0) + 1);
  const longest = list.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
  const shortest = list.filter((t) => t.duration > 5).sort((a, b) => a.duration - b.duration)[0];
  const added = new Map();
  for (const t of list) {
    const m = new Date(t.added).toISOString().slice(0, 7);
    added.set(m, (added.get(m) || 0) + 1);
  }
  return {
    ...lib.stats(profileId),
    artistsByTracks: [...artists.values()].map((x) => ({ ...x, albums: x.albums.size })).sort((a, b) => b.tracks - a.tracks).slice(0, 100),
    decades: [...years].sort((a, b) => a[0] - b[0]).map(([decade, tracks]) => ({ decade, tracks })),
    longest: longest && { title: longest.title, artist: longest.artist, duration: longest.duration },
    shortest: shortest && { title: shortest.title, artist: shortest.artist, duration: shortest.duration },
    addedPerMonth: [...added].sort().map(([month, tracks]) => ({ month, tracks })),
    bitrates: bucket(list.map((t) => t.bitrate).filter(Boolean), [128, 192, 256, 320, 1000, 99999], ['≤128', '≤192', '≤256', '≤320', 'lossless-ish', 'hi-res']),
  };
}
function bucket(values, edges, labels) {
  const out = labels.map((label) => ({ label, count: 0 }));
  for (const v of values) out[edges.findIndex((e) => v <= e)].count++;
  return out;
}

// ---- exporting ----
export function exportAs(rows, format) {
  if (format === 'json') return JSON.stringify(rows.map((r) => ({ ts: r.ts, date: new Date(r.ts * 1000).toISOString(), artist: r.artist, title: r.title, album: r.album, duration: r.duration, source: r.source })), null, 1);
  if (format === 'listenbrainz') return rows.map((r) => JSON.stringify({ listened_at: r.ts, track_metadata: { artist_name: r.artist, track_name: r.title, release_name: r.album || undefined, additional_info: { duration_ms: r.duration ? Math.round(r.duration * 1000) : undefined, submission_client: 'Master Music Manager' } } })).join('\n');
  if (format === 'scrobbler-log') return `#AUDIOSCROBBLER/1.1\n#TZ/UTC\n#CLIENT/Master Music Manager\n${rows.map((r) => [r.artist, r.album || '', r.title, '', Math.round(r.duration || 0), 'L', r.ts, r.mbid || ''].join('\t')).join('\n')}\n`;
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  if (format === 'lastfm-csv') return rows.map((r) => [q(r.artist), q(r.album), q(r.title), q(new Date(r.ts * 1000).toUTCString().replace(/^\w+, /, '').replace(/:\d\d GMT$/, ''))].join(',')).join('\n');
  return `﻿date,timestamp,artist,title,album,album artist,duration,source\n${rows.map((r) => [new Date(r.ts * 1000).toISOString(), r.ts, q(r.artist), q(r.title), q(r.album), q(r.album_artist), r.duration ?? '', r.source].join(',')).join('\n')}`;
}

// ---- Last.fm (optional, online) ----
async function lastfmImport(user, apiKey, ctx, opts) {
  let page = 1;
  let pages = 1;
  let total = { added: 0, skipped: 0 };
  const from = opts.from ? `&from=${opts.from}` : '';
  while (page <= pages) {
    ctx.check();
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(user)}&api_key=${encodeURIComponent(apiKey)}&format=json&limit=200&page=${page}${from}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) }).then((x) => x.json());
    if (r.error) throw new Error(`Last.fm: ${r.message}`);
    pages = Number(r.recenttracks['@attr'].totalPages) || 1;
    const items = parse(JSON.stringify(r.recenttracks.track)).items;
    const res = merge(items, { ...opts, source: 'lastfm' });
    total = { added: total.added + res.added, skipped: total.skipped + res.skipped };
    ctx.progress(page / pages, `Page ${page} of ${pages}: ${total.added} new`);
    page++;
    await new Promise((res2) => setTimeout(res2, 220)); // stay under 5 requests/s
  }
  return total;
}

export function register(app) {
  app.get(
    '/api/scrobbles',
    requireUser,
    json((req) => {
      const limit = Math.min(Number(req.query.limit) || 100, 1000);
      const offset = Number(req.query.offset) || 0;
      const q = str(req.query.q, 200);
      const where = q ? 'WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?' : '';
      const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
      return {
        total: db.prepare(`SELECT COUNT(*) n FROM scrobbles ${where}`).get(...args).n,
        items: db.prepare(`SELECT * FROM scrobbles ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args, limit, offset),
      };
    }),
  );
  app.delete(
    '/api/scrobbles',
    requireUser,
    json((req) => {
      const ids = (req.body?.ids || []).map(Number);
      if (ids.length) {
        tx(() => ids.forEach((id) => db.prepare('DELETE FROM scrobbles WHERE id = ?').run(id)));
        return { removed: ids.length };
      }
      if (req.query.source) return { removed: db.prepare('DELETE FROM scrobbles WHERE source = ?').run(String(req.query.source)).changes };
      throw httpError(400, 'Pick listens to remove');
    }),
  );
  // Remove listens that are the same song within 90 s (after messy imports).
  app.post(
    '/api/scrobbles/dedupe',
    requireUser,
    json(() => {
      const rows = db.prepare('SELECT id, ts, title, artist FROM scrobbles ORDER BY ts').all();
      const drop = [];
      for (let i = 1; i < rows.length; i++) {
        for (let j = i - 1; j >= 0 && rows[i].ts - rows[j].ts <= 90; j--) {
          if (norm(rows[i].title) === norm(rows[j].title) && norm(rows[i].artist) === norm(rows[j].artist)) {
            drop.push(rows[i].id);
            break;
          }
        }
      }
      tx(() => drop.forEach((id) => db.prepare('DELETE FROM scrobbles WHERE id = ?').run(id)));
      return { removed: drop.length };
    }),
  );

  app.get('/api/stats/listening', requireUser, json((req) => stats({ period: str(req.query.period, 20) || 'year', from: req.query.from, to: req.query.to, username: req.query.user || undefined, profileId: req.query.profile || undefined, limit: Math.min(Number(req.query.limit) || 50, 500) })));
  app.get(
    '/api/stats/library/:pid',
    requireUser,
    json((req) => {
      const p = getProfile(req.params.pid);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      return libraryStats(p.id);
    }),
  );
  app.get(
    '/api/stats/users',
    requireUser,
    json(() => db.prepare('SELECT username, COUNT(*) plays, MIN(ts) first, MAX(ts) last FROM scrobbles GROUP BY username ORDER BY plays DESC').all()),
  );

  // Import: a finished upload (any size) or a small text body.
  app.post(
    '/api/scrobbles/import',
    requireUser,
    express.text({ type: '*/*', limit: '60mb' }),
    json((req) => {
      let text;
      let name = str(req.query.name, 200);
      if (req.query.upload) {
        const u = take(String(req.query.upload), req.user.id);
        text = fs.readFileSync(u.file, 'utf8');
        name = u.name;
        fs.rmSync(u.file, { force: true });
      } else text = typeof req.body === 'string' ? req.body : '';
      if (!text) throw httpError(400, 'The file is empty');
      const parsed = parse(text, name);
      const opts = { profileId: str(req.query.profile, 64) || null, username: str(req.query.user, 128) || null, source: str(req.query.source, 40) || parsed.format.toLowerCase().replace(/\W+/g, '-') };
      if (bool(req.query.preview)) {
        return { format: parsed.format, count: parsed.items.length, sample: parsed.items.slice(0, 20), first: Math.min(...parsed.items.map((i) => i.ts || Infinity)), last: Math.max(...parsed.items.map((i) => i.ts || 0)) };
      }
      const r = merge(parsed.items, opts);
      audit(req.user.id, 'scrobbles.import', { format: parsed.format, ...r });
      return { format: parsed.format, ...r };
    }),
  );

  app.post(
    '/api/scrobbles/lastfm',
    requireUser,
    json((req) => {
      if (!settings.online('lastfm')) throw httpError(403, 'Last.fm is switched off (privacy settings)');
      const user = str(req.body.user, 100);
      const key = str(req.body.apiKey, 100) || settings.get('privacy').lastfmKey;
      if (!user || !key) throw httpError(400, 'Enter your Last.fm user name and an API key (last.fm/api/account/create, free)');
      return { job: jobs.start('scrobbles', `Last.fm import · ${user}`, (ctx) => lastfmImport(user, key, ctx, { username: str(req.body.as, 100) || null, profileId: req.body.profileId || null, from: req.body.from }), { userId: req.user.id }) };
    }),
  );

  // Push imported listens to the music service, so its play counts match.
  app.post(
    '/api/scrobbles/push',
    requireUser,
    json((req) => {
      const p = getProfile(req.body.profileId);
      if (!canUse(req.user, p) || !p.url) throw httpError(400, 'Pick a profile with a music service');
      const since = Number(req.body.since) || 0;
      const sources = req.body.sources || null;
      return {
        job: jobs.start(
          'scrobbles',
          `Sending listens to ${p.name}`,
          async (ctx) => {
            const rows = db.prepare(`SELECT * FROM scrobbles WHERE ts >= ? ${sources ? `AND source IN (${sources.map(() => '?').join(',')})` : ''} ORDER BY ts`).all(since, ...(sources || []));
            const s = forProfile(p);
            const index = new Map();
            for (const t of lib.all(p.id)) if (t.remoteId) index.set(`${norm(t.title)}|${norm(splitArtists(t.artist, settings.get('library'))[0])}`, t.remoteId);
            let sent = 0;
            let missing = 0;
            for (const [i, r] of rows.entries()) {
              ctx.check();
              let id = r.remote_id || index.get(`${norm(r.title)}|${norm(splitArtists(r.artist, settings.get('library'))[0])}`);
              if (!id) {
                try {
                  const found = await s.search(`${r.artist} ${r.title}`, 3);
                  id = found.songs.find((x) => norm(x.title) === norm(r.title))?.id;
                } catch {}
              }
              if (!id) {
                missing++;
                continue;
              }
              await s.scrobble(id, { time: r.ts * 1000, submission: true }).then(() => sent++, () => missing++);
              if (i % 25 === 0) ctx.progress(i / rows.length, `${sent} sent, ${missing} not in the library`);
            }
            return { sent, missing };
          },
          { userId: req.user.id },
        ),
      };
    }),
  );

  app.get('/api/scrobbles/export', requireUser, (req, res) => {
    const format = String(req.query.format || 'csv');
    const [a, b] = range(String(req.query.period || 'all'));
    const rows = db.prepare('SELECT * FROM scrobbles WHERE ts >= ? AND ts < ? ORDER BY ts').all(a, b);
    const ext = { json: 'json', listenbrainz: 'jsonl', 'scrobbler-log': 'log', 'lastfm-csv': 'csv', csv: 'csv' }[format] || 'csv';
    res.attachment(format === 'scrobbler-log' ? '.scrobbler.log' : `listens.${ext}`).send(exportAs(rows, format));
  });

  // Read Navidrome's own scrobble history from its database (same machine).
  app.post(
    '/api/scrobbles/navidrome-db',
    requireUser,
    json(async (req) => {
      const { importFromNavidromeDb } = await import('./navidromeDb.js');
      const p = getProfile(req.body.profileId);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      return { job: jobs.start('scrobbles', 'Reading Navidrome’s database', (ctx) => importFromNavidromeDb({ file: req.body.file, profile: p, ctx }), { userId: req.user.id }) };
    }),
  );
  void now;
}
