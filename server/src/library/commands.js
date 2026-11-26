// Bulk operations and the command line. Every operation is first computed as
// a preview (old → new per track) and only written when the user confirms.
import path from 'node:path';
import * as settings from '../settings.js';
import { FIELD } from './tags.js';
import { render, splitArtists, joinArtists, targetPath, safePart } from './naming.js';
import { globToRegex } from './query.js';

const TEXT_FIELDS = Object.values(FIELD)
  .filter((f) => !f.type || f.type === 'text')
  .map((f) => f.key);

export const HELP = [
  { cmd: 'set <field> = <value>', example: 'set genre = "Lo-Fi"', text: 'Set a field. Values can use the template, e.g. "{artist} - {title}".' },
  { cmd: 'replace <field|*> "find" "with"', example: 'replace artist " & " " / "', text: 'Find and replace. * means every text field. Add --wild for * and ? wildcards (each * can be put back with *), --regex for regular expressions ($1 …), --case to match case, --word for whole words.' },
  { cmd: 'remove <field|*> "text"', example: 'remove title "(Official Video)"', text: 'Remove text (same flags as replace).' },
  { cmd: 'case <field> title|upper|lower|sentence', example: 'case title title', text: 'Change capitalization.' },
  { cmd: 'trim <field|*>', example: 'trim *', text: 'Remove extra spaces.' },
  { cmd: 'clear <field>', example: 'clear comment', text: 'Empty a field.' },
  { cmd: 'copy <from> <to>', example: 'copy artist albumartist', text: 'Copy one field into another.' },
  { cmd: 'swap <a> <b>', example: 'swap title artist', text: 'Swap two fields.' },
  { cmd: 'prefix|suffix <field> "text"', example: 'suffix title " (Remastered)"', text: 'Add text before or after.' },
  { cmd: 'number <field> [from N] [per album|all]', example: 'number track per album', text: 'Number tracks in the current order.' },
  { cmd: 'tag <NAME> = <value>', example: 'tag LANGUAGE = jpn', text: 'Set a custom tag (empty value removes it).' },
  { cmd: 'parse "<pattern>" [from filename|title|folder]', example: 'parse "{track} - {artist} - {title}"', text: 'Read tags out of the file name (or another field).' },
  { cmd: 'separators', example: 'separators', text: 'Apply the artist separator setting.' },
  { cmd: 'keep-together on|off', example: 'keep-together on', text: 'Never split these tracks\' artists.' },
  { cmd: 'organize', example: 'organize', text: 'Move files to where the folder template says.' },
  { cmd: 'rename "<template>"', example: 'rename "{track:2}. {title}"', text: 'Rename files inside their folder.' },
  { cmd: 'move "<template>"', example: 'move "{genre}/{artist}/{album}/{title}"', text: 'Move files with a one-off template.' },
  { cmd: 'delete', example: 'delete', text: 'Move to the trash (can be undone in Trash).' },
  { cmd: '… where <filter>', example: 'set genre = Phonk where artist:kordhell', text: 'Run on a filter instead of the selection.' },
  { cmd: 'a ; b', example: 'trim * ; case title title', text: 'Run several commands in a row.' },
];

function tokens(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      let v = '';
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          v += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i++;
          continue;
        }
        v += s[i++];
      }
      i++;
      out.push({ v, q: true });
      continue;
    }
    let v = '';
    while (i < s.length && !/\s/.test(s[i])) v += s[i++];
    out.push({ v, q: false });
  }
  return out;
}

const fieldKey = (f) => {
  const k = String(f).toLowerCase();
  const alias = { genres: 'genre', 'album_artist': 'albumartist', tracknumber: 'track', discnumber: 'disc', comments: 'comment', composers: 'composer' };
  return alias[k] || k;
};

/** Split "a ; b" and "... where q" into [{ ops:[...], where }] */
export function parseCommand(input) {
  const parts = splitTop(String(input), ';');
  const result = [];
  for (const raw of parts) {
    const text = raw.trim();
    if (!text) continue;
    const w = text.search(/\swhere\s/i);
    const cmdText = w >= 0 ? text.slice(0, w) : text;
    const where = w >= 0 ? text.slice(w).replace(/^\s*where\s+/i, '') : null;
    const t = tokens(cmdText);
    const flags = new Set(t.filter((x) => !x.q && x.v.startsWith('--')).map((x) => x.v.slice(2)));
    const a = t.filter((x) => x.q || !x.v.startsWith('--'));
    const name = a[0]?.v.toLowerCase();
    const arg = (n) => a[n]?.v;
    let op;
    switch (name) {
      case 'set': {
        const eq = a.findIndex((x, i) => i > 0 && !x.q && x.v === '=');
        const field = fieldKey(arg(1).replace(/=$/, ''));
        const value = eq > 0 ? a.slice(eq + 1).map((x) => x.v).join(' ') : a.slice(2).map((x) => x.v).join(' ');
        op = { type: 'set', field, value };
        break;
      }
      case 'tag': {
        const eq = a.findIndex((x, i) => i > 0 && !x.q && x.v === '=');
        op = { type: 'custom', name: arg(1), value: eq > 0 ? a.slice(eq + 1).map((x) => x.v).join(' ') : a.slice(2).map((x) => x.v).join(' ') };
        break;
      }
      case 'replace':
      case 'remove': {
        op = {
          type: 'replace',
          field: arg(1) === '*' ? '*' : fieldKey(arg(1)),
          find: arg(2) ?? '',
          replace: name === 'remove' ? '' : (arg(3) ?? ''),
          mode: flags.has('regex') || flags.has('re') ? 'regex' : flags.has('wild') || flags.has('wildcard') ? 'wildcard' : 'text',
          caseSensitive: flags.has('case'),
          wholeWord: flags.has('word'),
        };
        break;
      }
      case 'case':
        op = { type: 'case', field: arg(1) === '*' ? '*' : fieldKey(arg(1)), style: (arg(2) || 'title').toLowerCase() };
        break;
      case 'trim':
        op = { type: 'trim', field: !arg(1) || arg(1) === '*' ? '*' : fieldKey(arg(1)) };
        break;
      case 'clear':
        op = { type: 'clear', field: fieldKey(arg(1)) };
        break;
      case 'copy':
        op = { type: 'copy', from: fieldKey(arg(1)), to: fieldKey(arg(2)) };
        break;
      case 'swap':
        op = { type: 'swap', a: fieldKey(arg(1)), b: fieldKey(arg(2)) };
        break;
      case 'prefix':
      case 'suffix':
        op = { type: name, field: fieldKey(arg(1)), value: arg(2) ?? '' };
        break;
      case 'number': {
        const from = a.findIndex((x) => x.v === 'from');
        const per = a.findIndex((x) => x.v === 'per');
        op = { type: 'number', field: fieldKey(arg(1) || 'track'), start: from > 0 ? Number(arg(from + 1)) : 1, per: per > 0 ? arg(per + 1) : 'album' };
        break;
      }
      case 'parse': {
        const from = a.findIndex((x) => !x.q && x.v === 'from');
        op = { type: 'parse', pattern: arg(1), from: from > 0 ? fieldKey(arg(from + 1)) : 'filename' };
        break;
      }
      case 'separators':
        op = { type: 'separators' };
        break;
      case 'keep-together':
      case 'nosplit':
        op = { type: 'nosplit', value: !/^(off|no|false)$/i.test(arg(1) || 'on') };
        break;
      case 'organize':
        op = { type: 'organize' };
        break;
      case 'rename':
        op = { type: 'rename', template: arg(1) };
        break;
      case 'move':
        op = { type: 'move', template: arg(1) };
        break;
      case 'delete':
      case 'trash':
        op = { type: 'delete' };
        break;
      default:
        throw Object.assign(new Error(`Unknown command "${a[0]?.v || ''}". Type help to see what's possible.`), { status: 400 });
    }
    result.push({ op, where });
  }
  return result;
}

function splitTop(s, sep) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === sep || ch === '\n') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replacer(op) {
  const flags = op.caseSensitive ? 'g' : 'gi';
  if (op.mode === 'regex') {
    const re = new RegExp(op.find, flags);
    return (v) => v.replace(re, op.replace);
  }
  if (op.mode === 'wildcard') {
    // Each * / ? becomes a group; a * in the replacement puts the matching text back.
    let n = 0;
    const src = String(op.find)
      .split(/([*?])/)
      .map((p) => (p === '*' ? (n++, '(.*?)') : p === '?' ? (n++, '(.)') : escapeRe(p)))
      .join('');
    const re = new RegExp(op.wholeWord ? `\\b${src}\\b` : src, flags);
    return (v) =>
      v.replace(re, (...m) => {
        let k = 1;
        return String(op.replace).replace(/\*/g, () => m[k++] ?? '');
      });
  }
  const re = new RegExp(op.wholeWord ? `\\b${escapeRe(op.find)}\\b` : escapeRe(op.find), flags);
  return (v) => v.replace(re, () => op.replace);
}

function toCase(v, style) {
  const s = String(v);
  if (style === 'upper') return s.toUpperCase();
  if (style === 'lower') return s.toLowerCase();
  if (style === 'sentence') return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'feat', 'ft']);
  return s
    .toLowerCase()
    .split(/(\s+|-|\/|\()/)
    .map((w, i, arr) => (i > 0 && i < arr.length - 1 && small.has(w.replace(/\.$/, '')) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('')
    .replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix|Dj|Mc|Uk|Usa|Edm|Ep|Lp)\b/g, (m) => m.toUpperCase());
}

function patternToRegex(pattern) {
  const fields = [];
  const src = String(pattern)
    .split(/(\{[\w.]+\})/)
    .map((p) => {
      const m = p.match(/^\{([\w.]+)\}$/);
      if (!m) return escapeRe(p).replace(/\\\*/g, '.*?');
      fields.push(fieldKey(m[1]));
      return ['track', 'disc', 'year', 'tracktotal', 'disctotal', 'bpm'].includes(fieldKey(m[1])) ? '(\\d+)' : '(.+?)';
    })
    .join('');
  return { re: new RegExp(`^${src}$`, 'i'), fields };
}

const get = (t, f) => (Array.isArray(t[f]) ? t[f].join('; ') : t[f] == null ? '' : String(t[f]));

/**
 * Plan the operations for a list of tracks (already in display order).
 * Returns [{ id, changes: { field: [old, new] }, custom, move, delete }].
 */
export function plan(tracks, ops) {
  const lib = settings.get('library');
  const plans = new Map(tracks.map((t) => [t.id, { id: t.id, path: t.path, title: t.title, artist: t.artist, tags: {}, custom: {}, view: { ...t, custom: { ...(t.custom || {}) } } }]));
  for (const op of ops) {
    const counters = new Map();
    for (const t of tracks) {
      const p = plans.get(t.id);
      const v = p.view;
      const setTag = (field, value) => {
        const fd = FIELD[field];
        if (!fd) throw Object.assign(new Error(`"${field}" is not a tag. Use "tag ${field} = …" for custom tags.`), { status: 400 });
        const next = fd.list ? (value === '' ? [] : String(value).split(/\s*;\s*/).filter(Boolean)) : fd.type === 'number' ? (value === '' ? null : Number(value)) : value;
        v[field] = next;
        p.tags[field] = next;
      };
      const fields = (f) => (f === '*' ? TEXT_FIELDS.filter((k) => v[k] != null && v[k] !== '') : [f]);
      switch (op.type) {
        case 'set':
          setTag(op.field, /\{/.test(op.value) ? render(op.value, v, lib) : op.value);
          break;
        case 'custom':
          v.custom[op.name] = op.value || null;
          p.custom[op.name] = op.value || null;
          break;
        case 'replace': {
          const fn = replacer(op);
          for (const f of fields(op.field)) {
            const cur = get(v, f);
            const next = fn(cur);
            if (next !== cur) setTag(f, next);
          }
          break;
        }
        case 'case':
          for (const f of fields(op.field)) if (get(v, f)) setTag(f, toCase(get(v, f), op.style));
          break;
        case 'trim':
          for (const f of fields(op.field)) {
            const cur = get(v, f);
            const next = cur.replace(/\s+/g, ' ').trim();
            if (next !== cur) setTag(f, next);
          }
          break;
        case 'clear':
          setTag(op.field, '');
          break;
        case 'copy':
          setTag(op.to, get(v, op.from));
          break;
        case 'swap': {
          const x = get(v, op.a);
          const y = get(v, op.b);
          setTag(op.a, y);
          setTag(op.b, x);
          break;
        }
        case 'prefix':
          setTag(op.field, `${op.value}${get(v, op.field)}`);
          break;
        case 'suffix':
          setTag(op.field, `${get(v, op.field)}${op.value}`);
          break;
        case 'number': {
          const group = op.per === 'all' ? '*' : op.per === 'folder' ? v.folder : `${v.albumartist || v.artist}|${v.album}|${v.disc || 1}`;
          const n = counters.has(group) ? counters.get(group) + (op.step || 1) : op.start ?? 1;
          counters.set(group, n);
          setTag(op.field, n);
          break;
        }
        case 'parse': {
          const { re, fields: fs } = patternToRegex(op.pattern);
          const src = op.from === 'filename' ? v.filename.replace(/\.[^.]+$/, '') : op.from === 'folder' ? path.basename(v.folder) : get(v, op.from);
          const m = src.match(re);
          if (m) fs.forEach((f, i) => m[i + 1] != null && FIELD[f] && setTag(f, m[i + 1].trim()));
          break;
        }
        case 'separators': {
          if (v.nosplit) break;
          for (const f of ['artist', 'albumartist']) {
            if (!v[f]) continue;
            const list = splitArtists(v[f], { ...lib, splitArtists: true });
            const joined = joinArtists(list, lib.separator);
            if (joined !== v[f]) setTag(f, joined);
            if (f === 'artist' && list.length > 1) {
              v.artists = list;
              p.tags.artists = list;
            }
          }
          break;
        }
        case 'nosplit':
          p.noSplit = op.value;
          v.nosplit = op.value;
          break;
        case 'organize':
          p.move = targetPath(v, lib);
          break;
        case 'rename': {
          const name = safePart(render(op.template, v, lib), v.filename, lib);
          p.move = path.join(path.dirname(p.move || v.path), `${name}.${v.ext}`);
          break;
        }
        case 'move':
          p.move = `${render(op.template, v, lib, { safe: true })}.${v.ext}`;
          break;
        case 'delete':
          p.delete = true;
          break;
        default:
          throw Object.assign(new Error(`Unknown operation ${op.type}`), { status: 400 });
      }
    }
  }
  // Drop no-op changes and describe old → new.
  const out = [];
  for (const t of tracks) {
    const p = plans.get(t.id);
    const changes = {};
    for (const [f, nv] of Object.entries(p.tags)) {
      const ov = t[f];
      const a = Array.isArray(ov) ? ov.join('; ') : ov ?? '';
      const b = Array.isArray(nv) ? nv.join('; ') : nv ?? '';
      if (String(a) !== String(b)) changes[f] = [a, b];
    }
    const custom = {};
    for (const [k, nv] of Object.entries(p.custom)) if ((t.custom?.[k] ?? null) !== nv) custom[k] = [t.custom?.[k] ?? '', nv ?? ''];
    const move = p.move && p.move !== t.path ? p.move : null;
    const noSplit = p.noSplit !== undefined && p.noSplit !== t.nosplit ? p.noSplit : undefined;
    if (Object.keys(changes).length || Object.keys(custom).length || move || p.delete || noSplit !== undefined)
      out.push({ id: t.id, path: t.path, title: t.title, artist: t.artist, changes, custom, move, delete: Boolean(p.delete), noSplit });
  }
  return out;
}

export { toCase, replacer };
