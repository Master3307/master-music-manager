// Duplicates. "Exact" = the same audio (tags may differ): those can be merged
// automatically. "Likely" = same song by name and length: the user decides
// what to keep, and can listen to every copy first. Every merge carries a
// confidence score with the reasons, and low scores need a confirmation.
import fs from 'node:fs';
import { run } from '../media/ffmpeg.js';
import * as lib from './index.js';
import * as settings from '../settings.js';
import * as jobs from '../jobs.js';
import { db, audit } from '../db.js';
import { splitArtists } from './naming.js';

const key = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([](feat|ft|with|prod)[^)\]]*[)\]]/g, '')
    .replace(/\s*[([](official|lyrics?|audio|video|hd|hq|remaster(ed)?( \d{4})?)[^)\]]*[)\]]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Hash of the audio packets only (ignores tags and covers). Same value = same recording file. */
export async function audioHash(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-']);
  return stdout.trim().replace(/^MD5=/, '');
}

export async function ensureAudioHashes(profile, ctx) {
  const todo = db.prepare('SELECT id, path FROM tracks WHERE profile_id = ? AND audio_hash IS NULL').all(profile.id);
  let n = 0;
  for (const t of todo) {
    ctx?.check();
    try {
      db.prepare('UPDATE tracks SET audio_hash = ? WHERE id = ?').run(await audioHash(lib.absPath(profile, t.path)), t.id);
    } catch {}
    if (++n % 20 === 0) ctx?.progress((n / todo.length) * 0.6, `Fingerprinting ${n} / ${todo.length}`);
  }
}

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const sim = (a, b) => {
  const x = key(a);
  const y = key(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  return 1 - lev(x, y) / Math.max(x.length, y.length);
};

/**
 * How sure are we that a and b are the same song? 0..100 plus the reasons,
 * so the UI can point at what looks off ("4:12 vs 2:58").
 */
export function similarity(a, b) {
  const notes = [];
  if (a.audioHash && a.audioHash === b.audioHash) return { score: 100, exact: true, notes: [{ ok: true, text: 'Identical audio' }] };
  if (a.hash && a.hash === b.hash) return { score: 100, exact: true, notes: [{ ok: true, text: 'Identical files' }] };
  let score = 0;
  const t = sim(a.title, b.title);
  score += t * 40;
  notes.push({ ok: t > 0.85, text: t > 0.85 ? 'Same title' : `Titles differ: "${a.title}" / "${b.title}"` });
  const lc = settings.get('library');
  const aa = splitArtists(a.artist, lc).map(key);
  const ba = splitArtists(b.artist, lc).map(key);
  const overlap = aa.filter((x) => ba.includes(x)).length / Math.max(1, Math.min(aa.length, ba.length));
  const ar = Math.max(overlap, sim(a.artist, b.artist));
  score += ar * 25;
  notes.push({ ok: ar > 0.7, text: ar > 0.7 ? 'Same artist' : `Artists differ: "${a.artist || '—'}" / "${b.artist || '—'}"` });
  if (a.duration && b.duration) {
    const d = Math.abs(a.duration - b.duration);
    const tol = settings.get('duplicates').durationTolerance || 3;
    const ds = d <= tol ? 1 : d <= tol * 3 ? 0.5 : d <= 20 ? 0.15 : 0;
    score += ds * 30;
    notes.push({ ok: d <= tol, text: d <= tol ? `Same length (${fmt(a.duration)})` : `Length differs by ${Math.round(d)} s: ${fmt(a.duration)} / ${fmt(b.duration)}` });
  } else score += 10;
  const al = sim(a.album, b.album);
  score += al * 5;
  if (a.album && b.album && al < 0.6) notes.push({ ok: null, text: `Different albums: "${a.album}" / "${b.album}" (could be a single and the album version)` });
  const kindA = versionWords(a.title);
  const kindB = versionWords(b.title);
  if (kindA !== kindB) {
    score -= 25;
    notes.push({ ok: false, text: `One looks like a different version: ${kindA || 'original'} / ${kindB || 'original'}` });
  }
  return { score: Math.max(0, Math.min(99, Math.round(score))), exact: false, notes };
}
const versionWords = (title) =>
  (String(title || '').toLowerCase().match(/\b(remix|live|acoustic|instrumental|karaoke|demo|edit|extended|slowed|sped up|nightcore|reverb|cover|mashup|bootleg|vip|remaster)\b/g) || []).sort().join(' ');
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Rate how good a copy is, to suggest which one to keep. */
export function quality(t) {
  let q = 0;
  if (t.lossless) q += 1000;
  q += Math.min(t.bitrate || 0, 400);
  if (t.cover) q += 30;
  q += Object.keys(t).filter((k) => t[k] != null && t[k] !== '').length;
  if (/\(\d+\)\.[^.]+$|copy/i.test(t.filename)) q -= 50;
  return q;
}

export function find(profileId, { includeLikely = true } = {}) {
  const tracks = lib.all(profileId);
  const audioHash = new Map(db.prepare('SELECT id, audio_hash FROM tracks WHERE profile_id = ?').all(profileId).map((r) => [r.id, r.audio_hash]));
  const groups = [];
  const used = new Set();
  // Exact: same audio hash or same file hash.
  const byHash = new Map();
  for (const t of tracks) {
    const h = audioHash.get(t.id) || (t.hash ? `f:${t.hash}` : null);
    if (!h) continue;
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(t);
  }
  for (const [, list] of byHash) {
    if (list.length < 2) continue;
    list.forEach((t) => used.add(t.id));
    groups.push(group(list, 'exact', audioHash));
  }
  if (includeLikely) {
    const ignoreFeat = settings.get('duplicates').ignoreFeat;
    const byName = new Map();
    for (const t of tracks) {
      if (used.has(t.id) || !t.title) continue;
      const artist = splitArtists(t.artist || '', settings.get('library'))[0];
      const k = `${key(t.title)}|${key(ignoreFeat ? artist : t.artist)}`;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(t);
    }
    for (const [, list] of byName) {
      if (list.length < 2) continue;
      // Split by length so "Song (3:10)" and "Song (8:40 extended)" don't land together.
      const tol = (settings.get('duplicates').durationTolerance || 3) * 3;
      const sorted = list.slice().sort((a, b) => (a.duration || 0) - (b.duration || 0));
      let cur = [sorted[0]];
      for (const t of sorted.slice(1)) {
        if (!t.duration || !cur.at(-1).duration || t.duration - cur.at(-1).duration <= tol) cur.push(t);
        else {
          if (cur.length > 1) groups.push(group(cur, 'likely', audioHash));
          cur = [t];
        }
      }
      if (cur.length > 1) groups.push(group(cur, 'likely', audioHash));
    }
  }
  return groups.sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === 'exact' ? -1 : 1));
}

function group(list, kind, audioHash) {
  const withHash = list.map((t) => ({ ...t, audioHash: audioHash.get(t.id) }));
  const best = withHash.slice().sort((a, b) => quality(b) - quality(a))[0];
  const scores = withHash.filter((t) => t.id !== best.id).map((t) => similarity(best, t));
  return {
    id: `${kind}:${list.map((t) => t.id).sort().join(',')}`,
    kind,
    score: Math.min(...scores.map((s) => s.score)),
    keep: best.id,
    notes: scores.flatMap((s) => s.notes).filter((n, i, a) => a.findIndex((x) => x.text === n.text) === i),
    tracks: withHash.map((t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, bitrate: t.bitrate, ext: t.ext, size: t.size, path: t.path, lossless: t.lossless, cover: t.cover, remoteId: t.remoteId, quality: quality(t), samplerate: t.samplerate })),
  };
}

/**
 * Merge: keep one file, optionally fill its empty tags from the others, move the rest to the trash.
 */
export async function merge(profile, { keep, remove, fillTags = true, userId }) {
  const k = lib.byId(profile.id, keep);
  if (!k) throw new Error('The copy to keep is gone');
  const others = remove.map((id) => lib.byId(profile.id, id)).filter(Boolean);
  if (fillTags) {
    const fill = {};
    for (const o of others)
      for (const [f, v] of Object.entries(o)) {
        if (['id', 'path', 'filename', 'folder', 'ext', 'size', 'mtime', 'modified', 'added', 'hash', 'duration', 'bitrate', 'samplerate', 'channels', 'bits', 'codec', 'container', 'lossless', 'cover', 'haslyrics', 'nosplit', 'remoteId', 'online', 'profileId', 'custom'].includes(f)) continue;
        if ((k[f] == null || k[f] === '' || (Array.isArray(k[f]) && !k[f].length)) && v != null && v !== '' && fill[f] === undefined) fill[f] = v;
      }
    if (Object.keys(fill).length) await lib.applyEdit(profile, k, { tags: fill, label: 'Before merging duplicates', skipSeparators: true }, { organize: false, userId });
  }
  for (const o of others) lib.trash(profile, o, userId);
  audit(userId, 'duplicates.merge', { keep: k.path, removed: others.map((o) => o.path) });
  return { kept: keep, removed: others.length };
}

export function scanJob(profile, { autoMerge, userId } = {}) {
  return jobs.start(
    'duplicates',
    `Finding duplicates · ${profile.name}`,
    async (ctx) => {
      await ensureAudioHashes(profile, ctx);
      ctx.progress(0.7, 'Comparing');
      const groups = find(profile.id);
      const exact = groups.filter((g) => g.kind === 'exact');
      ctx.log(`${exact.length} groups of identical audio, ${groups.length - exact.length} groups that look alike`);
      if (autoMerge ?? settings.get('duplicates').autoMergeExact) {
        for (const g of exact) {
          const r = await merge(profile, { keep: g.keep, remove: g.tracks.filter((t) => t.id !== g.keep).map((t) => t.id), userId });
          ctx.log(`merged ${r.removed + 1} copies of ${g.tracks[0].title}`);
        }
      }
      return { exact: exact.length, likely: groups.length - exact.length };
    },
    { userId },
  );
}

export function existsSync(p) {
  return fs.existsSync(p);
}
