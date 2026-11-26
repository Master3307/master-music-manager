// Artist pages you can edit: name (renames it in every file), sort name,
// MusicBrainz id, "About" text, links and picture. Navidrome has no API for
// biographies, so the Navidrome plugin serves these back to it as a metadata
// agent; pictures go to Navidrome's own artist image upload.
import { db, now, audit } from './db.js';
import * as lib from './library/index.js';
import * as jobs from './jobs.js';
import { httpError, json, str } from './lib/http.js';
import { requireUser } from './auth.js';
import { getProfile, canUse } from './services/index.js';
import { splitArtists, joinArtists } from './library/naming.js';
import * as settings from './settings.js';

export function info(profileId, name) {
  const r = db.prepare('SELECT * FROM artist_info WHERE profile_id = ? AND name = ?').get(profileId, name);
  return r ? { name: r.name, about: r.about, sortName: r.sort_name, mbid: r.mbid, links: JSON.parse(r.links || '[]'), image: r.image, updatedAt: r.updated_at } : null;
}

/** For the plugin: the about text for a name, from any profile. */
export function aboutByName(name) {
  const r = db.prepare('SELECT * FROM artist_info WHERE name = ? AND about IS NOT NULL ORDER BY updated_at DESC').get(name);
  return r ? { about: r.about, mbid: r.mbid, links: JSON.parse(r.links || '[]') } : null;
}

export function register(app) {
  app.get(
    '/api/p/:pid/artist-info',
    requireUser,
    json((req) => {
      const p = getProfile(req.params.pid);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      const name = str(req.query.name, 300);
      const lc = settings.get('library');
      const tracks = p.local_path ? lib.all(p.id).filter((t) => splitArtists(t.artist, lc).some((a) => a.toLowerCase() === name.toLowerCase()) || (t.albumartist || '').toLowerCase() === name.toLowerCase()) : [];
      return { ...(info(p.id, name) || { name }), localTracks: tracks.length, localAlbums: new Set(tracks.map((t) => t.album)).size, mbidFromTags: tracks.find((t) => t.musicbrainz_artistid?.length)?.musicbrainz_artistid?.[0] || null };
    }),
  );

  app.put(
    '/api/p/:pid/artist-info',
    requireUser,
    json((req) => {
      const p = getProfile(req.params.pid);
      if (!canUse(req.user, p)) throw httpError(403, 'Not yours');
      const name = str(req.body.name, 300).trim();
      if (!name) throw httpError(400, 'Missing artist name');
      const links = Array.isArray(req.body.links) ? req.body.links.filter((l) => /^https?:\/\//.test(l?.url || '')).slice(0, 30).map((l) => ({ label: str(l.label, 60), url: str(l.url, 500) })) : [];
      db.prepare(`INSERT INTO artist_info (profile_id, name, about, sort_name, mbid, links, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, name) DO UPDATE SET about = excluded.about, sort_name = excluded.sort_name, mbid = excluded.mbid, links = excluded.links, updated_at = excluded.updated_at`).run(
        p.id,
        name,
        str(req.body.about, 20000) || null,
        str(req.body.sortName, 300) || null,
        /^[0-9a-f-]{36}$/i.test(req.body.mbid || '') ? req.body.mbid : null,
        JSON.stringify(links),
        now(),
      );
      audit(req.user.id, 'artist.info', { name });
      return info(p.id, name);
    }),
  );

  // Rename an artist in every file (artist, album artist and the artists list).
  app.post(
    '/api/p/:pid/artist-rename',
    requireUser,
    json((req) => {
      const p = getProfile(req.params.pid);
      if (!canUse(req.user, p) || !p.local_path) throw httpError(400, 'Renaming needs the linked folder');
      const from = str(req.body.from, 300);
      const to = str(req.body.to, 300).trim();
      if (!from || !to) throw httpError(400, 'Give the old and the new name');
      const lc = settings.get('library');
      const hits = lib.all(p.id).filter((t) => splitArtists(t.artist, lc, { noSplit: t.nosplit }).some((a) => a === from) || splitArtists(t.albumartist, lc, { noSplit: t.nosplit }).some((a) => a === from));
      if (req.body.preview) return { count: hits.length, sample: hits.slice(0, 20).map((t) => ({ path: t.path, artist: t.artist, albumartist: t.albumartist })) };
      return {
        job: jobs.start(
          'bulk',
          `Rename artist ${from} → ${to} (${hits.length} files)`,
          async (ctx) => {
            let n = 0;
            for (const t of hits) {
              ctx.check();
              const swap = (v) => (v ? joinArtists(splitArtists(v, lc, { noSplit: t.nosplit }).map((a) => (a === from ? to : a)), lc.separator) : v);
              const edit = { tags: { artist: swap(t.artist), albumartist: swap(t.albumartist) }, label: `Before renaming ${from}`, skipSeparators: true };
              if (t.artists?.length) edit.tags.artists = t.artists.map((a) => (a === from ? to : a));
              try {
                const r = await lib.applyEdit(p, t, edit, { userId: req.user.id });
                ctx.log(`${t.path}${r.moved ? `  →  ${r.moved.to}` : ''}`);
              } catch (e) {
                ctx.log(`! ${t.path}: ${e.message}`);
              }
              ctx.progress(++n / hits.length);
            }
            db.prepare('UPDATE artist_info SET name = ? WHERE profile_id = ? AND name = ?').run(to, p.id, from);
            return { renamed: n };
          },
          { userId: req.user.id },
        ),
      };
    }),
  );
}
