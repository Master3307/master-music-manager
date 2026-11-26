// The filter language used by the search bar, smart selections, bulk commands
// and exports. Examples:
//   daft punk                         words anywhere (title, artist, album, file name)
//   artist:"daft punk" year>=2001     field contains / compares
//   filename:*remix*                  wildcards: * any text, ? one character
//   title~/^intro$/i                  regular expressions
//   duration:3:00..5:00               ranges; lengths as 3:20, 200, 3m20s
//   size>10MB bitrate<192             units
//   added:30d                         added in the last 30 days
//   -genre:rock  NOT has:cover        negation
//   (artist:a OR artist:b) is:lossless
//   missing:genre  empty:album        empty fields
//   tag.MOOD:happy   #LANGUAGE=jpn    any custom tag
//   sort:-year,album,track            sorting can live in the query too
import { FIELD, FILE_FIELDS } from './tags.js';

export const ALIASES = {
  len: 'duration', length: 'duration', time: 'duration', dur: 'duration',
  kbps: 'bitrate', br: 'bitrate', rate: 'samplerate', hz: 'samplerate',
  file: 'filename', name: 'filename', fn: 'filename', dir: 'folder', directory: 'folder',
  aa: 'albumartist', 'album_artist': 'albumartist', 'albumartists': 'albumartist',
  a: 'artist', t: 'title', al: 'album', g: 'genre', genres: 'genre', y: 'year',
  n: 'track', tn: 'track', tracknumber: 'track', d: 'disc', disk: 'disc', discnumber: 'disc',
  type: 'ext', format: 'ext', extension: 'ext', lyric: 'lyrics', comments: 'comment',
  date_added: 'added', created: 'added', mtime: 'modified', changed: 'modified',
  bit: 'bits', bitdepth: 'bits', ch: 'channels', isrcs: 'isrc', labels: 'label', composers: 'composer',
};

const TYPES = Object.fromEntries([...FILE_FIELDS, ...Object.values(FIELD)].map((f) => [f.key, f.type || 'text']));
TYPES.year = 'number';
TYPES.track = 'number';
TYPES.disc = 'number';

export function fieldName(raw) {
  const k = String(raw).toLowerCase();
  if (k.startsWith('tag.') || k.startsWith('#')) return { custom: raw.replace(/^(tag\.|#)/i, '') };
  return { key: ALIASES[k] || k };
}

// ---- value parsing ----
export function parseDuration(s) {
  s = String(s).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(s)) return s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)s(?:ec)?)?$/);
  if (m && (m[1] || m[2] || m[3])) return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return Number.NaN;
}
export function parseSize(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i);
  if (!m) return Number.NaN;
  const u = (m[2] || 'b').toLowerCase()[0];
  return Number(m[1]) * { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[u];
}
export function parseDate(s) {
  s = String(s).trim().toLowerCase();
  const rel = s.match(/^(\d+)\s*(h|d|w|m|y)$/);
  if (rel) return Date.now() - Number(rel[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[rel[2]];
  if (s === 'today') return new Date().setHours(0, 0, 0, 0);
  if (s === 'yesterday') return new Date().setHours(0, 0, 0, 0) - 86400e3;
  const t = Date.parse(s);
  return Number.isNaN(t) ? Number.NaN : t;
}
function typed(type, raw) {
  if (type === 'duration') return parseDuration(raw);
  if (type === 'size') return parseSize(raw);
  if (type === 'date') return parseDate(raw);
  if (type === 'number') return Number(String(raw).replace(',', '.'));
  if (type === 'bool') return /^(1|true|yes|y|on)$/i.test(String(raw));
  return raw;
}

export function globToRegex(glob, { anchored = true, flags = 'i' } = {}) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(anchored ? `^${esc}$` : esc, flags);
}

// ---- tokenizer ----
function tokenize(input) {
  const tokens = [];
  let i = 0;
  const s = String(input);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ t: ch });
      i++;
      continue;
    }
    if (s.startsWith('||', i) || s.startsWith('&&', i)) {
      tokens.push({ t: s[i] === '|' ? 'OR' : 'AND' });
      i += 2;
      continue;
    }
    let neg = false;
    if ((ch === '-' || ch === '!') && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      neg = true;
      i++;
    }
    // A word, possibly field + operator + value.
    const start = i;
    let field = null;
    let op = null;
    const fm = s.slice(i).match(/^([#A-Za-z_][\w.#-]*)(==|!=|>=|<=|!~|[:=<>~^$])/);
    if (fm && !/^https?$/i.test(fm[1])) {
      field = fm[1];
      op = fm[2];
      i += fm[0].length;
    }
    let value = '';
    let quoted = false;
    let regex = null;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        value += s[i++];
      }
      i++;
      quoted = true;
    } else if (s[i] === '/' && (op === '~' || op === '!~' || op === ':' || !field)) {
      const m = s.slice(i).match(/^\/((?:\\.|[^/])+)\/([gimsuy]*)/);
      if (m) {
        regex = { source: m[1], flags: m[2].includes('i') ? m[2] : m[2] };
        i += m[0].length;
      }
    }
    if (!quoted && !regex) {
      while (i < s.length && !/[\s()]/.test(s[i])) value += s[i++];
    }
    const word = s.slice(start, i);
    if (!field && !quoted && !regex && /^(OR|AND|NOT)$/.test(word)) {
      tokens.push({ t: word });
      continue;
    }
    tokens.push({ t: 'term', field, op, value, quoted, regex, neg });
  }
  return tokens;
}

// ---- parser (precedence: NOT > AND > OR) ----
export function parse(input) {
  const tokens = tokenize(input);
  const sort = [];
  let pos = 0;
  const peek = () => tokens[pos];
  function primary() {
    const tk = tokens[pos++];
    if (!tk) return null;
    if (tk.t === 'NOT') return { not: primary() };
    if (tk.t === '(') {
      const e = or();
      if (peek()?.t === ')') pos++;
      return e;
    }
    if (tk.t === 'term') {
      if (tk.field?.toLowerCase() === 'sort' && !tk.neg) {
        for (const part of tk.value.split(',').filter(Boolean)) sort.push({ key: fieldName(part.replace(/^[-+]/, '')).key || part, desc: part.startsWith('-') });
        return { all: true };
      }
      return tk.neg ? { not: { term: tk } } : { term: tk };
    }
    return { all: true };
  }
  function and() {
    const parts = [primary()];
    while (peek() && peek().t !== 'OR' && peek().t !== ')') {
      if (peek().t === 'AND') pos++;
      parts.push(primary());
    }
    return parts.length === 1 ? parts[0] : { and: parts };
  }
  function or() {
    const parts = [and()];
    while (peek()?.t === 'OR') {
      pos++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : { or: parts };
  }
  const tree = tokens.length ? or() : { all: true };
  return { tree, sort };
}

// ---- evaluation ----
const ANY_FIELDS = ['title', 'artist', 'album', 'albumartist', 'filename'];
const lower = (v) => String(v ?? '').toLowerCase();

export function valueOf(track, f) {
  if (f.custom) {
    const c = track.custom || {};
    const k = Object.keys(c).find((x) => x.toLowerCase() === f.custom.toLowerCase());
    return k ? c[k] : undefined;
  }
  return track[f.key];
}

function textMatcher(tk) {
  if (tk.regex) {
    const re = new RegExp(tk.regex.source, tk.regex.flags.includes('i') || !tk.regex.flags ? tk.regex.flags || 'i' : tk.regex.flags);
    return (v) => re.test(String(v ?? ''));
  }
  const value = tk.value;
  const hasWild = !tk.quoted && /[*?]/.test(value);
  if (tk.op === '~' || tk.op === '!~') {
    let re;
    try {
      re = new RegExp(value, 'i');
    } catch {
      re = globToRegex(value, { anchored: false });
    }
    return (v) => re.test(String(v ?? ''));
  }
  if (tk.op === '=' || tk.op === '!=') {
    if (hasWild) {
      const re = globToRegex(value);
      return (v) => re.test(String(v ?? ''));
    }
    const lv = lower(value);
    return (v) => lower(v) === lv;
  }
  if (tk.op === '==') return (v) => String(v ?? '') === value;
  if (tk.op === '^') return (v) => lower(v).startsWith(lower(value));
  if (tk.op === '$') return (v) => lower(v).endsWith(lower(value));
  if (hasWild) {
    const re = globToRegex(value, { anchored: true });
    return (v) => re.test(String(v ?? ''));
  }
  const lv = lower(value);
  return (v) => lower(v).includes(lv);
}

function compileTerm(tk) {
  // Bare words search the common text fields.
  if (!tk.field) {
    const m = textMatcher({ ...tk, op: ':' });
    return (t) => ANY_FIELDS.some((k) => (Array.isArray(t[k]) ? t[k].some(m) : m(t[k])));
  }
  const fl = tk.field.toLowerCase();
  if (fl === 'has' || fl === 'is' || fl === 'missing' || fl === 'empty') {
    const f = fieldName(tk.value);
    const key = f.key;
    const isEmpty = (t) => {
      const v = valueOf(t, f);
      return v == null || v === '' || v === 0 || v === false || (Array.isArray(v) && !v.length);
    };
    if (fl === 'missing' || fl === 'empty') return isEmpty;
    if (key === 'single') return (t) => !t.album || lower(t.album) === lower(t.title);
    if (key === 'lossy') return (t) => !t.lossless;
    if (key === 'duplicate' || key === 'dupe') return (t) => Boolean(t.dupe);
    if (key === 'split' || key === 'nosplit') return (t) => (key === 'nosplit' ? t.nosplit : !t.nosplit);
    return (t) => !isEmpty(t);
  }
  const f = fieldName(tk.field);
  const type = f.custom ? 'text' : TYPES[f.key] || 'text';
  const negate = tk.op === '!=' || tk.op === '!~';
  let test;
  const val = tk.value;
  if (type === 'text' || tk.regex) {
    const m = textMatcher(tk);
    test = (v) => (Array.isArray(v) ? v.some(m) : m(v));
  } else if (type === 'bool') {
    const want = typed('bool', val);
    test = (v) => Boolean(v) === want;
  } else {
    // number / duration / size / date
    if (type === 'date' && (tk.op === ':' || tk.op === '=') && /^\d+\s*[hdwmy]$|^today$|^yesterday$/i.test(val)) {
      const since = parseDate(val);
      test = (v) => v >= since;
    } else if (val.includes('..')) {
      const [a, b] = val.split('..');
      const lo = a ? typed(type, a) : -Infinity;
      const hi = b ? typed(type, b) : Infinity;
      test = (v) => v != null && v >= lo && v <= hi;
    } else {
      const n = typed(type, val);
      const cmp = { '>': (v) => v > n, '<': (v) => v < n, '>=': (v) => v >= n, '<=': (v) => v <= n }[tk.op];
      if (cmp) test = (v) => v != null && cmp(Number(v));
      else if (type === 'duration') test = (v) => v != null && Math.round(v) === Math.round(n);
      else if (type === 'date') {
        // a day: everything in that day
        const end = n + 86400e3;
        test = (v) => v >= n && v < end;
      } else test = (v) => v != null && Number(v) === n;
    }
  }
  return (t) => {
    const r = test(valueOf(t, f));
    return negate ? !r : r;
  };
}

function compileNode(node) {
  if (!node || node.all) return () => true;
  if (node.not) {
    const inner = compileNode(node.not);
    return (t) => !inner(t);
  }
  if (node.and) {
    const parts = node.and.map(compileNode);
    return (t) => parts.every((p) => p(t));
  }
  if (node.or) {
    const parts = node.or.map(compileNode);
    return (t) => parts.some((p) => p(t));
  }
  if (node.term) return compileTerm(node.term);
  return () => true;
}

/** Compile a query string into { test(track), sort[] }. Throws on invalid regex. */
export function compile(input) {
  const { tree, sort } = parse(input || '');
  return { test: compileNode(tree), sort };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sorter(spec) {
  const list = (spec || []).filter((s) => s.key);
  if (!list.length) return null;
  return (a, b) => {
    for (const { key, desc } of list) {
      const f = fieldName(key);
      let x = valueOf(a, f);
      let y = valueOf(b, f);
      if (Array.isArray(x)) x = x.join(', ');
      if (Array.isArray(y)) y = y.join(', ');
      const ex = x == null || x === '';
      const ey = y == null || y === '';
      if (ex && ey) continue;
      if (ex) return 1; // empty values always last
      if (ey) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      if (r) return desc ? -r : r;
    }
    return 0;
  };
}

/** Parse "artist,-year" into a sort spec. */
export function parseSort(s) {
  return String(s || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ key: fieldName(p.replace(/^[-+]/, '')).key || p.replace(/^[-+]/, ''), desc: p.startsWith('-') }));
}
