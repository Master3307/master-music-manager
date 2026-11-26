// Every user-facing setting with its default. The GUI reads DEFAULTS to know
// what exists; values are stored as JSON per top-level key.
import { db } from './db.js';

export const DEFAULTS = {
  setupDone: false,
  auth: {
    required: false, // everything needs a login
    guestAccess: 'none', // 'listen': people who aren't logged in can still listen
    allowLocal: true,
    allowService: true, // log in with a Navidrome / Jellyfin / OpenSubsonic account
    serviceRole: 'user', // role for people who log in with a service account
    discord: { enabled: false, clientId: '', clientSecret: '', allowedIds: '', adminIds: '' },
    sessionDays: 30,
  },
  privacy: {
    fullLocal: false, // blocks every outgoing request that isn't to your own servers
    updateCheck: true,
    lastfm: false,
    musicbrainz: true,
    coverSearch: true,
    lyrics: true,
    acoustidKey: '',
    lastfmKey: '',
    // Unofficial Shazam (shazamio): free, great with snippets and YouTube rips,
    // but it uses Shazam's private API and may break at any time. Off by default.
    shazam: false,
    auddKey: '', // AudD: commercial API with a small free tier
  },
  instance: { id: '', name: '' },
  library: {
    // Artist/Album/NN - Title, the layout spotify-dl already uses.
    template: '{folderartist}/{album|title}/{?disctotal>1:{disc}-}{?track:{track:2} - }{title}',
    separator: ' / ',
    splitArtists: true,
    splitOn: [' feat. ', ' ft. ', ' featuring ', ', ', ' & ', ' x ', ' / ', ';'],
    keepTogether: [], // artist names never split (e.g. "Simon & Garfunkel")
    folderArtist: 'primary', // primary | all
    misc: { enabled: null, folder: '!Misc' }, // null = ask the user once
    unknownArtist: 'Unknown Artist',
    unknownAlbum: 'Unknown Album',
    autoOrganize: true,
    illegalChars: 'replace', // replace | remove
    maxPathPart: 120,
    rescanAfterChanges: true,
    playlistsFolder: 'Playlists',
  },
  convert: {
    format: 'mp3', // mp3 | flac | opus | m4a | ogg | wav | original
    mp3Mode: 'vbr', // vbr | cbr
    mp3Quality: 0, // LAME V0
    bitrate: 320,
    keepLossless: true, // never transcode lossless into lossy unless asked
    keepOriginal: 'never', // never | inbox | folder
    originalsFolder: '.originals',
    animatedCovers: true,
    canvasSeconds: 8,
    normalize: false,
  },
  downloads: {
    spotdlBin: 'spotdl',
    ytdlpBin: 'yt-dlp',
    cookies: '',
    threads: 2,
    providers: 'youtube-music youtube',
    searchQuery: '{artist} - {title}',
    filterResults: true,
    reviewBeforeImport: true,
    extraArgs: '',
  },
  duplicates: { autoMergeExact: false, durationTolerance: 3, ignoreFeat: true },
  player: { crossfade: 0, gapless: true, replayGain: 'off', scrobble: true, scrobbleAt: 50, visualizer: true, canvas: true },
  appearance: {
    mode: 'system', // light | dark | system
    simple: false, // the simple player: hides the tools
    accent: '#8b5cf6',
    theme: 'midnight',
    graphics: true,
    animations: true,
    density: 'comfortable',
    radius: 12,
    font: 'Inter',
    globalCss: '',
    customThemes: [], // [{ id, name, css, base }]
  },
  shares: { defaultVisibility: 'public', defaultDownload: false, defaultExpiryDays: 0, siteName: 'Master Music Manager' },
  updates: { channel: 'stable', notify: true, lastChecked: 0, latest: null },
  plugin: { secret: '', lastSeen: 0, version: null },
  public: { url: '' }, // this app's public address, used for share links
};

const cache = new Map();

function merge(def, val) {
  if (Array.isArray(def) || typeof def !== 'object' || def === null) return val === undefined ? def : val;
  const out = { ...def };
  for (const [k, v] of Object.entries(val || {})) out[k] = k in def ? merge(def[k], v) : v;
  return out;
}

export function get(key) {
  if (cache.has(key)) return cache.get(key);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = merge(DEFAULTS[key], row ? JSON.parse(row.value) : undefined);
  cache.set(key, value);
  return value;
}

export function set(key, value) {
  const next = merge(DEFAULTS[key], typeof value === 'object' && !Array.isArray(value) && value ? { ...get(key), ...value } : value);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(next));
  cache.set(key, next);
  return next;
}

export function all() {
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, get(k)]));
}

/** Settings without secrets, for the browser. */
export function forClient() {
  const s = all();
  return {
    ...s,
    auth: { ...s.auth, discord: { ...s.auth.discord, clientSecret: s.auth.discord.clientSecret ? '••••••' : '' } },
    plugin: { ...s.plugin, secret: s.plugin.secret ? '••••••' : '' },
  };
}

/** True when outgoing requests to third parties are allowed. */
export function online(feature) {
  const p = get('privacy');
  if (p.fullLocal) return false;
  return feature ? p[feature] !== false : true;
}
