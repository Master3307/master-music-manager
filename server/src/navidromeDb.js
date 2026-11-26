// Read-only access to Navidrome's own database when it runs on this machine
// (or its data folder is mounted). Gives what the API can't: the full scrobble
// history with times, per-user play counts, ratings and stars.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { merge } from './scrobbles.js';

export function findDb(hint) {
  const candidates = [hint, process.env.ND_DATAFOLDER && path.join(process.env.ND_DATAFOLDER, 'navidrome.db'), '/var/lib/navidrome/navidrome.db', '/opt/navidrome/data/navidrome.db', '/data/navidrome.db', `${process.env.HOME}/.local/share/navidrome/navidrome.db`].filter(Boolean);
  try {
    const t = fs.readFileSync('/etc/navidrome/navidrome.toml', 'utf8');
    const dir = t.match(/^\s*DataFolder\s*=\s*["']?([^"'\n]+)/m)?.[1];
    if (dir) candidates.unshift(path.join(dir.trim(), 'navidrome.db'));
  } catch {}
  return candidates.find((f) => {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function open(file) {
  const f = findDb(file);
  if (!f) throw new Error("Navidrome's database was not found (or this user can't read it). Give its path, e.g. /var/lib/navidrome/navidrome.db");
  return { db: new Database(f, { readonly: true, fileMustExist: true }), file: f };
}

export async function importFromNavidromeDb({ file, profile, ctx }) {
  const { db: nd, file: f } = open(file);
  try {
    ctx.log(`Reading ${f}`);
    const tables = new Set(nd.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    if (!tables.has('scrobbles')) throw new Error('This Navidrome is too old to keep a scrobble history (needs 0.58 or newer)');
    const rows = nd
      .prepare(
        `SELECT s.submission_time ts, u.user_name username, m.title, m.artist, m.album, m.album_artist, m.duration, m.id remote_id, m.mbz_recording_id mbid
         FROM scrobbles s JOIN media_file m ON m.id = s.media_file_id JOIN user u ON u.id = s.user_id ORDER BY s.submission_time`,
      )
      .all();
    ctx.log(`${rows.length} listens in Navidrome`);
    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.username)) byUser.set(r.username, []);
      byUser.get(r.username).push({ ts: typeof r.ts === 'number' ? r.ts : Math.floor(Date.parse(r.ts) / 1000), title: r.title, artist: r.artist, album: r.album, albumArtist: r.album_artist, duration: r.duration, mbid: r.mbid });
    }
    const out = {};
    for (const [user, items] of byUser) {
      out[user] = merge(items, { profileId: profile?.id, username: user, source: 'navidrome-db' });
      ctx.log(`${user}: ${out[user].added} new, ${out[user].skipped} already known`);
    }
    return out;
  } finally {
    nd.close();
  }
}

/** Per-user annotations (play count, rating, starred) for the stats page. */
export function annotations(file, username) {
  const { db: nd } = open(file);
  try {
    return nd
      .prepare(
        `SELECT a.item_type type, a.item_id id, a.play_count plays, a.rating, a.starred, a.play_date last FROM annotation a JOIN user u ON u.id = a.user_id WHERE u.user_name = ?`,
      )
      .all(username);
  } finally {
    nd.close();
  }
}

// ---- importing everything Navidrome knows into a library here ----
import { db as ours, now as nowMs, tx } from './db.js';
import { uuid } from './lib/crypto.js';
import * as lib from './library/index.js';
import { json, httpError, str } from './lib/http.js';
import { requireAdmin } from './auth.js';
import { getProfile } from './services/index.js';
import * as jobs from './jobs.js';

export function summary(file) {
  const { db: nd, file: f } = open(file);
  try {
    const t = new Set(nd.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const count = (sql) => {
      try {
        return nd.prepare(sql).get().n;
      } catch {
        return 0;
      }
    };
    return {
      file: f,
      users: nd.prepare('SELECT user_name FROM user').all().map((u) => u.user_name),
      favorites: count("SELECT COUNT(*) n FROM annotation WHERE item_type = 'media_file' AND starred = 1"),
      ratings: count("SELECT COUNT(*) n FROM annotation WHERE item_type = 'media_file' AND rating > 0"),
      plays: count("SELECT COUNT(*) n FROM annotation WHERE item_type = 'media_file' AND play_count > 0"),
      playlists: count("SELECT COUNT(*) n FROM playlist WHERE rules IS NULL OR rules = ''"),
      radios: t.has('radio') ? count('SELECT COUNT(*) n FROM radio') : 0,
      scrobbles: t.has('scrobbles') ? count('SELECT COUNT(*) n FROM scrobbles') : 0,
      songs: count('SELECT COUNT(*) n FROM media_file'),
    };
  } finally {
    nd.close();
  }
}

export function importAll({ file, profile, what, ctx }) {
  const { db: nd, file: f } = open(file);
  const out = {};
  try {
    ctx.log(`Reading ${f}`);
    const byPath = new Map(lib.all(profile.id).map((t) => [t.path, t]));
    const userKey = (name) => ours.prepare('SELECT id FROM users WHERE username = ?').get(name)?.id || '';
    if (what.includes('favorites') || what.includes('ratings') || what.includes('plays')) {
      const rows = nd.prepare("SELECT a.*, u.user_name, m.path FROM annotation a JOIN user u ON u.id = a.user_id JOIN media_file m ON m.id = a.item_id WHERE a.item_type = 'media_file'").all();
      let n = 0;
      tx(() => {
        for (const r of rows) {
          if (!byPath.has(r.path)) continue;
          const key = userKey(r.user_name);
          const cur = ours.prepare('SELECT * FROM local_annotations WHERE profile_id = ? AND user_key = ? AND track_path = ?').get(profile.id, key, r.path) || {};
          const starred = what.includes('favorites') && r.starred ? Date.parse(r.starred_at || '') || nowMs() : cur.starred ?? null;
          const rating = what.includes('ratings') && r.rating ? r.rating : cur.rating ?? null;
          const plays = what.includes('plays') ? Math.max(cur.play_count || 0, r.play_count || 0) : cur.play_count || 0;
          const last = what.includes('plays') && r.play_date ? Date.parse(r.play_date) || null : cur.last_played ?? null;
          ours.prepare('INSERT INTO local_annotations (profile_id, user_key, track_path, starred, rating, play_count, last_played) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, user_key, track_path) DO UPDATE SET starred = excluded.starred, rating = excluded.rating, play_count = excluded.play_count, last_played = excluded.last_played').run(profile.id, key, r.path, starred, rating, plays, last);
          n++;
        }
      });
      out.songs = n;
      ctx.log(`${n} songs got their favorite / rating / play count`);
    }
    if (what.includes('playlists')) {
      const pls = nd.prepare("SELECT * FROM playlist WHERE rules IS NULL OR rules = ''").all();
      let n = 0;
      for (const pl of pls) {
        const tracks = nd.prepare('SELECT m.path FROM playlist_tracks pt JOIN media_file m ON m.id = pt.media_file_id WHERE pt.playlist_id = ? ORDER BY pt.id').all(pl.id);
        const ids = tracks.map((t) => byPath.get(t.path)?.id).filter(Boolean);
        if (!ids.length) continue;
        if (ours.prepare('SELECT 1 FROM local_playlists WHERE profile_id = ? AND name = ?').get(profile.id, pl.name)) continue;
        ours.prepare('INSERT INTO local_playlists (id, profile_id, name, comment, track_ids, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(uuid(), profile.id, pl.name, pl.comment || null, JSON.stringify(ids), nowMs(), nowMs());
        n++;
        ctx.log(`playlist ${pl.name}: ${ids.length} of ${tracks.length} songs found`);
      }
      out.playlists = n;
    }
    if (what.includes('radios')) {
      let n = 0;
      try {
        for (const r of nd.prepare('SELECT * FROM radio').all()) {
          if (ours.prepare('SELECT 1 FROM local_radios WHERE profile_id = ? AND stream_url = ?').get(profile.id, r.stream_url)) continue;
          ours.prepare('INSERT INTO local_radios (id, profile_id, name, stream_url, homepage_url, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(uuid(), profile.id, r.name, r.stream_url, r.home_page_url || null, nowMs());
          n++;
        }
      } catch {}
      out.radios = n;
      ctx.log(`${n} radio stations`);
    }
  } finally {
    nd.close();
  }
  return out;
}

export function register(app) {
  app.get(
    '/api/import/navidrome',
    requireAdmin,
    json((req) => {
      try {
        return { found: true, ...summary(str(req.query.file, 1000) || undefined) };
      } catch (e) {
        return { found: false, error: e.message };
      }
    }),
  );
  app.post(
    '/api/import/navidrome',
    requireAdmin,
    json((req) => {
      const p = getProfile(req.body.profileId);
      if (!p?.local_path) throw httpError(400, 'Pick a library with a linked folder; Navidrome’s data is matched to its files');
      const what = Array.isArray(req.body.what) ? req.body.what : ['favorites', 'ratings', 'plays', 'playlists', 'radios', 'scrobbles'];
      return {
        job: jobs.start('import', 'Importing from Navidrome', async (ctx) => {
          const r = importAll({ file: req.body.file, profile: p, what, ctx });
          if (what.includes('scrobbles')) r.scrobbles = await importFromNavidromeDb({ file: req.body.file, profile: p, ctx });
          return r;
        }, { userId: req.user.id }),
      };
    }),
  );
}
