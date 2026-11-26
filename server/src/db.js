// SQLite schema. Migrations are additive (new tables / columns only) so that a
// backup from any version imports into any other.
import Database from 'better-sqlite3';
import { PATHS } from './config.js';

export const db = new Database(PATHS.db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  totp_secret TEXT,
  provider TEXT NOT NULL DEFAULT 'local',
  provider_ref TEXT,
  avatar TEXT,
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS users_provider ON users(provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- navidrome | subsonic | jellyfin | local
  url TEXT,                      -- address the server uses (often a LAN address)
  public_url TEXT,               -- address people outside use (shares, "open in")
  username TEXT,
  secret TEXT,                   -- sealed password / token
  user_id TEXT,                  -- Jellyfin user id
  local_path TEXT,               -- linked library folder
  link_checked_at INTEGER,
  link_score REAL,
  options TEXT NOT NULL DEFAULT '{}',
  owner_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  path TEXT NOT NULL,            -- relative to the profile's local_path
  size INTEGER, mtime INTEGER,
  hash TEXT,                     -- sha1 of the whole file, filled lazily
  audio_hash TEXT,               -- sha1 of the audio payload only
  duration REAL, bitrate INTEGER, sample_rate INTEGER, channels INTEGER, bits INTEGER,
  codec TEXT, container TEXT, lossless INTEGER,
  title TEXT, artist TEXT, album TEXT, album_artist TEXT, genre TEXT, year INTEGER,
  track_no INTEGER, track_of INTEGER, disc_no INTEGER, disc_of INTEGER,
  has_cover INTEGER, has_lyrics INTEGER,
  tags TEXT NOT NULL DEFAULT '{}', -- every tag we could read, normalized
  remote_id TEXT,                -- id of this file on the linked service
  no_split INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(profile_id, path)
);
CREATE INDEX IF NOT EXISTS tracks_hash ON tracks(hash);
CREATE INDEX IF NOT EXISTS tracks_remote ON tracks(profile_id, remote_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued | running | done | failed | cancelled
  progress REAL, detail TEXT,
  result TEXT, error TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  source TEXT NOT NULL,          -- upload | spotify | youtube | url | archive | ...
  source_url TEXT,
  file TEXT NOT NULL,            -- absolute path in the inbox folder
  original_name TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  info TEXT NOT NULL DEFAULT '{}',
  profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  duplicate_of INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_points (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  path TEXT NOT NULL,
  file TEXT NOT NULL,
  label TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  kind TEXT NOT NULL,            -- track | album | artist | playlist | radio | selection
  ref TEXT NOT NULL,             -- JSON describing what is shared
  profile_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'public', -- public | key | private
  key_hash TEXT,
  allow_download INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  remote_id TEXT,                -- matching Navidrome share
  source TEXT NOT NULL DEFAULT 'mmm',
  owner_id TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  last_visited INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scrobbles (
  id INTEGER PRIMARY KEY,
  profile_id TEXT,
  username TEXT,
  ts INTEGER NOT NULL,           -- unix seconds
  title TEXT, artist TEXT, album TEXT, album_artist TEXT,
  duration REAL,
  remote_id TEXT, mbid TEXT,
  player TEXT,
  source TEXT NOT NULL,          -- navidrome-plugin | mmm-player | lastfm | listenbrainz | spotify | csv | ...
  UNIQUE(username, ts, title, artist)
);
CREATE INDEX IF NOT EXISTS scrobbles_ts ON scrobbles(ts);

CREATE TABLE IF NOT EXISTS local_playlists (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  name TEXT NOT NULL,
  comment TEXT,
  track_ids TEXT NOT NULL DEFAULT '[]',
  owner_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artist_info (
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  about TEXT,
  sort_name TEXT,
  mbid TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  image TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, name)
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_url TEXT,
  public_url TEXT,
  modes TEXT NOT NULL DEFAULT '{}',
  their_key TEXT,                 -- sealed: the key we send to them
  our_key_hash TEXT,              -- sha256 of the key they send to us
  last_seen INTEGER, last_error TEXT, last_url TEXT,
  catalog_at INTEGER, info TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_tracks (
  node_id TEXT NOT NULL,
  remote_track_id INTEGER NOT NULL,
  audio_hash TEXT, hash TEXT,
  path TEXT, size INTEGER, duration REAL,
  title TEXT, artist TEXT, album TEXT, album_artist TEXT, year INTEGER, genre TEXT, track_no INTEGER, ext TEXT, bitrate INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, remote_track_id)
);
CREATE INDEX IF NOT EXISTS remote_tracks_audio ON remote_tracks(audio_hash);

CREATE TABLE IF NOT EXISTS app_passwords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["webdav"]',
  last_used INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
`);

// Additive column migrations (old databases get them, new ones already match).
for (const [table, col, def] of [
  ['users', 'perms', "TEXT NOT NULL DEFAULT '[]'"],
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS download_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | approved | declined
  decided_by TEXT, decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_annotations (
  profile_id TEXT NOT NULL,
  user_key TEXT NOT NULL,        -- user id, or '' for the shared library
  track_path TEXT NOT NULL,
  starred INTEGER, rating INTEGER, play_count INTEGER NOT NULL DEFAULT 0, last_played INTEGER,
  PRIMARY KEY (profile_id, user_key, track_path)
);
CREATE TABLE IF NOT EXISTS local_radios (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  name TEXT NOT NULL, stream_url TEXT NOT NULL, homepage_url TEXT,
  created_at INTEGER NOT NULL
);
`);

export const now = () => Date.now();

export function tx(fn) {
  return db.transaction(fn)();
}

export function audit(userId, action, detail) {
  db.prepare('INSERT INTO audit (ts, user_id, action, detail) VALUES (?, ?, ?, ?)').run(
    now(),
    userId ?? null,
    action,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}
