// Everything that needs FFmpeg: probing, converting, cover extraction,
// animated covers from videos, waveforms and the audio editor.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PATHS } from '../config.js';
import { sha256 } from '../lib/crypto.js';

export function run(cmd, args, { input, onData, signal, maxBuffer = 64 * 1024 * 1024, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    const kill = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (b) => {
      size += b.length;
      if (size <= maxBuffer) out.push(b);
    });
    child.stderr.on('data', (b) => {
      err += b.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
      onData?.(b.toString());
    });
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed`) : e));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      const stdout = binary ? Buffer.concat(out) : Buffer.concat(out).toString();
      if (code === 0) resolve({ stdout, stderr: err });
      else reject(Object.assign(new Error(`${cmd} failed (${code}): ${err.trim().split('\n').slice(-4).join(' | ')}`), { stderr: err }));
    });
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const streams = j.streams || [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const pics = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic);
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic && !['mjpeg', 'png', 'bmp', 'gif'].includes(s.codec_name));
  return {
    duration: Number(j.format?.duration) || null,
    format: j.format?.format_name,
    bitrate: j.format?.bit_rate ? Math.round(j.format.bit_rate / 1000) : null,
    tags: j.format?.tags || {},
    audio: audio && {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
      bitrate: audio.bit_rate ? Math.round(audio.bit_rate / 1000) : null,
      bits: audio.bits_per_raw_sample ? Number(audio.bits_per_raw_sample) : null,
    },
    video: video && { codec: video.codec_name, width: video.width, height: video.height, fps: video.avg_frame_rate },
    hasCover: pics.length > 0,
  };
}

export const LOSSLESS = new Set(['flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_s24be', 'wavpack', 'ape', 'tta', 'mlp', 'truehd']);

export const FORMATS = {
  mp3: { ext: 'mp3', label: 'MP3', lossy: true, note: 'Plays everywhere. V0 is transparent for almost everyone.' },
  flac: { ext: 'flac', label: 'FLAC', lossy: false, note: 'Lossless and tagged well. Files are about 3x bigger.' },
  opus: { ext: 'opus', label: 'Opus', lossy: true, note: 'Best quality per MB. Older car stereos may not play it.' },
  m4a: { ext: 'm4a', label: 'AAC (M4A)', lossy: true, note: 'Great on Apple devices.' },
  ogg: { ext: 'ogg', label: 'Ogg Vorbis', lossy: true, note: 'Open, but Opus is better now.' },
  wav: { ext: 'wav', label: 'WAV', lossy: false, note: 'Uncompressed. Huge and with weak tag support.' },
};

function codecArgs(format, opts = {}) {
  switch (format) {
    case 'mp3':
      return opts.mp3Mode === 'cbr' ? ['-c:a', 'libmp3lame', '-b:a', `${opts.bitrate || 320}k`] : ['-c:a', 'libmp3lame', '-q:a', String(opts.mp3Quality ?? 0)];
    case 'flac':
      return ['-c:a', 'flac', '-compression_level', '8'];
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', `${Math.min(opts.bitrate || 192, 256)}k`, '-vbr', 'on'];
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', `${Math.min(opts.bitrate || 256, 320)}k`];
    case 'ogg':
      return ['-c:a', 'libvorbis', '-q:a', '7'];
    case 'wav':
      return ['-c:a', 'pcm_s16le'];
    default:
      throw new Error(`Unknown format ${format}`);
  }
}

/**
 * Decide what to do with a file: { action: 'keep' | 'convert', format, reason }.
 * Never makes a lossy file from another lossy file of the same codec, and keeps
 * lossless sources lossless unless the settings say otherwise.
 */
export function plan(info, settings) {
  const target = settings.format;
  const codec = info.audio?.codec;
  const ext = settings.ext;
  if (!codec) return { action: 'reject', reason: 'No audio stream in this file' };
  if (target === 'original') {
    if (info.video) return { action: 'convert', format: codec === 'aac' ? 'm4a' : codec === 'opus' ? 'opus' : 'mp3', reason: 'Video files keep only their sound' };
    return { action: 'keep', reason: 'Keeping the original format (setting)' };
  }
  const lossless = LOSSLESS.has(codec);
  if (lossless && FORMATS[target]?.lossy && settings.keepLossless) return { action: codec === 'flac' && !info.video ? 'keep' : 'convert', format: 'flac', reason: 'Lossless source kept lossless (setting)' };
  const same = { mp3: 'mp3', flac: 'flac', opus: 'opus', m4a: 'aac', ogg: 'vorbis' }[target] === codec;
  if (same && !info.video && (!ext || ext === FORMATS[target].ext || (target === 'm4a' && ext === 'mp4'))) return { action: 'keep', reason: `Already ${FORMATS[target].label}` };
  if (same && target !== 'flac') return { action: 'remux', format: target, reason: `Already ${FORMATS[target].label}; only the container changes` };
  return { action: 'convert', format: target, reason: `${codec} → ${FORMATS[target].label}` };
}

/** Convert (or remux) to `format`. Keeps tags and an embedded cover if the container allows it. */
export async function convert(input, output, format, opts = {}, ctx) {
  const info = opts.info || (await probe(input));
  const args = ['-y', '-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0', '-map_metadata', '0'];
  const canCover = ['mp3', 'flac', 'm4a'].includes(format);
  if (canCover && info.hasCover) args.push('-map', '0:v?', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  if (opts.remux) args.push('-c:a', 'copy');
  else args.push(...codecArgs(format, opts));
  if (opts.normalize) args.push('-af', 'loudnorm=I=-14:TP=-1.0:LRA=11');
  if (format === 'mp3') args.push('-id3v2_version', '4', '-write_id3v1', '0');
  if (format === 'm4a') args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:2', '-stats_period', '0.5', output);
  const total = info.duration || 0;
  if (ctx) {
    await ctx.run('ffmpeg', args, {
      quiet: true,
      onData: (s) => {
        const m = s.match(/out_time_us=(\d+)/g);
        if (m && total) opts.onProgress?.(Math.min(1, Number(m.at(-1).split('=')[1]) / 1e6 / total));
        const err = s.split('\n').filter((l) => l && !/^(\w+=|progress=)/.test(l));
        if (err.length) ctx.log(err.join('\n'));
      },
    });
  } else await run('ffmpeg', args);
  return output;
}

/** First good frame of a video (or the embedded picture) as a JPEG buffer. */
export async function stillFrame(input, { at, size = 1200 } = {}) {
  const info = await probe(input).catch(() => ({}));
  const args = ['-v', 'error'];
  if (info.video) {
    const t = at ?? Math.min(5, (info.duration || 10) * 0.15);
    args.push('-ss', String(t), '-i', input, '-map', '0:v:0', '-frames:v', '1');
  } else args.push('-i', input, '-map', '0:v:0', '-frames:v', '1');
  args.push('-vf', `scale='min(${size},iw)':-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '2', 'pipe:1');
  const { stdout } = await run('ffmpeg', args, { binary: true });
  return stdout.length ? stdout : null;
}

/**
 * Animated cover from a music video, the way Spotify / Apple Music do it:
 * a short, silent, seamless square loop. We write an H.264 MP4 (small, smooth)
 * and an animated WebP (works as a plain <img>).
 */
export async function animatedCover(input, outDir, { seconds = 8, size = 720, start, ctx } = {}) {
  const info = await probe(input);
  if (!info.video) return null;
  const dur = info.duration || seconds;
  const from = start ?? Math.max(0, Math.min(dur * 0.3, dur - seconds - 1));
  const len = Math.min(seconds, Math.max(2, dur - from));
  fs.mkdirSync(outDir, { recursive: true });
  const crop = `crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size}:flags=lanczos`;
  // A crossfade between the clip's end and its start hides the jump when it loops.
  const fade = Math.min(0.8, len / 6);
  const filter = `[0:v]trim=${from}:${from + len},setpts=PTS-STARTPTS,${crop},fps=30,split[a][b];[b]trim=0:${fade},setpts=PTS-STARTPTS[head];[a]trim=${fade},setpts=PTS-STARTPTS[body];[body][head]xfade=transition=fade:duration=${fade}:offset=${(len - 2 * fade).toFixed(3)},format=yuv420p[v]`;
  const mp4 = path.join(outDir, 'canvas.mp4');
  const webp = path.join(outDir, 'canvas.webp');
  const go = ctx ? (a) => ctx.run('ffmpeg', a, { quiet: true }) : (a) => run('ffmpeg', a);
  try {
    await go(['-y', '-v', 'error', '-i', input, '-filter_complex', filter, '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  } catch {
    // Older FFmpeg without xfade: a plain loop.
    await go(['-y', '-v', 'error', '-ss', String(from), '-t', String(len), '-i', input, '-vf', `${crop},fps=30,format=yuv420p`, '-an', '-c:v', 'libx264', '-crf', '23', '-movflags', '+faststart', mp4]);
  }
  await go(['-y', '-v', 'error', '-i', mp4, '-vf', 'fps=15,scale=480:480:flags=lanczos', '-loop', '0', '-c:v', 'libwebp', '-quality', '70', '-compression_level', '5', webp]).catch(() => null);
  return { mp4, webp: fs.existsSync(webp) ? webp : null, from, length: len };
}

/** Peaks for drawing a waveform: [min, max] pairs in -1..1. Cached. */
export async function waveform(file, buckets = 1200) {
  const st = fs.statSync(file);
  const key = sha256(`${file}:${st.size}:${st.mtimeMs}:${buckets}`);
  const cacheFile = path.join(PATHS.cache, `wave-${key}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1'], { binary: true, maxBuffer: 256 * 1024 * 1024 });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const per = Math.max(1, Math.floor(samples.length / buckets));
  const peaks = [];
  for (let i = 0; i < samples.length; i += per) {
    let lo = 0;
    let hi = 0;
    for (let j = i; j < Math.min(i + per, samples.length); j++) {
      const v = samples[j] / 32768;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    peaks.push([Number(lo.toFixed(3)), Number(hi.toFixed(3))]);
  }
  const out = { duration: samples.length / 4000, peaks };
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

// ---- Audio editor ----
// Each operation becomes part of one filter graph; the editor previews the
// exact same graph it later applies.
export const EDIT_OPS = {
  trim: { label: 'Trim', params: { start: 0, end: null } },
  cut: { label: 'Cut out a part', params: { start: 0, end: 1 } },
  fadeIn: { label: 'Fade in', params: { duration: 2, curve: 'tri' } },
  fadeOut: { label: 'Fade out', params: { duration: 3, curve: 'tri' } },
  volume: { label: 'Volume', params: { db: 0 } },
  normalize: { label: 'Normalize loudness', params: { lufs: -14, peak: -1 } },
  speed: { label: 'Speed (keep pitch)', params: { factor: 1 } },
  pitch: { label: 'Pitch (keep speed)', params: { semitones: 0 } },
  rate: { label: 'Speed + pitch (tape)', params: { factor: 1 } },
  nightcore: { label: 'Nightcore', params: { factor: 1.25 } },
  slowed: { label: 'Slowed + reverb', params: { factor: 0.85, reverb: 0.4 } },
  bass: { label: 'Bass', params: { gain: 0, frequency: 100 } },
  treble: { label: 'Treble', params: { gain: 0, frequency: 3000 } },
  eq: { label: 'Equalizer', params: { bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
  compressor: { label: 'Compressor', params: { threshold: -18, ratio: 3 } },
  limiter: { label: 'Limiter', params: { limit: -1 } },
  denoise: { label: 'Reduce noise', params: { amount: 12 } },
  echo: { label: 'Echo', params: { delay: 250, decay: 0.35 } },
  reverb: { label: 'Reverb', params: { amount: 0.4 } },
  silence: { label: 'Remove silence at start/end', params: { threshold: -50 } },
  pad: { label: 'Add silence', params: { start: 0, end: 0 } },
  reverse: { label: 'Reverse', params: {} },
  mono: { label: 'Make mono', params: {} },
  swap: { label: 'Swap left / right', params: {} },
  balance: { label: 'Balance', params: { pan: 0 } },
  widen: { label: 'Stereo width', params: { amount: 1.5 } },
  karaoke: { label: 'Remove vocals (karaoke)', params: {} },
  bitcrush: { label: 'Lo-fi', params: { bits: 8 } },
  resample: { label: 'Sample rate', params: { rate: 44100 } },
};

const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const num = (v, d, lo = -Infinity, hi = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
function tempo(factor) {
  const parts = [];
  let f = factor;
  while (f > 2) {
    parts.push('atempo=2');
    f /= 2;
  }
  while (f < 0.5) {
    parts.push('atempo=0.5');
    f /= 0.5;
  }
  parts.push(`atempo=${f.toFixed(5)}`);
  return parts;
}

/** Build an -af chain from the operation list, knowing the duration for fades at the end. */
export function filterChain(ops, duration, sampleRate = 44100) {
  const f = [];
  let dur = duration || 0;
  for (const op of ops || []) {
    const p = op.params || {};
    switch (op.type) {
      case 'trim': {
        const s = num(p.start, 0, 0);
        const e = p.end == null || p.end === '' ? null : num(p.end, null, s);
        f.push(`atrim=start=${s}${e != null ? `:end=${e}` : ''}`, 'asetpts=N/SR/TB');
        dur = (e ?? dur) - s;
        break;
      }
      case 'cut': {
        const s = num(p.start, 0, 0);
        const e = num(p.end, s, s);
        f.push(`aselect='not(between(t,${s},${e}))'`, 'asetpts=N/SR/TB');
        dur -= e - s;
        break;
      }
      case 'fadeIn':
        f.push(`afade=t=in:st=0:d=${num(p.duration, 2, 0.05, 60)}:curve=${['tri', 'qsin', 'exp', 'log', 'esin'].includes(p.curve) ? p.curve : 'tri'}`);
        break;
      case 'fadeOut': {
        const d = num(p.duration, 3, 0.05, 60);
        f.push(`afade=t=out:st=${Math.max(0, dur - d).toFixed(3)}:d=${d}:curve=${['tri', 'qsin', 'exp', 'log', 'esin'].includes(p.curve) ? p.curve : 'tri'}`);
        break;
      }
      case 'volume':
        f.push(`volume=${num(p.db, 0, -60, 30)}dB`);
        break;
      case 'normalize':
        f.push(`loudnorm=I=${num(p.lufs, -14, -40, -5)}:TP=${num(p.peak, -1, -9, 0)}:LRA=11`);
        break;
      case 'speed': {
        const k = num(p.factor, 1, 0.25, 4);
        f.push(...tempo(k));
        dur /= k;
        break;
      }
      case 'pitch': {
        const k = 2 ** (num(p.semitones, 0, -24, 24) / 12);
        f.push(`asetrate=${Math.round(sampleRate * k)}`, `aresample=${sampleRate}`, ...tempo(1 / k));
        break;
      }
      case 'rate':
      case 'nightcore': {
        const k = num(p.factor, op.type === 'nightcore' ? 1.25 : 1, 0.25, 4);
        f.push(`asetrate=${Math.round(sampleRate * k)}`, `aresample=${sampleRate}`);
        dur /= k;
        break;
      }
      case 'slowed': {
        const k = num(p.factor, 0.85, 0.5, 1);
        const r = num(p.reverb, 0.4, 0, 1);
        f.push(`asetrate=${Math.round(sampleRate * k)}`, `aresample=${sampleRate}`);
        if (r > 0) f.push(`aecho=0.8:${(0.6 + r * 0.3).toFixed(2)}:60|120|180:${(r * 0.5).toFixed(2)}|${(r * 0.35).toFixed(2)}|${(r * 0.2).toFixed(2)}`);
        dur /= k;
        break;
      }
      case 'bass':
        f.push(`bass=g=${num(p.gain, 0, -20, 20)}:f=${num(p.frequency, 100, 20, 500)}`);
        break;
      case 'treble':
        f.push(`treble=g=${num(p.gain, 0, -20, 20)}:f=${num(p.frequency, 3000, 1000, 16000)}`);
        break;
      case 'eq':
        (p.bands || []).forEach((g, i) => {
          const gain = num(g, 0, -20, 20);
          if (gain && EQ_FREQS[i]) f.push(`equalizer=f=${EQ_FREQS[i]}:t=o:w=1:g=${gain}`);
        });
        break;
      case 'compressor':
        f.push(`acompressor=threshold=${num(p.threshold, -18, -60, 0)}dB:ratio=${num(p.ratio, 3, 1, 20)}:attack=20:release=250`);
        break;
      case 'limiter':
        f.push(`alimiter=limit=${(10 ** (num(p.limit, -1, -20, 0) / 20)).toFixed(4)}`);
        break;
      case 'denoise':
        f.push(`afftdn=nr=${num(p.amount, 12, 1, 97)}`);
        break;
      case 'echo':
        f.push(`aecho=0.8:0.88:${num(p.delay, 250, 1, 5000)}:${num(p.decay, 0.35, 0, 1)}`);
        break;
      case 'reverb': {
        const r = num(p.amount, 0.4, 0, 1);
        f.push(`aecho=0.8:${(0.6 + r * 0.3).toFixed(2)}:40|80|130|190:${(r * 0.5).toFixed(2)}|${(r * 0.4).toFixed(2)}|${(r * 0.3).toFixed(2)}|${(r * 0.2).toFixed(2)}`);
        break;
      }
      case 'silence': {
        const t = num(p.threshold, -50, -90, -10);
        f.push(`silenceremove=start_periods=1:start_threshold=${t}dB`, 'areverse', `silenceremove=start_periods=1:start_threshold=${t}dB`, 'areverse');
        break;
      }
      case 'pad': {
        const s = num(p.start, 0, 0, 600);
        const e = num(p.end, 0, 0, 600);
        if (s) f.push(`adelay=${Math.round(s * 1000)}:all=1`);
        if (e) f.push(`apad=pad_dur=${e}`);
        dur += s + e;
        break;
      }
      case 'reverse':
        f.push('areverse');
        break;
      case 'mono':
        f.push('pan=mono|c0=0.5*c0+0.5*c1');
        break;
      case 'swap':
        f.push('pan=stereo|c0=c1|c1=c0');
        break;
      case 'balance':
        f.push(`stereotools=balance_out=${num(p.pan, 0, -1, 1)}`);
        break;
      case 'widen':
        f.push(`extrastereo=m=${num(p.amount, 1.5, 0, 4)}`);
        break;
      case 'karaoke':
        f.push('pan=stereo|c0=c0-c1|c1=c1-c0');
        break;
      case 'bitcrush':
        f.push(`acrusher=bits=${num(p.bits, 8, 1, 16)}:mode=log:aa=1`);
        break;
      case 'resample':
        f.push(`aresample=${num(p.rate, 44100, 8000, 192000)}`);
        break;
      default:
        break;
    }
  }
  return { filter: f.join(','), duration: dur };
}

export function encoderFor(file, info) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const br = Math.max(128, Math.min(320, info?.audio?.bitrate || info?.bitrate || 320));
  if (ext === 'mp3') return ['-c:a', 'libmp3lame', br >= 256 ? '-q:a' : '-b:a', br >= 256 ? '0' : `${br}k`, '-id3v2_version', '4'];
  if (ext === 'flac') return ['-c:a', 'flac', '-compression_level', '8'];
  if (ext === 'm4a' || ext === 'mp4' || ext === 'm4b') return ['-c:a', info?.audio?.codec === 'alac' ? 'alac' : 'aac', '-b:a', `${Math.min(br, 320)}k`];
  if (ext === 'opus') return ['-c:a', 'libopus', '-b:a', `${Math.min(br, 256)}k`];
  if (ext === 'ogg' || ext === 'oga') return ['-c:a', 'libvorbis', '-q:a', '7'];
  if (ext === 'wav') return ['-c:a', 'pcm_s16le'];
  return ['-c:a', 'flac'];
}

/** Render the edit to `output` in the same format as `input` (tags + cover kept). */
export async function renderEdit(input, output, ops, { preview = false, ctx } = {}) {
  const info = await probe(input);
  const { filter } = filterChain(ops, info.duration, info.audio?.sampleRate || 44100);
  const args = ['-y', '-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0'];
  if (!preview) args.push('-map_metadata', '0');
  const ext = path.extname(output).slice(1).toLowerCase();
  if (!preview && info.hasCover && ['mp3', 'flac', 'm4a'].includes(ext)) args.push('-map', '0:v?', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  if (filter) args.push('-af', filter);
  args.push(...(preview ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : encoderFor(output, info)));
  args.push(output);
  if (ctx) await ctx.run('ffmpeg', args, { quiet: true });
  else await run('ffmpeg', args);
  return output;
}

export async function hasBinary(bin) {
  try {
    await run('sh', ['-c', `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
}
