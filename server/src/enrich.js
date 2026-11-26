// Getting as much as possible about a song:
// - MusicBrainz in depth: the recording, its best release and the work
//   (people, label, catalog number, barcode, track and disc counts, dates,
//   genres, every MusicBrainz id);
// - BPM and key measured from the audio when no source has them.
import { mb, search as mbSearch } from './lookup.js';
import { run } from './media/ffmpeg.js';

const credit = (ac) => (ac || []).map((c) => c.name + (c.joinphrase || '')).join('').trim();
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) || undefined : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)));
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// MusicBrainz relationship types → our tag fields.
const ROLES = { producer: 'producer', engineer: 'engineer', 'audio': 'engineer', mix: 'mixer', remixer: 'remixer', arranger: 'arranger', 'instrument arranger': 'arranger', 'vocal arranger': 'arranger', conductor: 'conductor', 'mix-DJ': 'djmixer', composer: 'composer', lyricist: 'lyricist', writer: 'writer', librettist: 'lyricist' };

/** Pick the release a person most likely means: the album (not a compilation), official, earliest. */
function bestRelease(releases, want = {}) {
  const score = (r) => {
    const rg = r['release-group'] || {};
    let s = 0;
    if (want.album && norm(r.title) === norm(want.album)) s += 50;
    if (r.status === 'Official') s += 20;
    if (rg['primary-type'] === 'Album') s += 15;
    if (rg['primary-type'] === 'Single' || rg['primary-type'] === 'EP') s += 6;
    if (!(rg['secondary-types'] || []).length) s += 12; // not a compilation / live / soundtrack
    if (r.date) s += 4 - Math.min(4, (Number(r.date.slice(0, 4)) - 1900) / 40); // earlier is a bit better
    return s;
  };
  return [...(releases || [])].sort((a, b) => score(b) - score(a))[0];
}

/** Everything MusicBrainz has on a recording, as our tags (+ custom PERFORMER lines). */
export async function musicbrainz(recordingId, want = {}) {
  const rec = await mb(`recording/${recordingId}?inc=artists+releases+release-groups+media+isrcs+genres+tags+artist-rels+work-rels+work-level-rels&fmt=json`);
  const rel0 = bestRelease(rec.releases, want);
  const rel = rel0 ? await mb(`release/${rel0.id}?inc=labels+release-groups+artist-credits+media+genres&fmt=json`).catch(() => null) : null;
  // Where the song sits on that release.
  const medium = rel0?.media?.find((m) => m.track?.length) || rel0?.media?.[0];
  const trk = medium?.track?.[0];
  const people = {};
  const performers = [];
  const add = (field, name) => {
    if (!name) return;
    (people[field] ||= []);
    if (!people[field].includes(name)) people[field].push(name);
  };
  for (const r of rec.relations || []) {
    if (r['target-type'] === 'artist') {
      if (ROLES[r.type]) add(ROLES[r.type], r.artist?.name);
      else if (r.type === 'vocal' || r.type === 'instrument' || r.type === 'performer') performers.push(`${r.artist?.name}${r.attributes?.length ? ` (${r.attributes.join(', ')})` : r.type === 'vocal' ? ' (vocals)' : ''}`);
    }
    if (r['target-type'] === 'work' && r.work) {
      for (const w of r.work.relations || []) if (w['target-type'] === 'artist' && ROLES[w.type]) add(ROLES[w.type], w.artist?.name);
    }
  }
  const work = (rec.relations || []).find((r) => r['target-type'] === 'work' && r.type === 'performance')?.work;
  const genres = [...(rec.genres || []), ...(rel?.genres || []), ...(rel?.['release-group']?.genres || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
  const rg = rel?.['release-group'] || rel0?.['release-group'] || {};
  const label = rel?.['label-info']?.find((l) => l.label?.name);
  const artistCredit = rec['artist-credit'] || [];
  return {
    tags: clean({
      title: rec.title,
      artist: credit(artistCredit),
      artists: artistCredit.map((c) => c.name),
      artistsort: artistCredit.map((c) => c.artist?.['sort-name']).filter(Boolean).join(' & ') || undefined,
      album: rel?.title || rel0?.title,
      albumartist: credit(rel?.['artist-credit']) || undefined,
      albumartistsort: rel?.['artist-credit']?.map((c) => c.artist?.['sort-name']).filter(Boolean).join(' & ') || undefined,
      date: rel?.date || rel0?.date,
      year: yearOf(rel?.date || rel0?.date),
      originaldate: rg['first-release-date'] || rec['first-release-date'],
      originalyear: yearOf(rg['first-release-date'] || rec['first-release-date']),
      track: trk ? Number(trk.number) || trk.position : undefined,
      tracktotal: medium?.['track-count'],
      disc: medium?.position,
      disctotal: rel?.media?.length, // only the full release knows how many discs it has
      media: medium?.format,
      genre: [...new Set(genres.map((g) => g.name))].slice(0, 4).map((g) => g.replace(/\b\w/g, (c) => c.toUpperCase())),
      label: label ? [label.label.name] : undefined,
      catalognumber: label?.['catalog-number'],
      barcode: rel?.barcode,
      isrc: rec.isrcs?.length ? rec.isrcs.slice(0, 3) : undefined,
      releasetype: [rg['primary-type'], ...(rg['secondary-types'] || [])].filter(Boolean).map((x) => x.toLowerCase()),
      releasestatus: (rel?.status || rel0?.status)?.toLowerCase(),
      releasecountry: rel?.country || rel0?.country,
      language: rel?.['text-representation']?.language,
      script: rel?.['text-representation']?.script,
      work: work?.title,
      ...people,
      musicbrainz_trackid: rec.id,
      musicbrainz_releasetrackid: trk?.id,
      musicbrainz_albumid: rel?.id || rel0?.id,
      musicbrainz_releasegroupid: rg.id,
      musicbrainz_artistid: artistCredit.map((c) => c.artist?.id).filter(Boolean),
      musicbrainz_albumartistid: rel?.['artist-credit']?.map((c) => c.artist?.id).filter(Boolean),
      musicbrainz_workid: work?.id,
    }),
    custom: performers.length ? { PERFORMER: performers.join('; ') } : {},
    cover: (rel || rel0) && `https://coverartarchive.org/release/${(rel || rel0).id}/front-500`,
    duration: rec.length ? rec.length / 1000 : undefined,
    link: `https://musicbrainz.org/recording/${rec.id}`,
  };
}

/** Which MusicBrainz recording is this? By ISRC first, then by name and length. */
export async function findRecording({ isrc, title, artist, album, duration }) {
  for (const code of [].concat(isrc || []).slice(0, 2)) {
    const r = await mb(`isrc/${encodeURIComponent(code)}?inc=artist-credits&fmt=json`).catch(() => null);
    const recs = r?.recordings || [];
    const pick = recs.find((x) => !duration || !x.length || Math.abs(x.length / 1000 - duration) < 6) || recs[0];
    if (pick) return { id: pick.id, how: 'ISRC', score: 100 };
  }
  if (!title) return null;
  const list = await mbSearch({ title, artist, album, duration }).catch(() => []);
  // Another version (instrumental, live, remix …) only when that's what you're looking for.
  const VERSION = /\b(instrumental|karaoke|live|remix|mix|edit|acoustic|demo|remaster(ed)?|extended|radio|a cappella|acapella|cover|slowed|sped up|nightcore|version)\b/i;
  const asked = VERSION.test(title);
  const ranked = list.map((c) => ({ ...c, s: c.score - (!asked && VERSION.test(c.title) ? 30 : 0) })).sort((a, b) => b.s - a.s);
  const best = ranked[0];
  return best && best.s >= 72 ? { id: best.recordingId, how: 'name', score: best.s } : null;
}

// ---- BPM and key from the sound ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Krumhansl–Schmuckler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
function corr(a, b) {
  const ma = a.reduce((x, y) => x + y) / a.length;
  const mb2 = b.reduce((x, y) => x + y) / b.length;
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb2);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb2) ** 2;
  }
  return n / Math.sqrt(da * db || 1);
}

/** Measure BPM and key from up to 90 s in the middle of the song. */
export async function analyze(file, { duration } = {}) {
  const SR = 22050;
  const start = duration && duration > 100 ? Math.min(duration * 0.25, duration - 95) : 0;
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, start)), '-t', '90', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { binary: true, maxBuffer: 64 * 1024 * 1024 });
  const pcm = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
  if (pcm.length < SR * 8) throw new Error('too short to measure');
  const N = 4096;
  const HOP = 512;
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const frames = Math.floor((pcm.length - N) / HOP);
  const flux = new Float32Array(frames);
  const chroma = new Float64Array(12);
  let prev = null;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  // Pitch class for every FFT bin in the musical range (≈ 55 Hz – 2 kHz).
  const pc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    if (f >= 55 && f <= 2000) pc[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
  }
  for (let fi = 0; fi < frames; fi++) {
    const off = fi * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = pcm[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(N / 2);
    let fl = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.log1p(10 * Math.hypot(re[k], im[k]));
      mag[k] = m;
      if (prev && m > prev[k]) fl += m - prev[k];
      if (fi % 4 === 0 && pc[k] >= 0) chroma[pc[k]] += m;
    }
    flux[fi] = fl;
    prev = mag;
  }
  // BPM: autocorrelation of the onset strength, with a gentle pull towards ~120.
  const fps = SR / HOP;
  const mean = flux.reduce((a, b) => a + b, 0) / frames;
  const on = flux.map((x) => Math.max(0, x - mean));
  let best = { bpm: 0, v: -Infinity };
  const curve = [];
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = (60 * fps) / bpm;
    const l0 = Math.floor(lag);
    const fr = lag - l0;
    let v = 0;
    for (let i = 0; i + l0 + 1 < frames; i++) v += on[i] * (on[i + l0] * (1 - fr) + on[i + l0 + 1] * fr);
    v *= Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    curve.push(v);
    if (v > best.v) best = { bpm, v };
  }
  // Fine pass around the best, 0.05 BPM steps, comparing 1 to 8 beats ahead:
  // one beat is only ~20 frames, so a single lag would stick to whole frames.
  const at = (bpm) => {
    let v = 0;
    for (let beats = 1; beats <= 8; beats++) {
      const lag = (60 * fps * beats) / bpm;
      const l0 = Math.floor(lag);
      const fr = lag - l0;
      for (let i = 0; i + l0 + 1 < frames; i++) v += on[i] * (on[i + l0] * (1 - fr) + on[i + l0 + 1] * fr);
    }
    return v;
  };
  let fine = best.bpm;
  let fineV = -Infinity;
  for (let b = best.bpm - 1; b <= best.bpm + 1; b += 0.05) {
    const v = at(b);
    if (v > fineV) {
      fineV = v;
      fine = b;
    }
  }
  // Half or double? If twice as fast fits almost as well, it's the real tempo (drum & bass, fast punk …).
  if (fine * 2 <= 190 && at(fine * 2) >= 0.85 * fineV) fine *= 2;
  best.bpm = fine;
  const sorted = [...curve].sort((a, b) => b - a);
  const bpmConfidence = Math.max(0, Math.min(1, (best.v - sorted[Math.floor(sorted.length / 2)]) / (best.v || 1)));
  // Key: the profile that fits the chroma best.
  let key = { name: '', camelot: '', r: -2 };
  for (let t = 0; t < 12; t++) {
    const rot = (p) => p.map((_, i) => p[(i - t + 12) % 12]);
    const rM = corr([...chroma], rot(MAJOR));
    const rm = corr([...chroma], rot(MINOR));
    if (rM > key.r) key = { name: NOTES[t], camelot: CAMELOT_MAJOR[t], r: rM };
    if (rm > key.r) key = { name: `${NOTES[t]}m`, camelot: CAMELOT_MINOR[t], r: rm };
  }
  return { bpm: Math.round(best.bpm * 10) / 10 === Math.round(best.bpm) ? Math.round(best.bpm) : Math.round(best.bpm), bpmConfidence: Math.round(bpmConfidence * 100) / 100, key: key.name, camelot: key.camelot, keyConfidence: Math.round(Math.max(0, key.r) * 100) / 100 };
}
