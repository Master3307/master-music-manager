// One tag model for every format. FIELDS drives the editor, the query
// language, exports and the writer. Writing uses music-metadata's in-place
// writer (no re-encoding, atomic rename); ffmpeg is the fallback for formats
// it can't write.
import fs from 'node:fs';
import path from 'node:path';
import { parseFile, updateFile } from 'music-metadata';
import { run } from '../media/ffmpeg.js';

// key: our name · common: music-metadata name · list: multi-value · group: editor section
export const FIELDS = [
  { key: 'title', label: 'Title', common: 'title', group: 'Main' },
  { key: 'artist', label: 'Artist', common: 'artist', group: 'Main' },
  { key: 'artists', label: 'Artists (each)', common: 'artists', list: true, group: 'Main' },
  { key: 'album', label: 'Album', common: 'album', group: 'Main' },
  { key: 'albumartist', label: 'Album artist', common: 'albumArtist', group: 'Main' },
  { key: 'genre', label: 'Genre', common: 'genres', list: true, group: 'Main' },
  { key: 'year', label: 'Year', type: 'number', group: 'Main' },
  { key: 'date', label: 'Release date', common: 'date', group: 'Main' },
  { key: 'track', label: 'Track', type: 'number', group: 'Main' },
  { key: 'tracktotal', label: 'Tracks', type: 'number', group: 'Main' },
  { key: 'disc', label: 'Disc', type: 'number', group: 'Main' },
  { key: 'disctotal', label: 'Discs', type: 'number', group: 'Main' },
  { key: 'discsubtitle', label: 'Disc subtitle', common: 'discSubtitle', group: 'Main' },
  { key: 'compilation', label: 'Compilation', common: 'compilation', type: 'bool', group: 'Main' },

  { key: 'composer', label: 'Composer', common: 'composers', list: true, group: 'People' },
  { key: 'lyricist', label: 'Lyricist', common: 'lyricists', list: true, group: 'People' },
  { key: 'writer', label: 'Writer', common: 'writers', list: true, group: 'People' },
  { key: 'conductor', label: 'Conductor', common: 'conductors', list: true, group: 'People' },
  { key: 'remixer', label: 'Remixer', common: 'remixers', list: true, group: 'People' },
  { key: 'producer', label: 'Producer', common: 'producers', list: true, group: 'People' },
  { key: 'arranger', label: 'Arranger', common: 'arrangers', list: true, group: 'People' },
  { key: 'engineer', label: 'Engineer', common: 'engineers', list: true, group: 'People' },
  { key: 'mixer', label: 'Mixer', common: 'mixers', list: true, group: 'People' },
  { key: 'djmixer', label: 'DJ mixer', common: 'djMixers', list: true, group: 'People' },
  { key: 'originalartist', label: 'Original artist', common: 'originalArtist', group: 'People' },

  { key: 'comment', label: 'Comment', common: 'comments', type: 'text', group: 'Text' },
  { key: 'lyrics', label: 'Lyrics', common: 'lyrics', type: 'text', group: 'Text' },
  { key: 'description', label: 'Description', common: 'description', type: 'text', group: 'Text' },
  { key: 'subtitle', label: 'Subtitle', common: 'subtitles', list: true, group: 'Text' },
  { key: 'language', label: 'Language', common: 'language', group: 'Text', hint: 'ISO 639-2, e.g. eng, deu, jpn' },
  { key: 'script', label: 'Script', common: 'script', group: 'Text', hint: 'ISO 15924, e.g. Latn, Jpan' },
  { key: 'notes', label: 'Notes', common: 'notes', type: 'text', group: 'Text' },

  { key: 'bpm', label: 'BPM', common: 'bpm', type: 'number', group: 'Sound' },
  { key: 'key', label: 'Key', common: 'key', group: 'Sound', hint: 'e.g. Am, F#, 8A' },
  { key: 'mood', label: 'Mood', common: 'mood', group: 'Sound' },
  { key: 'grouping', label: 'Grouping', common: 'grouping', group: 'Sound' },
  { key: 'media', label: 'Media', common: 'media', group: 'Sound', hint: 'CD, Digital Media, Vinyl…' },
  { key: 'replaygain_track_gain', label: 'ReplayGain track gain', common: 'replayGainTrackGain', group: 'Sound' },
  { key: 'replaygain_track_peak', label: 'ReplayGain track peak', common: 'replayGainTrackPeak', group: 'Sound' },
  { key: 'replaygain_album_gain', label: 'ReplayGain album gain', common: 'replayGainAlbumGain', group: 'Sound' },
  { key: 'replaygain_album_peak', label: 'ReplayGain album peak', common: 'replayGainAlbumPeak', group: 'Sound' },

  { key: 'label', label: 'Label', common: 'labels', list: true, group: 'Release' },
  { key: 'publisher', label: 'Publisher', common: 'publishers', list: true, group: 'Release' },
  { key: 'catalognumber', label: 'Catalog number', common: 'catalogNumber', group: 'Release' },
  { key: 'barcode', label: 'Barcode', common: 'barcode', group: 'Release' },
  { key: 'isrc', label: 'ISRC', common: 'isrcs', list: true, group: 'Release' },
  { key: 'asin', label: 'ASIN', common: 'asin', group: 'Release' },
  { key: 'originaldate', label: 'Original date', common: 'originalDate', group: 'Release' },
  { key: 'originalyear', label: 'Original year', common: 'originalYear', type: 'number', group: 'Release' },
  { key: 'releasetype', label: 'Release type', common: 'releaseType', list: true, group: 'Release', hint: 'album, single, ep, compilation, live…' },
  { key: 'releasestatus', label: 'Release status', common: 'releaseStatus', group: 'Release' },
  { key: 'releasecountry', label: 'Release country', common: 'releaseCountry', group: 'Release' },
  { key: 'copyright', label: 'Copyright', common: 'copyright', group: 'Release' },
  { key: 'license', label: 'License', common: 'license', group: 'Release' },
  { key: 'website', label: 'Website', common: 'website', group: 'Release' },
  { key: 'encodedby', label: 'Encoded by', common: 'encodedBy', group: 'Release' },

  { key: 'titlesort', label: 'Sort title', common: 'titleSort', group: 'Sorting' },
  { key: 'artistsort', label: 'Sort artist', common: 'artistSort', group: 'Sorting' },
  { key: 'albumsort', label: 'Sort album', common: 'albumSort', group: 'Sorting' },
  { key: 'albumartistsort', label: 'Sort album artist', common: 'albumArtistSort', group: 'Sorting' },
  { key: 'composersort', label: 'Sort composer', common: 'composerSort', group: 'Sorting' },
  { key: 'work', label: 'Work', common: 'work', group: 'Sorting' },
  { key: 'movement', label: 'Movement', common: 'movement', group: 'Sorting' },

  { key: 'musicbrainz_trackid', label: 'MusicBrainz recording', common: 'mbRecordingId', group: 'IDs' },
  { key: 'musicbrainz_releasetrackid', label: 'MusicBrainz release track', common: 'mbReleaseTrackId', group: 'IDs' },
  { key: 'musicbrainz_albumid', label: 'MusicBrainz release', common: 'mbReleaseId', group: 'IDs' },
  { key: 'musicbrainz_releasegroupid', label: 'MusicBrainz release group', common: 'mbReleaseGroupId', group: 'IDs' },
  { key: 'musicbrainz_artistid', label: 'MusicBrainz artist', common: 'mbArtistId', list: true, group: 'IDs' },
  { key: 'musicbrainz_albumartistid', label: 'MusicBrainz album artist', common: 'mbAlbumArtistId', list: true, group: 'IDs' },
  { key: 'musicbrainz_workid', label: 'MusicBrainz work', common: 'mbWorkId', group: 'IDs' },
  { key: 'acoustid_id', label: 'AcoustID', common: 'acoustId', group: 'IDs' },
  { key: 'discogs_releaseid', label: 'Discogs release', common: 'discogsReleaseId', type: 'number', group: 'IDs' },
];
export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// Columns that come from the file itself, not tags (read-only, filterable).
export const FILE_FIELDS = [
  { key: 'filename', label: 'File name' },
  { key: 'path', label: 'Path' },
  { key: 'folder', label: 'Folder' },
  { key: 'ext', label: 'Extension' },
  { key: 'duration', label: 'Length', type: 'duration' },
  { key: 'bitrate', label: 'Bitrate', type: 'number', unit: 'kbps' },
  { key: 'samplerate', label: 'Sample rate', type: 'number', unit: 'Hz' },
  { key: 'bits', label: 'Bit depth', type: 'number' },
  { key: 'channels', label: 'Channels', type: 'number' },
  { key: 'codec', label: 'Codec' },
  { key: 'container', label: 'Container' },
  { key: 'lossless', label: 'Lossless', type: 'bool' },
  { key: 'size', label: 'Size', type: 'size' },
  { key: 'cover', label: 'Has cover', type: 'bool' },
  { key: 'haslyrics', label: 'Has lyrics', type: 'bool' },
  { key: 'added', label: 'Added', type: 'date' },
  { key: 'modified', label: 'Modified', type: 'date' },
  { key: 'hash', label: 'File hash' },
  { key: 'nosplit', label: 'Keep artists together', type: 'bool' },
  { key: 'online', label: 'On the service', type: 'bool' },
];

const toList = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v.map(String) : String(v).split(/\s*;\s*/).filter(Boolean));
const first = (v) => (Array.isArray(v) ? v[0] : v);

function commentText(c) {
  if (!c) return undefined;
  const list = Array.isArray(c) ? c : [c];
  const texts = list.map((x) => (typeof x === 'string' ? x : x.text)).filter(Boolean);
  return texts.length ? texts.join('\n') : undefined;
}

/** Native custom tags (TXXX, Vorbis comments, iTunes freeform) not covered by FIELDS. */
const KNOWN_NATIVE = /^(TIT2|TPE1|TPE2|TALB|TCON|TRCK|TPOS|TYER|TDRC|TDOR|TCOM|COMM|USLT|SYLT|APIC|TBPM|TKEY|TSRC|TCOP|TPUB|TENC|TSSE|TLAN|TMOO|TIT1|TIT3|TSOT|TSOP|TSOA|TSO2|TSOC|TCMP|TXXX:(Artists|ALBUMARTISTS|CATALOGNUMBER|BARCODE|ASIN|SCRIPT|MusicBrainz.*|Acoustid.*|replaygain.*|Writer|originalyear|RELEASETYPE)|PRIV.*|MCDI|TLEN|TFLT|TMED|TOPE|POPM|PCNT|WXXX.*|TDTG|TDRL|GEOB.*|UFID.*|TIPL|TMCL|TOAL|TOWN|TPE3|TPE4|TEXT)$/i;
const VORBIS_KNOWN = new Set(
  'TITLE ARTIST ARTISTS ALBUM ALBUMARTIST ALBUM_ARTIST GENRE DATE YEAR TRACKNUMBER TRACKTOTAL TOTALTRACKS DISCNUMBER DISCTOTAL TOTALDISCS COMMENT DESCRIPTION LYRICS UNSYNCEDLYRICS COMPOSER LYRICIST WRITER CONDUCTOR REMIXER PRODUCER ARRANGER ENGINEER MIXER DJMIXER LABEL PUBLISHER ORGANIZATION CATALOGNUMBER BARCODE ISRC ASIN ORIGINALDATE ORIGINALYEAR RELEASETYPE RELEASESTATUS RELEASECOUNTRY COPYRIGHT LICENSE WEBSITE ENCODEDBY ENCODER TITLESORT ARTISTSORT ALBUMSORT ALBUMARTISTSORT COMPOSERSORT BPM KEY MOOD GROUPING MEDIA LANGUAGE SCRIPT SUBTITLE DISCSUBTITLE COMPILATION WORK MOVEMENTNAME METADATA_BLOCK_PICTURE COVERART VENDOR REPLAYGAIN_TRACK_GAIN REPLAYGAIN_TRACK_PEAK REPLAYGAIN_ALBUM_GAIN REPLAYGAIN_ALBUM_PEAK RATING'.split(' '),
);

function customTags(native) {
  const out = {};
  for (const [type, list] of Object.entries(native || {})) {
    for (const { id, value } of list) {
      if (typeof value === 'object' && value !== null && !(typeof value.text === 'string')) continue;
      const text = typeof value === 'string' ? value : value?.text;
      if (text == null) continue;
      let name = null;
      if (type.startsWith('ID3v2')) {
        if (KNOWN_NATIVE.test(id)) continue;
        name = id.startsWith('TXXX:') ? id.slice(5) : id;
      } else if (type === 'vorbis') {
        if (VORBIS_KNOWN.has(id.toUpperCase()) || id.toUpperCase().startsWith('MUSICBRAINZ_') || id.toUpperCase().startsWith('ACOUSTID')) continue;
        name = id;
      } else if (type === 'iTunes') {
        if (!id.startsWith('----:')) continue;
        name = id.split(':').pop();
        if (/^(MusicBrainz|Acoustid|iTunNORM|iTunSMPB|replaygain|ARTISTS|BARCODE|CATALOGNUMBER|ASIN|LABEL|SCRIPT|MEDIA|ISRC|LANGUAGE)/i.test(name)) continue;
      } else if (type === 'APEv2' || type === 'asf') {
        name = id;
        if (/^(Title|Artist|Album|Year|Track|Genre|Comment|Cover Art|WM\/(AlbumTitle|AlbumArtist|Genre|Year|TrackNumber|PartOfSet|Picture|Composer|Lyrics|Publisher))/i.test(id)) continue;
      } else continue;
      out[name] = out[name] ? `${out[name]}; ${text}` : String(text);
    }
  }
  return out;
}

/** Read a file into { info, tags, custom, lyrics[], comments[], pictures[] }. */
export async function read(file, { covers = false } = {}) {
  const mm = await parseFile(file, { duration: false, skipCovers: !covers, includeChapters: false });
  const c = mm.common;
  const f = mm.format;
  const tags = {};
  for (const fd of FIELDS) {
    let v;
    switch (fd.key) {
      case 'year':
        v = c.year;
        break;
      case 'track':
        v = c.trackNumber ?? c.track?.no; // music-metadata 13 names them flat
        break;
      case 'tracktotal':
        v = c.trackTotal ?? c.track?.of;
        break;
      case 'disc':
        v = c.discNumber ?? c.disk?.no;
        break;
      case 'disctotal':
        v = c.discTotal ?? c.disk?.of;
        break;
      case 'comment':
        v = commentText(c.comment);
        break;
      case 'lyrics':
        // Unsynced text first; a synced-only file still shows its words.
        v = c.lyrics?.find((l) => l.text)?.text || c.lyrics?.find((l) => l.syncText?.length)?.syncText.map((s) => s.text).join('\n') || undefined;
        break;
      case 'replaygain_track_gain':
      case 'replaygain_album_gain':
        v = c[fd.common]?.dB != null ? `${c[fd.common].dB.toFixed(2)} dB` : undefined;
        break;
      case 'replaygain_track_peak':
      case 'replaygain_album_peak':
        v = c[fd.common]?.ratio != null ? c[fd.common].ratio.toFixed(6) : undefined;
        break;
      default:
        v = c[fd.common];
    }
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (fd.list) tags[fd.key] = toList(v);
    else tags[fd.key] = typeof v === 'object' && !Array.isArray(v) ? String(v.text ?? JSON.stringify(v)) : Array.isArray(v) ? v.join('; ') : v;
  }
  return {
    tags,
    custom: customTags(mm.native),
    lyrics: (c.lyrics || []).map((l) => ({ language: l.language, descriptor: l.descriptor, text: l.text || '', synced: Boolean(l.syncText?.length), syncText: l.syncText })),
    comments: (Array.isArray(c.comment) ? c.comment : c.comment ? [c.comment] : []).map((x) => (typeof x === 'string' ? { text: x } : x)),
    pictures: covers ? (c.picture || []).map((p) => ({ format: p.format, type: p.type, description: p.description, size: p.data?.length, data: p.data })) : [],
    hasCover: covers ? Boolean(c.picture?.length) : null,
    info: {
      duration: f.duration ?? null,
      bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : null,
      sampleRate: f.sampleRate ?? null,
      channels: f.numberOfChannels ?? null,
      bits: f.bitsPerSample ?? null,
      codec: f.codec ?? null,
      container: f.container ?? null,
      lossless: Boolean(f.lossless),
      tagTypes: f.tagTypes || [],
    },
  };
}

export async function readCover(file) {
  const mm = await parseFile(file, { duration: false, skipCovers: false });
  const pics = mm.common.picture || [];
  const front = pics.find((p) => /front/i.test(p.type || '')) || pics[0];
  return front ? { data: Buffer.from(front.data), format: front.format || 'image/jpeg' } : null;
}

function nativeKey(fmt, name) {
  if (fmt === 'mp3' || fmt === 'aac' || fmt === 'wav') return `TXXX:${name}`;
  if (fmt === 'mp4') return `----:com.apple.iTunes:${name}`;
  return name;
}

function formatOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return { mp3: 'mp3', aac: 'aac', wav: 'wav', flac: 'flac', ogg: 'ogg', oga: 'ogg', opus: 'ogg', m4a: 'mp4', m4b: 'mp4', mp4: 'mp4', alac: 'mp4', ape: 'ape', wv: 'wv', mpc: 'mpc', wma: 'asf' }[ext] || ext;
}

/**
 * Turn an edit ({ field: value | null }, custom: { NAME: value | null },
 * lyrics: [{language, descriptor, text}], comments: [...], cover) into a patch.
 */
export function buildPatch(file, edit) {
  const fmt = formatOf(file);
  const patch = {};
  const t = edit.tags || {};
  const pairs = { track: 'trackNumber', tracktotal: 'trackTotal', disc: 'discNumber', disctotal: 'discTotal' };
  for (const [key, raw] of Object.entries(t)) {
    const fd = FIELD[key];
    if (!fd) continue;
    const empty = raw == null || raw === '' || (Array.isArray(raw) && !raw.length);
    if (pairs[key]) {
      patch[pairs[key]] = empty ? null : Number.parseInt(raw, 10) || null;
      continue;
    }
    if (key === 'year') {
      if (!t.date) patch.date = empty ? null : String(raw);
      continue;
    }
    if (key === 'comment') {
      patch.comments = empty ? null : [{ language: edit.commentLanguage || 'eng', descriptor: '', text: String(raw) }];
      continue;
    }
    if (key === 'lyrics') {
      if (!edit.lyrics) patch.lyrics = empty ? null : [{ text: String(raw), language: edit.lyricsLanguage || 'eng', descriptor: '' }];
      continue;
    }
    if (key === 'compilation') {
      patch.compilation = empty ? null : raw === true || raw === 'true' || raw === '1' || raw === 1;
      continue;
    }
    if (fd.type === 'number' && !fd.list) {
      patch[fd.common] = empty ? null : Number(raw);
      continue;
    }
    if (fd.key.startsWith('replaygain')) {
      patch[fd.common] = empty ? null : String(raw);
      continue;
    }
    patch[fd.common] = empty ? null : fd.list ? toList(raw) : String(raw);
  }
  if (edit.lyrics) patch.lyrics = edit.lyrics.length ? edit.lyrics.map((l) => ({ text: l.text, language: l.language || 'eng', descriptor: l.descriptor || '', ...(l.syncText ? { syncText: l.syncText, timeStampFormat: 2 } : {}) })) : null;
  if (edit.comments) patch.comments = edit.comments.length ? edit.comments.map((c) => ({ language: c.language || 'eng', descriptor: c.descriptor || '', text: c.text })) : null;
  if (edit.custom && Object.keys(edit.custom).length) {
    patch.native = {};
    for (const [name, value] of Object.entries(edit.custom)) {
      if (!/^[\w .:/-]{1,64}$/.test(name)) continue;
      patch.native[nativeKey(fmt, fmt === 'flac' || fmt === 'ogg' ? name.toUpperCase() : name)] = value == null || value === '' ? null : String(value);
    }
  }
  if (edit.cover !== undefined) {
    patch.picture = edit.cover ? [{ format: edit.cover.format || 'image/jpeg', type: 'Cover (front)', description: '', data: new Uint8Array(edit.cover.data) }] : null;
  }
  return patch;
}

/** Write tags in place. Returns the method used. */
export async function write(file, edit) {
  const patch = buildPatch(file, edit);
  if (!Object.keys(patch).length) return { method: 'none' };
  try {
    // Never replaceId3: it drops every frame not in the patch (cover, album,
    // genre…). Older ID3v2.3 files are refused here and go through FFmpeg,
    // which keeps all their tags and the cover and writes v2.4.
    await updateFile(file, patch, { atomic: true });
    return { method: 'native' };
  } catch (e) {
    if (!/Unsupported|not supported|Only iTunes/i.test(e.message || '') && e.name !== 'UnsupportedFormatError' && e.name !== 'UnsupportedFeatureError') throw e;
    await writeWithFfmpeg(file, edit);
    return { method: 'ffmpeg', reason: e.message };
  }
}

async function writeWithFfmpeg(file, edit) {
  const tmp = `${file}.mmm-tmp${path.extname(file)}`;
  const args = ['-y', '-v', 'error', '-i', file];
  let coverFile = null;
  if (edit.cover?.data) {
    coverFile = `${file}.mmm-cover.${edit.cover.format?.includes('png') ? 'png' : 'jpg'}`;
    fs.writeFileSync(coverFile, Buffer.from(edit.cover.data));
    args.push('-i', coverFile, '-map', '0:a', '-map', '1', '-disposition:v', 'attached_pic');
  } else args.push('-map', '0');
  args.push('-c', 'copy', '-map_metadata', '0');
  for (const [k, v] of Object.entries(edit.tags || {})) args.push('-metadata', `${k}=${v == null ? '' : Array.isArray(v) ? v.join('; ') : v}`);
  for (const [k, v] of Object.entries(edit.custom || {})) args.push('-metadata', `${k}=${v ?? ''}`);
  if (edit.lyrics?.[0]) args.push('-metadata', `lyrics-${edit.lyrics[0].language || 'eng'}=${edit.lyrics[0].text}`);
  args.push(tmp);
  try {
    await run('ffmpeg', args);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
    if (coverFile) fs.rmSync(coverFile, { force: true });
  }
}
