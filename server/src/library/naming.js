// Artist separators and the file name template.
//
// Template syntax:
//   {title}                 a field (any tag, custom tag via {tag.NAME})
//   {albumartist|artist}    the first one that isn't empty; "quoted" text works as a fallback
//   {track:2}               zero padded to 2 digits
//   {artist:upper} {title:lower} {title:title} {artist:first} {artist:initial}
//   {?track:{track:2} - }   only if the condition holds; conditions: field, !field,
//                           field>1, field=value, several joined with | (or)
//   {folderartist}          the album artist (or artist), only the first one if the
//                           library setting says "primary"
//   {ext}                   file extension (added automatically when missing)
import path from 'node:path';

export const SEPARATORS = [
  { value: ' / ', label: 'Slash with spaces  ·  A / B', note: 'Navidrome and most servers split on this.' },
  { value: '; ', label: 'Semicolon  ·  A; B', note: 'The ID3v2.4 / Picard style.' },
  { value: ', ', label: 'Comma  ·  A, B', note: 'Readable, but breaks names like "Tyler, The Creator".' },
  { value: ' & ', label: 'Ampersand  ·  A & B', note: 'Looks natural; servers rarely split it.' },
  { value: ' feat. ', label: 'feat.  ·  A feat. B', note: 'The classic credit style.' },
  { value: ' x ', label: 'x  ·  A x B', note: 'Common for collabs.' },
  { value: ' + ', label: 'Plus  ·  A + B', note: '' },
  { value: '/', label: 'Slash  ·  A/B', note: 'ID3v2.3 style without spaces.' },
  { value: '\u0000', label: 'Null character (ID3v2.4 multi-value)', note: 'Invisible; true multi-value tags.' },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split an artist string into names, keeping protected names whole. */
export function splitArtists(value, lib, { noSplit = false } = {}) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value.flatMap((v) => String(v).split('\u0000')) : String(value).split('\u0000');
  if (noSplit || !lib.splitArtists) return dedupe(list.map((s) => s.trim()).filter(Boolean));
  const keep = (lib.keepTogether || []).filter(Boolean);
  const out = [];
  for (let item of list) {
    // Shield protected names behind placeholders before splitting.
    const shields = [];
    for (const name of keep) {
      const re = new RegExp(escapeRe(name), 'gi');
      item = item.replace(re, (m) => {
        shields.push(m);
        return `\u0001${shields.length - 1}\u0001`;
      });
    }
    const parts = lib.splitOn?.length ? item.split(splitPattern(lib.splitOn)) : [item];
    for (const p of parts) out.push(p.replace(/\u0001(\d+)\u0001/g, (_, i) => shields[Number(i)]).replace(/^[([]+|[)\]]+$/g, '').trim());
  }
  return dedupe(out.filter(Boolean));
}

const patterns = new Map();
/** Word separators (x, feat., ft) need spaces around them; punctuation doesn't. "feat." also matches "feat" and "(feat. …)". */
function splitPattern(list) {
  const key = list.join('\u0002');
  if (patterns.has(key)) return patterns.get(key);
  const alts = list
    .filter((s) => s !== '')
    .map((s) => {
      const t = s.trim();
      if (!t) return '\\s+';
      const esc = escapeRe(t).replace(/\\\.$/, '\\.?');
      return /^[a-z.]+$/i.test(t) ? `\\s*[([]?\\s*\\b${esc}(?=\\s)\\s*` : `\\s*${esc}\\s*`;
    });
  const re = new RegExp(alts.join('|'), 'i');
  patterns.set(key, re);
  return re;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function joinArtists(list, sep) {
  return (list || []).filter(Boolean).join(sep === '\\0' ? '\u0000' : sep);
}

/** Make a path segment safe on Linux, Windows and SMB shares. */
export function safePart(value, fallback, lib = {}) {
  let v = String(value ?? '')
    .replace(/\u0000/g, ' / ')
    .trim();
  const repl = lib.illegalChars === 'remove' ? '' : '_';
  v = v.replace(/[\x00-\x1f<>:"/\\|?*]/g, (c) => (c === '/' || c === '\\' ? (lib.illegalChars === 'remove' ? '' : '-') : repl));
  v = v.replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(v)) v = `_${v}`;
  const max = lib.maxPathPart || 120;
  if (Buffer.byteLength(v) > max) {
    while (Buffer.byteLength(v) > max) v = v.slice(0, -1);
    v = v.trim();
  }
  return v || fallback;
}

function pick(track, name, lib) {
  if (/^".*"$/.test(name)) return name.slice(1, -1);
  const key = name.toLowerCase();
  if (key === 'folderartist') {
    const src = track.albumartist || track.artist;
    if (!src) return '';
    const list = splitArtists(src, lib, { noSplit: track.nosplit });
    return lib.folderArtist === 'all' ? joinArtists(list, lib.separator) : list[0] || '';
  }
  if (key === 'primaryartist') return splitArtists(track.artist, lib, { noSplit: track.nosplit })[0] || '';
  if (key.startsWith('tag.')) {
    const c = track.custom || {};
    const k = Object.keys(c).find((x) => x.toLowerCase() === key.slice(4));
    return k ? c[k] : '';
  }
  if (key === 'length' || key === 'duration') return track.duration ? fmtDuration(track.duration) : '';
  if (key === 'filename') return track.filename ? track.filename.replace(/\.[^.]+$/, '') : '';
  const v = track[key];
  if (Array.isArray(v)) return key === 'artists' ? joinArtists(v, lib.separator) : v.join(', ');
  return v ?? '';
}

export function fmtDuration(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function cond(track, expr, lib) {
  return expr.split('|').some((c) => {
    c = c.trim();
    if (c.startsWith('!')) return !String(pick(track, c.slice(1), lib) ?? '').length;
    const m = c.match(/^([\w.]+)\s*(>=|<=|!=|=|>|<)\s*(.+)$/);
    if (!m) {
      const v = pick(track, c, lib);
      return v !== '' && v != null && v !== 0;
    }
    const v = pick(track, m[1], lib);
    const n = Number(v);
    const w = Number(m[3]);
    switch (m[2]) {
      case '>':
        return n > w;
      case '<':
        return n < w;
      case '>=':
        return n >= w;
      case '<=':
        return n <= w;
      case '!=':
        return String(v).toLowerCase() !== m[3].toLowerCase();
      default:
        return String(v).toLowerCase() === m[3].toLowerCase();
    }
  });
}

function modify(value, mod) {
  if (value === '' || value == null) return '';
  if (/^\d+$/.test(mod)) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? String(n).padStart(Number(mod), '0') : String(value);
  }
  const s = String(value);
  switch (mod) {
    case 'upper':
      return s.toUpperCase();
    case 'lower':
      return s.toLowerCase();
    case 'title':
      return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
    case 'first':
      return s.split(/\s*(?:\/|;|,)\s*/)[0];
    case 'initial':
      return (s.replace(/^(the|a|an|die|der|das|le|la|les)\s+/i, '')[0] || '#').toUpperCase().replace(/[^A-Z]/, '#');
    case 'year':
      return s.slice(0, 4);
    default:
      return s;
  }
}

/** Render a template for a track. `safe` cleans each path segment. */
export function render(template, track, lib, { safe = false } = {}) {
  // Expand innermost {...} first so conditionals can contain fields.
  const expand = (tpl) => {
    let out = '';
    let i = 0;
    while (i < tpl.length) {
      if (tpl[i] === '\\' && i + 1 < tpl.length) {
        out += tpl[i + 1];
        i += 2;
        continue;
      }
      if (tpl[i] !== '{') {
        out += tpl[i++];
        continue;
      }
      let depth = 1;
      let j = i + 1;
      while (j < tpl.length && depth) {
        if (tpl[j] === '{') depth++;
        else if (tpl[j] === '}') depth--;
        j++;
      }
      const inner = tpl.slice(i + 1, j - 1);
      i = j;
      if (inner.startsWith('?')) {
        const colon = inner.indexOf(':');
        const c = colon < 0 ? inner.slice(1) : inner.slice(1, colon);
        if (cond(track, c, lib)) out += expand(colon < 0 ? '' : inner.slice(colon + 1));
        continue;
      }
      const [names, mod] = splitMod(inner);
      let v = '';
      for (const n of names.split('|')) {
        v = pick(track, n.trim(), lib);
        if (v !== '' && v != null) break;
      }
      out += mod ? modify(v, mod) : String(v ?? '');
    }
    return out;
  };
  const raw = expand(template);
  if (!safe) return raw;
  return raw
    .split('/')
    .map((part, i, arr) => safePart(part, i === arr.length - 1 ? lib.unknownTitle || 'Untitled' : i === 0 ? lib.unknownArtist || 'Unknown Artist' : lib.unknownAlbum || 'Unknown Album', lib))
    .join('/');
}

function splitMod(inner) {
  const i = inner.lastIndexOf(':');
  if (i < 0) return [inner, null];
  const mod = inner.slice(i + 1);
  if (/^(\d+|upper|lower|title|first|initial|year)$/.test(mod)) return [inner.slice(0, i), mod];
  return [inner, null];
}

/** Where a track should live, relative to the library folder (with extension). */
export function targetPath(track, lib, { misc = false } = {}) {
  const ext = (track.ext || path.extname(track.path || track.filename || '').slice(1) || 'mp3').toLowerCase();
  const unknown = !track.title && !track.artist;
  if (misc && unknown) {
    const base = safePart((track.filename || 'Untitled').replace(/\.[^.]+$/, ''), 'Untitled', lib);
    return `${safePart(lib.misc?.folder || '!Misc', '!Misc', lib)}/${base}.${ext}`;
  }
  const t = { ...track, title: track.title || (track.filename || '').replace(/\.[^.]+$/, '') || 'Untitled' };
  const rel = render(lib.template, t, lib, { safe: true });
  return `${rel}.${ext}`;
}

/** Apply separator rules to artist tags. Returns the changed fields only. */
export function normalizeArtistTags(tags, lib, { noSplit = false } = {}) {
  const out = {};
  if (!lib.splitArtists || noSplit) return out;
  for (const key of ['artist', 'albumartist']) {
    if (!tags[key]) continue;
    const list = splitArtists(tags[key], lib);
    const joined = joinArtists(list, lib.separator);
    if (joined !== tags[key]) out[key] = joined;
    if (key === 'artist' && list.length > 1) {
      const cur = JSON.stringify(tags.artists || []);
      if (cur !== JSON.stringify(list)) out.artists = list;
    }
  }
  return out;
}
