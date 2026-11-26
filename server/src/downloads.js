// Getting music from the web. Spotify links go through spotDL (Spotify gives
// the metadata, YouTube Music / YouTube the audio, with the same strict matching
// the old spotify-dl script used); everything else through yt-dlp. Downloads
// land in the inbox so the metadata can be checked before importing.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { PATHS } from './config.js';
import * as settings from './settings.js';
import * as jobs from './jobs.js';
import { ingest, importItems } from './inbox.js';
import { httpError, json, str, bool } from './lib/http.js';
import { requireUser, requireAdmin } from './auth.js';
import { db, audit } from './db.js';
import { getProfile, canUse } from './services/index.js';

const BIN_DIR = path.join(PATHS.data, 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });
process.env.PATH = `${BIN_DIR}:${path.join(os.homedir(), '.local/bin')}:${process.env.PATH}`;

export const SOURCES = [
  // "audio link|Spotify link": the sound from the first, every tag and the cover from Spotify.
  { id: 'pair', label: 'YouTube + Spotify', match: /^\s*\S+\s*\|\s*\S*spotify\S*\s*$|^\s*\S*spotify\S*\s*\|\s*\S+\s*$/i, tool: 'spotdl', hint: 'Audio from the first link, names and cover from the Spotify one. Either order works.' },
  { id: 'spotify', label: 'Spotify', match: /open\.spotify\.com|spotify:|spotify\.link/i, tool: 'spotdl', hint: 'Track, album, playlist or artist link. Metadata from Spotify, audio from YouTube Music.' },
  { id: 'ytmusic', label: 'YouTube Music', match: /music\.youtube\.com/i, tool: 'yt-dlp', hint: 'Songs, albums and playlists.' },
  { id: 'youtube', label: 'YouTube', match: /youtube\.com|youtu\.be/i, tool: 'yt-dlp', hint: 'Videos and playlists. Music videos can become animated covers.' },
  { id: 'soundcloud', label: 'SoundCloud', match: /soundcloud\.com/i, tool: 'yt-dlp', hint: 'Tracks, sets and profiles.' },
  { id: 'bandcamp', label: 'Bandcamp', match: /bandcamp\.com/i, tool: 'yt-dlp', hint: 'Free / name-your-price streams in their stream quality.' },
  { id: 'deezer', label: 'Deezer', match: /deezer\.com|deezer\.page\.link/i, tool: 'spotdl', hint: 'Matched like Spotify links.' },
  { id: 'apple', label: 'Apple Music', match: /music\.apple\.com/i, tool: 'yt-dlp', hint: 'Matched on YouTube Music by name.' },
  { id: 'mixcloud', label: 'Mixcloud', match: /mixcloud\.com/i, tool: 'yt-dlp' },
  { id: 'audiomack', label: 'Audiomack', match: /audiomack\.com/i, tool: 'yt-dlp' },
  { id: 'vimeo', label: 'Vimeo', match: /vimeo\.com/i, tool: 'yt-dlp' },
  { id: 'tiktok', label: 'TikTok', match: /tiktok\.com/i, tool: 'yt-dlp' },
  { id: 'twitch', label: 'Twitch', match: /twitch\.tv/i, tool: 'yt-dlp' },
  { id: 'nicovideo', label: 'Niconico', match: /nicovideo\.jp/i, tool: 'yt-dlp' },
  { id: 'bilibili', label: 'Bilibili', match: /bilibili\.com/i, tool: 'yt-dlp' },
  { id: 'web', label: 'Any other site', match: /^https?:\/\//i, tool: 'yt-dlp', hint: 'yt-dlp knows about 1800 sites; plain file links work too.' },
  { id: 'search', label: 'Search by name', match: /.*/, tool: 'yt-dlp', hint: '"Artist - Title" is searched on YouTube Music.' },
];

export const detectSource = (input) => SOURCES.find((s) => s.match.test(String(input).trim())) || SOURCES.at(-1);

function which(bin) {
  return new Promise((resolve) => execFile('sh', ['-c', `command -v "${bin}"`], (e, out) => resolve(e ? null : out.trim())));
}
async function version(bin, args = ['--version']) {
  return new Promise((resolve) => execFile(bin, args, { timeout: 20000 }, (e, out, err) => resolve(e ? null : (out || err).trim().split('\n').pop())));
}

export async function tools() {
  const d = settings.get('downloads');
  const [spot, ytdlp, ffmpeg, fpcalc] = await Promise.all([which(d.spotdlBin), which(d.ytdlpBin), which('ffmpeg'), which('fpcalc')]);
  return {
    spotdl: { path: spot, version: spot ? await version(spot) : null, install: 'pipx install spotdl   (or: python3 -m pip install --user spotdl)' },
    ytdlp: { path: ytdlp, version: ytdlp ? await version(ytdlp) : null, install: 'Installs the official single-file yt-dlp into the app folder' },
    ffmpeg: { path: ffmpeg, version: ffmpeg ? (await version('ffmpeg', ['-version']))?.split(' ')[2] || 'yes' : null, install: 'sudo apt install ffmpeg' },
    shazamio: { path: fs.existsSync(path.join(PATHS.data, 'venv-shazam/bin/python')) ? path.join(PATHS.data, 'venv-shazam') : null, version: null, install: 'Unofficial Shazam for recognizing songs (optional, may break)' },
    fpcalc: { path: fpcalc, version: fpcalc ? await version('fpcalc', ['-version']) : null, install: 'sudo apt install libchromaprint-tools (needed to recognize songs)' },
  };
}

function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*[[(](official\s*(music\s*)?(video|audio|lyric(s)?\s*video|visualizer)|lyrics?|hd|hq|4k|mv|m\/v|audio)[)\]]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** yt-dlp metadata (info.json) → our tags. */
function metaFromInfo(info) {
  const artist = info.artist || info.artists?.join(' / ') || info.creator || (info.channel || info.uploader || '').replace(/\s*-\s*Topic$/i, '');
  let title = info.track || cleanTitle(info.title);
  let a = artist;
  if (!info.track && / [-–] /.test(title)) {
    const [x, ...rest] = title.split(/ [-–] /);
    a = x.trim();
    title = rest.join(' - ').trim();
  }
  return {
    title,
    artist: a,
    album: info.album || undefined,
    albumartist: info.album_artist || undefined,
    year: info.release_year || (info.upload_date ? Number(info.upload_date.slice(0, 4)) : undefined),
    track: info.track_number || info.playlist_index || undefined,
    genre: info.genre ? [info.genre] : undefined,
    comment: info.webpage_url,
    website: info.webpage_url,
  };
}

export function start({ input, profileId, autoImport, video, userId, extra = {} }) {
  const d = settings.get('downloads');
  const conv = settings.get('convert');
  const src = extra.source ? SOURCES.find((s) => s.id === extra.source) || detectSource(input) : detectSource(input);
  const work = path.join(PATHS.inbox, `dl-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  const title = `${src.label}: ${String(input).slice(0, 80)}`;
  return jobs.start(
    'download',
    title,
    async (ctx) => {
      ctx.log(`Source: ${src.label} (${src.tool})`);
      const env = { ...process.env, PYTHONUNBUFFERED: '1' };
      let seen = 0;
      const ids = [];
      // Ingest files as soon as each one finishes, like spotify-dl's autosave.
      const pick = async () => {
        const files = (await fsp.readdir(work)).filter((f) => !/\.(part|ytdl|json|jpg|webp|png|temp|tmp|lrc)$/i.test(f) && !f.startsWith('.'));
        for (const f of files) {
          const full = path.join(work, f);
          const infoFile = full.replace(/\.[^.]+$/, '.info.json');
          let meta = {};
          if (fs.existsSync(infoFile)) {
            try {
              meta = metaFromInfo(JSON.parse(fs.readFileSync(infoFile, 'utf8')));
            } catch {}
          }
          const thumb = ['.jpg', '.webp', '.png'].map((e) => full.replace(/\.[^.]+$/, e)).find((x) => fs.existsSync(x));
          try {
            const id = await ingest(full, { source: src.id, sourceUrl: meta.website || input, name: f, jobId: ctx.id, profileId, userId, ctx, meta });
            if (thumb) {
              const { setCover } = await import('./inbox.js');
              setCover(id, fs.readFileSync(thumb), `image/${path.extname(thumb).slice(1).replace('jpg', 'jpeg')}`, src.id);
              fs.rmSync(thumb, { force: true });
            }
            fs.rmSync(infoFile, { force: true });
            ids.push(id);
            seen++;
            ctx.detail(`${seen} downloaded`);
          } catch (e) {
            ctx.log(`! ${f}: ${e.message}`);
            fs.rmSync(full, { force: true });
          }
        }
      };
      const watcher = setInterval(() => pick().catch(() => {}), 4000);
      try {
        if (src.tool === 'spotdl') {
          const fmt = ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'wav'].includes(conv.format) ? conv.format : 'mp3';
          // spotDL wants "audio|spotify"; accept the other order too.
          let target = String(input).trim();
          if (src.id === 'pair') {
            const [x, y] = target.split('|').map((t) => t.trim());
            target = /spotify/i.test(x) ? `${y}|${x}` : `${x}|${y}`;
          }
          const args = ['download', target, '--output', path.join(work, '{artists} - {title}.{output-ext}'), '--format', fmt, '--threads', String(d.threads || 2), '--audio', ...String(d.providers || 'youtube-music youtube').split(/\s+/).filter(Boolean), '--search-query', d.searchQuery || '{artist} - {title}', '--print-errors'];
          if (fmt === 'mp3') args.push('--bitrate', conv.mp3Mode === 'cbr' ? `${conv.bitrate}k` : 'disable');
          if (!d.filterResults) args.push('--dont-filter-results');
          if (d.cookies && fs.existsSync(d.cookies)) args.push('--cookie-file', d.cookies);
          if (d.extraArgs) args.push(...d.extraArgs.split(/\s+/).filter(Boolean));
          await ctx.run(d.spotdlBin || 'spotdl', args, {
            env,
            onData: (s) => {
              const m = s.match(/(\d+)\/(\d+)\s+complete/i);
              if (m) ctx.progress(Number(m[1]) / Number(m[2]), `${m[1]} / ${m[2]}`);
            },
          });
        } else {
          const isSearch = src.id === 'search' || src.id === 'apple';
          const target = isSearch ? `https://music.youtube.com/search?q=${encodeURIComponent(src.id === 'apple' ? await appleToQuery(input) : input)}` : String(input).trim();
          const wantVideo = video ?? (conv.animatedCovers && src.id === 'youtube');
          const args = [
            '--no-colors', '--newline', '--ignore-errors', '--no-overwrites', '--write-info-json', '--write-thumbnail', '--convert-thumbnails', 'jpg',
            '-o', path.join(work, '%(playlist_index&{} - |)s%(artist,uploader|Unknown)s - %(track,title)s [%(id)s].%(ext)s'),
            '-f', wantVideo ? 'bv*[height<=1080]+ba/b' : 'ba/b', '--merge-output-format', 'mkv',
          ];
          if (isSearch) args.push('--playlist-items', '1');
          if (d.cookies && fs.existsSync(d.cookies)) args.push('--cookies', d.cookies);
          if (d.extraArgs) args.push(...d.extraArgs.split(/\s+/).filter(Boolean));
          args.push(target);
          await ctx.run(d.ytdlpBin || 'yt-dlp', args, {
            env,
            allowFail: true,
            onData: (s) => {
              const item = s.match(/Downloading item (\d+) of (\d+)/);
              if (item) ctx.detail(`Item ${item[1]} of ${item[2]}`);
              const pct = s.match(/\[download\]\s+([\d.]+)%/);
              if (pct) ctx.progress(Number(pct[1]) / 100);
            },
          });
        }
      } finally {
        clearInterval(watcher);
      }
      await pick();
      fs.rmSync(work, { recursive: true, force: true });
      if (!ids.length) throw new Error('Nothing was downloaded. Open the details to see why.');
      audit(userId, 'download', { source: src.id, count: ids.length });
      if (autoImport ?? !d.reviewBeforeImport) {
        const p = getProfile(profileId);
        if (p?.local_path) {
          const imp = importItems(ids, { profileId, userId });
          ctx.log(`Importing straight away (job ${imp})`);
          await jobs.wait(imp);
        } else ctx.log('Waiting in the inbox: pick a library to import into.');
      } else ctx.log('Waiting in the inbox for you to check the details.');
      return { items: ids, count: ids.length };
    },
    { userId },
  );
}

async function appleToQuery(url) {
  // Apple Music pages carry the song in their title.
  try {
    const html = await fetch(url, { signal: AbortSignal.timeout(10000) }).then((r) => r.text());
    const t = html.match(/<title>(.*?)<\/title>/i)?.[1] || '';
    return t.replace(/ on Apple Music.*$/i, '').replace(/^(.*?) by (.*)$/, '$2 - $1').replace(/&amp;/g, '&');
  } catch {
    return url;
  }
}

async function installTool(name, ctx) {
  if (name === 'ytdlp') {
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    ctx.log(`Downloading ${url}`);
    const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const file = path.join(BIN_DIR, 'yt-dlp');
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()), { mode: 0o755 });
    settings.set('downloads', { ytdlpBin: file });
    ctx.log(`Installed to ${file}`);
    return { path: file };
  }
  if (name === 'spotdl') {
    for (const [bin, args] of [
      ['pipx', ['install', '--force', 'spotdl']],
      ['python3', ['-m', 'pip', 'install', '--user', '--upgrade', 'spotdl']],
      ['python3', ['-m', 'pip', 'install', '--user', '--upgrade', '--break-system-packages', 'spotdl']],
    ]) {
      try {
        await ctx.run(bin, args);
        const p = await which('spotdl');
        if (p) {
          settings.set('downloads', { spotdlBin: p });
          ctx.log('Fetching FFmpeg for spotDL if needed…');
          await ctx.run(p, ['--download-ffmpeg'], { allowFail: true });
          return { path: p };
        }
      } catch (e) {
        ctx.log(`${bin}: ${e.message}`);
      }
    }
    throw new Error('Could not install spotDL. Install pipx (sudo apt install pipx) and try again.');
  }
  if (name === 'shazamio') {
    // Its own virtual environment, so it never touches the system's Python.
    const venv = path.join(PATHS.data, 'venv-shazam');
    await ctx.run('python3', ['-m', 'venv', venv]);
    await ctx.run(path.join(venv, 'bin/pip'), ['install', '--upgrade', 'shazamio']);
    return { path: venv };
  }
  if (name === 'fpcalc') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const url = `https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-${arch}.tar.gz`;
    ctx.log(`Downloading ${url}`);
    const tmp = path.join(PATHS.cache, 'fpcalc.tgz');
    const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    await ctx.run('tar', ['-xzf', tmp, '-C', PATHS.cache]);
    const dir = fs.readdirSync(PATHS.cache).find((d) => d.startsWith('chromaprint-fpcalc'));
    fs.copyFileSync(path.join(PATHS.cache, dir, 'fpcalc'), path.join(BIN_DIR, 'fpcalc'));
    fs.chmodSync(path.join(BIN_DIR, 'fpcalc'), 0o755);
    return { path: path.join(BIN_DIR, 'fpcalc') };
  }
  throw new Error('Unknown tool');
}

export function register(app) {
  app.get('/api/downloads/sources', requireUser, json(() => SOURCES.map(({ match: _m, ...s }) => s)));
  app.get('/api/downloads/tools', requireUser, json(() => tools()));
  app.post(
    '/api/downloads/detect',
    requireUser,
    json((req) => {
      const s = detectSource(req.body.input || '');
      return { id: s.id, label: s.label, tool: s.tool, hint: s.hint };
    }),
  );
  app.post(
    '/api/downloads',
    requireUser,
    json((req) => {
      if (!settings.online()) throw httpError(403, 'Privacy mode is on: downloading from the internet is off');
      const inputs = (Array.isArray(req.body.inputs) ? req.body.inputs : String(req.body.input || '').split(/\n+/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 200);
      if (!inputs.length) throw httpError(400, 'Paste a link or a song name');
      const profileId = str(req.body.profileId, 64) || null;
      if (profileId && !canUse(req.user, getProfile(profileId))) throw httpError(403, 'Not yours');
      const ids = inputs.map((input) => start({ input, profileId, autoImport: req.body.autoImport === undefined ? undefined : bool(req.body.autoImport), video: req.body.video === undefined ? undefined : bool(req.body.video), userId: req.user.id, extra: { source: req.body.source } }));
      return { jobs: ids };
    }),
  );
  app.post(
    '/api/downloads/tools/:name/install',
    requireAdmin,
    json((req) => {
      if (!settings.online()) throw httpError(403, 'Privacy mode is on');
      return { job: jobs.start('install', `Install ${req.params.name}`, (ctx) => installTool(req.params.name, ctx), { userId: req.user.id }) };
    }),
  );
  app.post(
    '/api/downloads/tools/:name/update',
    requireAdmin,
    json((req) => {
      const d = settings.get('downloads');
      const name = req.params.name;
      return {
        job: jobs.start('install', `Update ${name}`, async (ctx) => {
          if (name === 'ytdlp') {
            const r = await ctx.run(d.ytdlpBin || 'yt-dlp', ['-U'], { allowFail: true });
            if (r.code !== 0) return installTool('ytdlp', ctx);
            return {};
          }
          if (name === 'spotdl') return installTool('spotdl', ctx);
          throw new Error('Unknown tool');
        }),
      };
    }),
  );
  void db;
}
