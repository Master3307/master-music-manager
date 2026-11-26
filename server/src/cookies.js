// YouTube cookies for yt-dlp and spotDL (age-restricted songs, fewer "confirm
// you're not a bot" blocks, YouTube Music Premium quality).
//
// Cookies are a login, so:
// - only YouTube and Google cookies are kept from the uploaded file (browser
//   exports often hold every site's cookies);
// - they are stored sealed (AES-GCM with the app's internal key), never sent
//   back to a browser;
// - they stay saved (sealed) until removed. yt-dlp needs a plain file, so each
//   run gets a temporary copy, readable only by us in a private folder, that
//   is removed when the run ends. Cookies yt-dlp renews during the run are
//   sealed again over the saved ones, so the login lasts longer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import express from 'express';
import { PATHS } from './config.js';
import { seal, unseal } from './lib/crypto.js';
import { requireAdmin } from './auth.js';
import { httpError, json } from './lib/http.js';
import { audit, now } from './db.js';
import * as settings from './settings.js';

const FILE = path.join(PATHS.data, 'youtube-cookies.json');
const KEEP = /(^|\.)(youtube\.com|google\.com|youtube-nocookie\.com)$/i;
// The cookies that carry the login; the earliest of them to expire is when you'd need new ones.
const LOGIN = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO']);

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}
function write(v) {
  fs.writeFileSync(FILE, JSON.stringify(v), { mode: 0o600 });
}

/** Netscape cookies.txt → only the lines for YouTube / Google, plus facts about them. */
export function parse(text) {
  const kept = [];
  const names = new Set();
  let expires = null;
  let total = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    total++;
    const domain = f[0].replace(/^#HttpOnly_/, '');
    if (!KEEP.test(domain)) continue;
    kept.push(line);
    names.add(f[5]);
    const exp = Number(f[4]);
    if (LOGIN.has(f[5]) && exp > 0 && (!expires || exp * 1000 < expires)) expires = exp * 1000;
  }
  return { text: `# Netscape HTTP Cookie File\n${kept.join('\n')}\n`, count: kept.length, dropped: total - kept.length, loggedIn: [...LOGIN].some((n) => names.has(n)), expires };
}

export function status() {
  const s = read();
  const legacy = settings.get('downloads').cookies;
  if (!s) return { present: false, legacyPath: legacy && fs.existsSync(legacy) ? legacy : null };
  return { present: true, count: s.count, loggedIn: s.loggedIn, expires: s.expires, uploadedAt: s.uploadedAt, refreshedAt: s.refreshedAt || null, check: s.check || null };
}

/**
 * A cookies file for one run: { file, close() }. file is null when there are
 * none. close() keeps cookies yt-dlp refreshed and removes the file.
 */
export function open() {
  const s = read();
  if (!s) {
    const legacy = settings.get('downloads').cookies;
    return { file: legacy && fs.existsSync(legacy) ? legacy : null, close: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cookies-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'cookies.txt');
  const text = unseal(s.sealed);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return {
    file,
    close: () => {
      try {
        const after = fs.readFileSync(file, 'utf8');
        if (after !== text) {
          const p = parse(after);
          if (p.count && p.loggedIn) write({ ...read(), sealed: seal(p.text), count: p.count, loggedIn: p.loggedIn, expires: p.expires, refreshedAt: now() });
        }
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Do they still log in? Your YouTube history only answers to a logged-in account. */
export async function check() {
  const c = open();
  if (!c.file) throw httpError(400, 'There are no cookies to check');
  const bin = settings.get('downloads').ytdlpBin || 'yt-dlp';
  const result = await new Promise((resolve) => {
    execFile(bin, ['--cookies', c.file, '--flat-playlist', '--playlist-items', '1', '--print', 'id', '--no-colors', ':ythistory'], { timeout: 60_000 }, (err, stdout, stderr) => {
      const text = `${stderr || ''}${err?.message || ''}`;
      if (err?.code === 'ENOENT') return resolve({ ok: null, message: 'yt-dlp isn’t installed, so they can’t be checked yet (Settings → Downloads → tools).' });
      if (/no longer valid|sign in|login required|cookies.*(invalid|expired)|not logged in/i.test(text)) return resolve({ ok: false, message: 'YouTube doesn’t accept them any more. Export new ones (see the guide).' });
      if (/confirm you.?re not a bot|HTTP Error 429/i.test(text)) return resolve({ ok: null, message: 'YouTube is limiting this server right now, so it couldn’t tell. Try again later.' });
      if (!err) return resolve({ ok: true, message: stdout.trim() ? 'Logged in: YouTube accepts them.' : 'Logged in (your history is empty or paused).' });
      resolve({ ok: false, message: `Didn’t work: ${text.split('\n').find((l) => /ERROR/.test(l))?.replace(/^.*ERROR:\s*/, '').slice(0, 200) || 'unknown error'}` });
    });
  });
  c.close();
  const s = read();
  if (s) write({ ...s, check: { ...result, at: now() } });
  return { ...result, at: now() };
}

export function register(app) {
  app.get('/api/downloads/cookies', requireAdmin, json(() => status()));
  app.put(
    '/api/downloads/cookies',
    requireAdmin,
    express.text({ type: () => true, limit: '5mb' }),
    json(async (req) => {
      const p = parse(typeof req.body === 'string' ? req.body : '');
      if (!p.count) throw httpError(400, p.dropped ? 'There are no YouTube cookies in this file. Export them while youtube.com is open.' : 'This isn’t a cookies.txt file (Netscape format). See the guide.');
      write({ sealed: seal(p.text), count: p.count, loggedIn: p.loggedIn, expires: p.expires, uploadedAt: now() });
      audit(req.user.id, 'downloads.cookies.upload', { count: p.count, dropped: p.dropped });
      // Check right away, so the page can say whether they work.
      const result = await check().catch((e) => ({ ok: null, message: e.message }));
      return { ...status(), dropped: p.dropped, check: result };
    }),
  );
  app.post('/api/downloads/cookies/check', requireAdmin, json(() => check()));
  app.delete(
    '/api/downloads/cookies',
    requireAdmin,
    json((req) => {
      fs.rmSync(FILE, { force: true });
      audit(req.user.id, 'downloads.cookies.remove', {});
      return status();
    }),
  );
}
