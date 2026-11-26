// Lists ("{artist} - {title}", CSV, JSON, M3U8, …) and archives of the music itself.
import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive, TarArchive } from 'archiver';
import { FIELDS, FILE_FIELDS } from './tags.js';
import { render, fmtDuration } from './naming.js';
import * as settings from '../settings.js';
import * as lib from './index.js';

export const PRESETS = {
  minimal: { label: 'Minimal', fields: ['artist', 'title'] },
  useful: { label: 'Useful', fields: ['artist', 'title', 'album', 'albumartist', 'year', 'track', 'disc', 'genre', 'duration', 'ext', 'bitrate', 'path'] },
  all: { label: 'All', fields: null }, // every field that has a value anywhere, plus custom tags
};

export const LIST_FORMATS = {
  template: { label: 'Custom text', ext: 'txt', mime: 'text/plain', note: 'One line per song from your own pattern, e.g. {artist} - {title}.' },
  txt: { label: 'Plain text', ext: 'txt', mime: 'text/plain', note: 'Readable list, one song per line.' },
  csv: { label: 'CSV', ext: 'csv', mime: 'text/csv', note: 'Opens in Excel, LibreOffice and Google Sheets.' },
  tsv: { label: 'TSV', ext: 'tsv', mime: 'text/tab-separated-values', note: 'Like CSV, safer with commas in titles.' },
  json: { label: 'JSON', ext: 'json', mime: 'application/json', note: 'For scripts and other apps.' },
  ndjson: { label: 'JSON lines', ext: 'ndjson', mime: 'application/x-ndjson', note: 'One JSON object per line; good for huge libraries.' },
  m3u8: { label: 'M3U8 playlist', ext: 'm3u8', mime: 'audio/x-mpegurl', note: 'A playlist almost every player opens. Paths are relative to the library.' },
  xspf: { label: 'XSPF playlist', ext: 'xspf', mime: 'application/xspf+xml', note: 'Open playlist format (VLC, Strawberry…).' },
  pls: { label: 'PLS playlist', ext: 'pls', mime: 'audio/x-scpls', note: 'Old but widely supported.' },
  md: { label: 'Markdown table', ext: 'md', mime: 'text/markdown', note: 'Paste into GitHub, Discord or notes apps.' },
  html: { label: 'Web page', ext: 'html', mime: 'text/html', note: 'A nice table you can open in a browser or print.' },
};

export const ARCHIVE_FORMATS = {
  zip: { label: 'ZIP', ext: 'zip', recommended: true, why: 'Opens on every computer and phone with no extra app. Music is already compressed, so it is stored as-is: fast, and just as small.' },
  tar: { label: 'TAR', ext: 'tar', why: 'Fastest to make, keeps file dates and permissions. Best for moving to another Linux server or NAS.' },
  'tar.gz': { label: 'TAR.GZ', ext: 'tar.gz', why: 'Compressed TAR. Only worth it for lists and lyrics; music will not get smaller.' },
  '7z': { label: '7-Zip', ext: '7z', why: 'Smallest for text, but music will not get smaller and it needs 7-Zip to open. Only if you need it.', needs: '7z' },
};

function fieldsFor(tracks, preset, custom) {
  if (custom?.length) return custom;
  if (preset !== 'all') return PRESETS[preset]?.fields || PRESETS.useful.fields;
  const keys = [...FIELDS.map((f) => f.key), ...FILE_FIELDS.map((f) => f.key)];
  const present = keys.filter((k) => tracks.some((t) => t[k] != null && t[k] !== '' && !(Array.isArray(t[k]) && !t[k].length)));
  const customKeys = [...new Set(tracks.flatMap((t) => Object.keys(t.custom || {})))].map((k) => `tag.${k}`);
  return [...present, ...customKeys];
}

const LABELS = Object.fromEntries([...FIELDS, ...FILE_FIELDS].map((f) => [f.key, f.label]));
const label = (k) => (k.startsWith('tag.') ? k.slice(4) : LABELS[k] || k);

function value(t, k, raw = false) {
  const v = k.startsWith('tag.') ? t.custom?.[k.slice(4)] : t[k];
  if (raw) return v ?? null;
  if (v == null) return '';
  if (Array.isArray(v)) return v.join('; ');
  if (k === 'duration') return fmtDuration(v);
  if (k === 'added' || k === 'modified') return new Date(v).toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

const csvCell = (s, sep) => (/[",\n\r\t]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function list(tracks, { format = 'template', template = '{artist} - {title}', preset = 'useful', fields: customFields, header = true, profile, title = 'Music' } = {}) {
  const fields = fieldsFor(tracks, preset, customFields);
  const lc = settings.get('library');
  switch (format) {
    case 'template':
      return tracks.map((t) => render(template, t, lc)).join('\n');
    case 'txt':
      return tracks.map((t, i) => `${String(i + 1).padStart(String(tracks.length).length, ' ')}. ${t.artist || 'Unknown'} – ${t.title || t.filename}${t.duration ? `  (${fmtDuration(t.duration)})` : ''}`).join('\n');
    case 'csv':
    case 'tsv': {
      const sep = format === 'csv' ? ',' : '\t';
      const rows = tracks.map((t) => fields.map((k) => csvCell(value(t, k), sep)).join(sep));
      return `${format === 'csv' ? '﻿' : ''}${header ? `${fields.map((k) => csvCell(label(k), sep)).join(sep)}\n` : ''}${rows.join('\n')}`;
    }
    case 'json':
      return JSON.stringify(tracks.map((t) => Object.fromEntries(fields.map((k) => [k, value(t, k, true)]))), null, 2);
    case 'ndjson':
      return tracks.map((t) => JSON.stringify(Object.fromEntries(fields.map((k) => [k, value(t, k, true)])))).join('\n');
    case 'm3u8':
      return `#EXTM3U\n#PLAYLIST:${title}\n${tracks.map((t) => `#EXTINF:${Math.round(t.duration || -1)},${t.artist || ''} - ${t.title || ''}\n${t.path}`).join('\n')}\n`;
    case 'pls':
      return `[playlist]\n${tracks.map((t, i) => `File${i + 1}=${t.path}\nTitle${i + 1}=${t.artist || ''} - ${t.title || ''}\nLength${i + 1}=${Math.round(t.duration || -1)}`).join('\n')}\nNumberOfEntries=${tracks.length}\nVersion=2\n`;
    case 'xspf':
      return `<?xml version="1.0" encoding="UTF-8"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/">\n  <title>${esc(title)}</title>\n  <trackList>\n${tracks
        .map((t) => `    <track><location>${esc(encodeURI(t.path))}</location><title>${esc(t.title || '')}</title><creator>${esc(t.artist || '')}</creator><album>${esc(t.album || '')}</album>${t.duration ? `<duration>${Math.round(t.duration * 1000)}</duration>` : ''}${t.track ? `<trackNum>${t.track}</trackNum>` : ''}</track>`)
        .join('\n')}\n  </trackList>\n</playlist>\n`;
    case 'md':
      return `| ${fields.map(label).join(' | ')} |\n|${fields.map(() => '---').join('|')}|\n${tracks.map((t) => `| ${fields.map((k) => value(t, k).replace(/\|/g, '\\|')).join(' | ')} |`).join('\n')}\n`;
    case 'html':
      return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1d1b22}h1{font-size:1.4rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #e5e2ec}th{position:sticky;top:0;background:#f6f4fa;font-weight:600}tr:hover td{background:#faf9fc}@media(prefers-color-scheme:dark){body{background:#131118;color:#ece9f3}th{background:#1c1922}td,th{border-color:#2a2631}tr:hover td{background:#1a1720}}</style><h1>${esc(title)} <small style="opacity:.6;font-weight:400">· ${tracks.length} songs</small></h1><table><thead><tr>${fields.map((k) => `<th>${esc(label(k))}</th>`).join('')}</tr></thead><tbody>${tracks.map((t) => `<tr>${fields.map((k) => `<td>${esc(value(t, k))}</td>`).join('')}</tr>`).join('')}</tbody></table><p style="opacity:.5">Exported with Master Music Manager${profile ? ` from ${esc(profile.name)}` : ''}</p>`;
    default:
      throw Object.assign(new Error('Unknown format'), { status: 400 });
  }
}

/** Stream an archive of the given tracks into `res`. */
export async function archive(res, profile, tracks, { format = 'zip', layout = 'library', template, includeList = true, name = 'music' } = {}) {
  const f = ARCHIVE_FORMATS[format];
  if (!f) throw Object.assign(new Error('Unknown archive format'), { status: 400 });
  const lc = settings.get('library');
  const entries = tracks.map((t) => {
    let inner = t.path;
    if (layout === 'flat') inner = t.filename;
    else if (layout === 'template' && template) inner = `${render(template, t, lc, { safe: true })}.${t.ext}`;
    return { abs: lib.absPath(profile, t.path), inner, t };
  });
  // Avoid name clashes inside the archive.
  const used = new Set();
  for (const e of entries) {
    let n = e.inner;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = e.inner.replace(/(\.[^.]+)$/, ` (${i})$1`);
    used.add(n.toLowerCase());
    e.inner = n;
  }
  res.attachment(`${name.replace(/[^\w .-]+/g, '_')}.${f.ext}`);
  if (format === '7z') {
    // 7z needs to seek in its output, so it is built in a temp file first.
    const { run } = await import('../media/ffmpeg.js');
    const { PATHS } = await import('../config.js');
    const stamp = Date.now();
    const listFile = path.join(PATHS.exports, `list-${stamp}.txt`);
    const out = path.join(PATHS.exports, `export-${stamp}.7z`);
    fs.writeFileSync(listFile, entries.map((e) => e.t.path).join('\n'));
    try {
      await run('sh', ['-c', 'cd "$1" && 7z a -t7z -mx=1 -spf2 "$2" @"$3" >/dev/null', 'sh', profile.local_path, out, listFile]);
      await new Promise((resolve, reject) => res.sendFile(out, (e) => (e ? reject(e) : resolve())));
    } finally {
      fs.rmSync(listFile, { force: true });
      fs.rmSync(out, { force: true });
    }
    return;
  }
  const a = format === 'zip' ? new ZipArchive({ store: true, zlib: { level: 0 } }) : new TarArchive({ gzip: format === 'tar.gz', gzipOptions: { level: 6 } });
  a.on('warning', () => {});
  a.on('error', () => res.destroy());
  a.pipe(res);
  for (const e of entries) if (fs.existsSync(e.abs)) a.file(e.abs, { name: e.inner });
  if (includeList) a.append(list(tracks, { format: 'm3u8', title: name }).replace(/^(?!#)(.+)$/gm, (p) => entries.find((e) => e.t.path === p)?.inner || p), { name: `${name}.m3u8` });
  await a.finalize();
}
