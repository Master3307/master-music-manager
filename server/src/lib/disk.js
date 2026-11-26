// Being kind to spinning disks. A hard disk hates jumping around: reading
// many files at once makes the head seek back and forth (the grinding noise),
// so on an HDD we read one file at a time, in the order the files lie on the
// disk (inode order is a good guess on ext4/xfs), and step back while music
// is playing.
import fs from 'node:fs';
import path from 'node:path';
import * as settings from '../settings.js';

const cache = new Map();

/** 'hdd' | 'ssd' | 'unknown' for the disk a folder is on (Linux). */
export function diskKind(folder) {
  if (cache.has(folder)) return cache.get(folder);
  let kind = 'unknown';
  try {
    const dev = fs.statSync(folder).dev;
    const major = Math.floor(dev / 256) & 0xfff;
    const minor = (dev & 0xff) | ((dev >> 12) & 0xfff00);
    let sys = fs.realpathSync(`/sys/dev/block/${major}:${minor}`);
    // A partition: the "rotational" flag lives on the whole disk.
    for (let i = 0; i < 4 && !fs.existsSync(path.join(sys, 'queue/rotational')); i++) sys = path.dirname(sys);
    const rot = fs.readFileSync(path.join(sys, 'queue/rotational'), 'utf8').trim();
    kind = rot === '1' ? 'hdd' : 'ssd';
  } catch {
    kind = fromMounts(folder);
  }
  cache.set(folder, kind);
  return kind;
}

// btrfs, ZFS and some containers don't give a real device number: find the
// mount's source device instead (/proc/self/mountinfo) and ask the kernel about it.
function fromMounts(folder) {
  try {
    const real = fs.realpathSync(folder);
    let best = null;
    for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const parts = line.split(' ');
      const mp = parts[4]?.replace(/\\040/g, ' ');
      const src = parts[parts.indexOf('-') + 2];
      if (!mp || !src?.startsWith('/dev/')) continue;
      if ((real === mp || real.startsWith(mp.endsWith('/') ? mp : `${mp}/`)) && (!best || mp.length > best.mp.length)) best = { mp, src };
    }
    if (!best) return 'unknown';
    let sys = fs.realpathSync(`/sys/class/block/${path.basename(fs.realpathSync(best.src))}`);
    for (let i = 0; i < 4 && !fs.existsSync(path.join(sys, 'queue/rotational')); i++) sys = path.dirname(sys);
    return fs.readFileSync(path.join(sys, 'queue/rotational'), 'utf8').trim() === '1' ? 'hdd' : 'ssd';
  } catch {
    return 'unknown';
  }
}

/** How to read files in this folder. Unknown disks are treated gently. */
export function readPlan(folder) {
  const mode = settings.get('library').diskMode || 'auto';
  const detected = diskKind(folder);
  const gentle = mode === 'hdd' || (mode === 'auto' && detected !== 'ssd');
  return { gentle, detected, forced: mode === 'hdd', workers: gentle ? 1 : 6, pauseMs: gentle ? 2 : 0 };
}

// Streams currently playing: reading for the library waits for them.
let playing = 0;
export const streamStarted = () => {
  playing++;
  return () => {
    playing = Math.max(0, playing - 1);
  };
};

/** Wait a little between files; much longer while someone is listening. */
export function breathe(plan) {
  const ms = playing > 0 ? (plan.gentle ? 60 : 5) : plan.pauseMs;
  return ms ? new Promise((r) => setTimeout(r, ms)) : null;
}

/** Sort paths by inode so a spinning disk reads them front to back. */
export async function inDiskOrder(files) {
  const withIno = await Promise.all(
    files.map(async (f) => {
      try {
        return [f, (await fs.promises.stat(f)).ino];
      } catch {
        return [f, Number.MAX_SAFE_INTEGER];
      }
    }),
  );
  return withIno.sort((a, b) => a[1] - b[1]).map(([f]) => f);
}
