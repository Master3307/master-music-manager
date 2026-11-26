// One app log (rotated at 5 MB) plus one file per job, so every operation that
// prints anything can be shown in the UI's "Details" view.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';

const APP_LOG = path.join(PATHS.logs, 'mmm.log');
const MAX = 5 * 1024 * 1024;
const recent = [];
const listeners = new Set();

function rotate() {
  try {
    if (fs.statSync(APP_LOG).size > MAX) fs.renameSync(APP_LOG, `${APP_LOG}.1`);
  } catch {}
}

function write(level, args) {
  const msg = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const entry = { t: Date.now(), level, msg };
  const line = `${new Date(entry.t).toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}\n`;
  (level === 'error' ? process.stderr : process.stdout).write(line);
  try {
    rotate();
    fs.appendFileSync(APP_LOG, line);
  } catch {}
  recent.push(entry);
  if (recent.length > 1000) recent.shift();
  for (const fn of listeners) fn(entry);
}

export const log = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  debug: (...a) => process.env.MMM_DEBUG && write('debug', a),
  recent: () => recent.slice(),
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  file: APP_LOG,
};
