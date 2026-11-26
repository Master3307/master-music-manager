// Paths and process-level settings. Everything a user changes later lives in the
// database (settings.js); this file only decides where that database lives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const VERSION = pkg.version;
export const REPO = 'Master3307/master-music-manager';
export const REPO_URL = `https://github.com/${REPO}`;
export const AUTHOR_URL = 'https://home.master3307.org';

// .env next to the checkout is read once, without a dependency.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv(path.join(ROOT, '.env'));

function defaultDataDir() {
  if (process.env.MMM_DATA_DIR) return path.resolve(process.env.MMM_DATA_DIR);
  if (process.getuid?.() === 0) return '/var/lib/master-music-manager';
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  return path.join(xdg, 'master-music-manager');
}

export const DATA_DIR = defaultDataDir();
export const PATHS = {
  data: DATA_DIR,
  db: path.join(DATA_DIR, 'mmm.sqlite'),
  secret: path.join(DATA_DIR, 'secret.key'),
  logs: path.join(DATA_DIR, 'logs'),
  jobs: path.join(DATA_DIR, 'logs', 'jobs'),
  inbox: path.join(DATA_DIR, 'inbox'),
  uploads: path.join(DATA_DIR, 'upload-parts'),
  restore: path.join(DATA_DIR, 'restore-points'),
  trash: path.join(DATA_DIR, 'trash'),
  covers: path.join(DATA_DIR, 'covers'),
  cache: path.join(DATA_DIR, 'cache'),
  exports: path.join(DATA_DIR, 'exports'),
};
for (const dir of Object.values(PATHS)) {
  if (!path.extname(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

export const PORT = Number(process.env.MMM_PORT || process.env.PORT || 4545);
export const HOST = process.env.MMM_HOST || '0.0.0.0';
export const DEV = process.env.NODE_ENV === 'development';
// Set when the app sits behind a reverse proxy / tunnel (X-Forwarded-* headers).
export const TRUST_PROXY = process.env.MMM_TRUST_PROXY ?? 'loopback, linklocal, uniquelocal';
