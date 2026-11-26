// Lyrics: plain text, LRC (line synced) and enhanced LRC (word synced, <mm:ss.xx>).
// Stored in the file (USLT / SYLT / LYRICS) and, if wanted, as a .lrc next to it,
// which Navidrome, Feishin and most players pick up. Lookups score every
// candidate (title, artist, album, length) so you see how good a match is.
import fs from 'node:fs';
import * as settings from './settings.js';
import * as lib from './library/index.js';
import * as tags from './library/tags.js';
import { httpError, json, str, bool } from './lib/http.js';
import { requireUser } from './auth.js';
import { profileOf } from './library/routes.js';
import { audit } from './db.js';
import { VERSION } from './config.js';

const UA = `MasterMusicManager/${VERSION} (https://github.com/Master3307/master-music-manager)`;

// ---- format ----
const ts = (ms) => {
  const t = Math.max(0, Math.round(ms));
  return `${String(Math.floor(t / 60000)).padStart(2, '0')}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}.${String(Math.floor((t % 1000) / 10)).padStart(2, '0')}`;
};
const parseTs = (s) => {
  const m = String(s).match(/(\d+):(\d+)(?:[.:](\d+))?/);
  if (!m) return null;
  const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac;
};

/** LRC / enhanced LRC / plain → { lines: [{ start, end?, text, words?: [{ start, text }] }], meta, synced, offset } */
export function parse(text) {
  const meta = {};
  const lines = [];
  let synced = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tag = raw.match(/^\[(ti|ar|al|au|by|offset|length|re|ve|lang|#):(.*)\]\s*$/i);
    if (tag) {
      meta[tag[1].toLowerCase()] = tag[2].trim();
      continue;
    }
    const stamps = [...raw.matchAll(/\[(\d+:\d+(?:[.:]\d+)?)\]/g)];
    const rest = raw.replace(/\[(\d+:\d+(?:[.:]\d+)?)\]/g, '');
    const words = [...rest.matchAll(/<(\d+:\d+(?:[.:]\d+)?)>([^<]*)/g)].map((m) => ({ start: parseTs(m[1]), text: m[2] }));
    const plain = rest.replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim();
    if (stamps.length) {
      synced = true;
      for (const s of stamps) lines.push({ start: parseTs(s[1]), text: plain, ...(words.length ? { words } : {}) });
    } else if (raw.trim() || lines.length) lines.push({ start: null, text: raw.trim() });
  }
  if (synced) lines.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  for (let i = 0; i < lines.length - 1; i++) if (lines[i].start != null && lines[i + 1].start != null) lines[i].end = lines[i + 1].start;
  return { lines: synced ? lines.filter((l) => l.start != null) : lines, meta, synced, offset: Number(meta.offset) || 0, wordSynced: lines.some((l) => l.words) };
}

/** Lines → LRC text (enhanced when words have times). */
export function format({ lines, meta = {}, offset = 0, synced = true }) {
  const head = Object.entries({ ...meta, offset: offset || undefined, re: 'Master Music Manager' })
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `[${k}:${v}]`);
  if (!synced) return lines.map((l) => l.text).join('\n');
  const body = lines.map((l) => (l.words?.length ? `[${ts(l.start)}]${l.words.map((w) => `<${ts(w.start)}>${w.text}`).join('')}` : `[${ts(l.start ?? 0)}]${l.text}`));
  return [...head, ...body].join('\n');
}

/** Shift every time stamp (positive = later). */
export function shift(parsed, ms) {
  return { ...parsed, lines: parsed.lines.map((l) => ({ ...l, start: l.start == null ? null : Math.max(0, l.start + ms), end: l.end == null ? undefined : l.end + ms, words: l.words?.map((w) => ({ ...w, start: Math.max(0, w.start + ms) })) })) };
}

// ---- matching ----
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
function close(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0.5;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  let same = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] === y[i]) same++;
  return same / Math.max(x.length, y.length);
}
export function score(want, got) {
  const t = close(want.title, got.title);
  const a = close(want.artist, got.artist);
  const al = want.album && got.album ? close(want.album, got.album) : 0.7;
  let d = 0.6;
  if (want.duration && got.duration) {
    const diff = Math.abs(want.duration - got.duration);
    d = diff <= 2 ? 1 : diff <= 5 ? 0.75 : diff <= 15 ? 0.35 : 0;
  }
  return Math.round((t * 0.4 + a * 0.3 + al * 0.1 + d * 0.2) * 100);
}

export const PROVIDERS = {
  lrclib: { label: 'LRCLIB', synced: true, note: 'Open, community-made, synced lyrics. Best first choice.' },
  netease: { label: 'NetEase Cloud Music', synced: true, note: 'Huge catalogue, strong for Asian music; sometimes word-synced.' },
  lyricsovh: { label: 'lyrics.ovh', synced: false, note: 'Plain text only.' },
};

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

async function lrclib(want) {
  const q = new URLSearchParams({ track_name: want.title || '', artist_name: want.artist || '' });
  if (want.album) q.set('album_name', want.album);
  const list = await getJson(`https://lrclib.net/api/search?${q}`);
  return list.slice(0, 10).map((x) => ({
    provider: 'lrclib',
    id: String(x.id),
    title: x.trackName,
    artist: x.artistName,
    album: x.albumName,
    duration: x.duration,
    synced: Boolean(x.syncedLyrics),
    instrumental: x.instrumental,
    text: x.syncedLyrics || x.plainLyrics || (x.instrumental ? '[00:00.00]♪ Instrumental ♪' : ''),
  }));
}

async function netease(want) {
  const body = new URLSearchParams({ s: `${want.artist || ''} ${want.title || ''}`, type: '1', limit: '6' });
  const r = await getJson('https://music.163.com/api/search/get', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com' } });
  const songs = r.result?.songs || [];
  const out = [];
  for (const s of songs.slice(0, 5)) {
    try {
      const l = await getJson(`https://music.163.com/api/song/lyric?id=${s.id}&lv=1&yv=1&tv=-1`, { headers: { Referer: 'https://music.163.com' } });
      const text = l.lrc?.lyric || '';
      if (!text.trim()) continue;
      out.push({ provider: 'netease', id: String(s.id), title: s.name, artist: s.artists?.map((a) => a.name).join(', '), album: s.album?.name, duration: s.duration ? s.duration / 1000 : null, synced: /\[\d+:\d+/.test(text), text });
    } catch {}
  }
  return out;
}

async function lyricsovh(want) {
  const r = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(want.artist || '')}/${encodeURIComponent(want.title || '')}`);
  return r.lyrics ? [{ provider: 'lyricsovh', id: 'ovh', title: want.title, artist: want.artist, synced: false, text: r.lyrics.trim() }] : [];
}

export async function search(want, providers = Object.keys(PROVIDERS)) {
  if (!settings.online()) throw httpError(403, 'Privacy mode is on: lyric lookups are off');
  const fns = { lrclib, netease, lyricsovh };
  const results = await Promise.all(providers.filter((p) => fns[p]).map((p) => fns[p](want).catch((e) => [{ provider: p, error: e.message }])));
  return results
    .flat()
    .map((r) => (r.error ? r : { ...r, score: score(want, r), lines: parse(r.text).lines.length }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || Number(b.synced) - Number(a.synced));
}

// ---- reading / writing ----
export async function readFor(profile, track) {
  const abs = lib.absPath(profile, track.path);
  const lrcFile = abs.replace(/\.[^.]+$/, '.lrc');
  const out = [];
  if (fs.existsSync(lrcFile)) out.push({ source: 'lrc-file', ...parse(fs.readFileSync(lrcFile, 'utf8')), raw: fs.readFileSync(lrcFile, 'utf8') });
  const data = await tags.read(abs);
  for (const l of data.lyrics) {
    if (l.synced && l.syncText?.length) {
      const lines = l.syncText.map((s) => ({ start: s.timestamp, text: s.text }));
      out.push({ source: 'embedded-synced', language: l.language, descriptor: l.descriptor, synced: true, lines, offset: 0, raw: format({ lines }) });
    } else if (l.text) {
      const p = parse(l.text); // some taggers put LRC text into USLT
      out.push({ source: 'embedded', language: l.language, descriptor: l.descriptor, ...p, raw: l.text });
    }
  }
  return out;
}

export async function save(profile, track, { text, language = 'eng', descriptor = '', offset = 0, sidecar = true, embed = true, userId }) {
  let parsed = parse(text);
  if (offset) parsed = { ...parsed, meta: { ...parsed.meta }, offset };
  const abs = lib.absPath(profile, track.path);
  const lrcText = parsed.synced ? format({ ...parsed, offset: parsed.offset }) : text;
  if (sidecar && parsed.synced) fs.writeFileSync(abs.replace(/\.[^.]+$/, '.lrc'), `${lrcText}\n`);
  if (sidecar && !parsed.synced && fs.existsSync(abs.replace(/\.[^.]+$/, '.lrc'))) fs.rmSync(abs.replace(/\.[^.]+$/, '.lrc'));
  let result = null;
  if (embed) {
    // Times in the file already include the offset, since most players ignore [offset:].
    const applied = parsed.offset ? shift(parsed, -parsed.offset) : parsed;
    const lyrics = parsed.synced
      ? [
          { text: applied.lines.map((l) => l.text).join('\n'), language, descriptor },
          { language, descriptor, syncText: applied.lines.map((l) => ({ timestamp: l.start, text: l.text })) },
        ]
      : [{ text, language, descriptor }];
    result = await lib.applyEdit(profile, track, { lyrics, label: 'Before lyrics change', skipSeparators: true }, { organize: false, userId });
  }
  audit(userId, 'lyrics.save', { path: track.path, synced: parsed.synced, words: parsed.wordSynced });
  lib.touchService(profile);
  return { ok: true, synced: parsed.synced, lines: parsed.lines.length, track: result?.track };
}

export function register(app) {
  app.get('/api/lyrics/providers', requireUser, json(() => PROVIDERS));
  app.post('/api/lyrics/parse', requireUser, json((req) => parse(str(req.body.text, 500_000))));
  app.post(
    '/api/lyrics/search',
    requireUser,
    json((req) => search({ title: str(req.body.title, 300), artist: str(req.body.artist, 300), album: str(req.body.album, 300), duration: Number(req.body.duration) || null }, req.body.providers)),
  );
  app.get(
    '/api/p/:pid/tracks/:id/lyrics',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = lib.byId(p.id, req.params.id);
      if (!t) throw httpError(404, 'Track not found');
      return readFor(p, t);
    }),
  );
  app.put(
    '/api/p/:pid/tracks/:id/lyrics',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = lib.byId(p.id, req.params.id);
      if (!t) throw httpError(404, 'Track not found');
      return save(p, t, { text: str(req.body.text, 500_000), language: str(req.body.language, 3) || 'eng', descriptor: str(req.body.descriptor, 100), offset: Number(req.body.offset) || 0, sidecar: req.body.sidecar !== false, embed: req.body.embed !== false, userId: req.user.id });
    }),
  );
  app.delete(
    '/api/p/:pid/tracks/:id/lyrics',
    requireUser,
    json(async (req) => {
      const p = profileOf(req);
      const t = lib.byId(p.id, req.params.id);
      if (!t) throw httpError(404, 'Track not found');
      const lrc = lib.absPath(p, t.path).replace(/\.[^.]+$/, '.lrc');
      fs.rmSync(lrc, { force: true });
      if (!bool(req.query.keepEmbedded)) await lib.applyEdit(p, t, { lyrics: [], label: 'Before removing lyrics', skipSeparators: true }, { organize: false, userId: req.user.id });
      return { ok: true };
    }),
  );
}
