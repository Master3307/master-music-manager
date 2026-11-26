import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { ZipArchive } from 'archiver';
import { PATHS, VERSION, REPO, REPO_URL, ROOT, PORT, DATA_DIR } from './config.js';
import { db, now, audit, tx } from './db.js';
import * as settings from './settings.js';
import * as jobs from './jobs.js';
import { log } from './lib/log.js';
import { httpError, json, str, bool, sendSse } from './lib/http.js';
import { requireUser, requireAdmin } from './auth.js';
import { seal, unseal, passphraseKey, sha256, safeEqual, token } from './lib/crypto.js';
import { merge as mergeScrobbles } from './scrobbles.js';
import { aboutByName } from './artists.js';
import { THEMES } from './themes.js';

import { WebSocketServer } from 'ws';

/** What the Navidrome plugin last reported per user and player. */
export const PLUGIN_PLAYING = new Map();
import { take } from './uploads.js';

// ---- updates ----
const cmpVer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
export async function checkUpdate({ force = false } = {}) {
  const u = settings.get('updates');
  if (!settings.online('updateCheck')) return { version: VERSION, latest: null, disabled: true };
  if (!force && u.lastChecked && now() - u.lastChecked < 6 * 3600_000) return { version: VERSION, latest: u.latest, update: u.latest && cmpVer(u.latest.version, VERSION) > 0 };
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MasterMusicManager' }, signal: AbortSignal.timeout(10000) }).then((x) => x.json());
    const list = Array.isArray(r) ? r.filter((x) => !x.draft && (u.channel === 'beta' || !x.prerelease)) : [];
    const app = list.find((x) => /^v\d/.test(x.tag_name)) || null;
    const plugin = list.find((x) => /^plugin-v/.test(x.tag_name)) || null;
    const latest = app ? { version: app.tag_name.replace(/^v/, ''), name: app.name, notes: app.body, url: app.html_url, date: app.published_at, plugin: plugin ? { version: plugin.tag_name.replace(/^plugin-v/, ''), url: plugin.html_url, asset: plugin.assets?.find((x) => x.name.endsWith('.ndp'))?.browser_download_url } : null } : null;
    settings.set('updates', { lastChecked: now(), latest });
    return { version: VERSION, latest, update: latest && cmpVer(latest.version, VERSION) > 0 };
  } catch (e) {
    return { version: VERSION, latest: u.latest, error: e.message };
  }
}

const isGit = () => fs.existsSync(path.join(ROOT, '.git'));

function runUpdate(ctx) {
  return (async () => {
    if (isGit()) {
      await ctx.run('git', ['-C', ROOT, 'fetch', '--tags', '--prune', 'origin']);
      const status = await ctx.run('git', ['-C', ROOT, 'status', '--porcelain'], { quiet: true });
      if (status.stdout.trim()) {
        ctx.log('Local changes found; keeping them aside (git stash)');
        await ctx.run('git', ['-C', ROOT, 'stash', 'push', '-u', '-m', `mmm-update-${Date.now()}`]);
      }
      await ctx.run('git', ['-C', ROOT, 'pull', '--ff-only']);
    } else {
      const url = `https://github.com/${REPO}/archive/refs/heads/master.tar.gz`;
      ctx.log(`Downloading ${url}`);
      const tmp = path.join(PATHS.cache, 'update.tgz');
      const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      await ctx.run('tar', ['-xzf', tmp, '-C', ROOT, '--strip-components=1']);
    }
    const pnpm = (await whichBin('pnpm')) || 'npx pnpm';
    await ctx.run('sh', ['-c', `cd "${ROOT}" && ${pnpm} install --frozen-lockfile --prod=false && ${pnpm} build`]);
    ctx.log('Update installed. Restarting…');
    setTimeout(() => restart(), 1500);
    return { restarting: true };
  })();
}

function whichBin(b) {
  return new Promise((res) => execFile('sh', ['-c', `command -v ${b}`], (e, out) => res(e ? null : out.trim())));
}

/** Restart: under systemd (or any supervisor) exiting is enough; otherwise re-spawn ourselves. */
export function restart() {
  log.info('restarting');
  if (process.env.INVOCATION_ID || process.env.MMM_SUPERVISED) process.exit(0);
  const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', cwd: process.cwd(), env: process.env });
  child.unref();
  setTimeout(() => process.exit(0), 300);
}

// ---- startup entry ----
export function unitFile({ user = os.userInfo().username, system = process.getuid?.() === 0 } = {}) {
  return `[Unit]
Description=Master Music Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${system ? `User=${user}\n` : ''}WorkingDirectory=${ROOT}
Environment=NODE_ENV=production
Environment=MMM_PORT=${PORT}
Environment=MMM_DATA_DIR=${DATA_DIR}
ExecStart=${process.execPath} ${path.join(ROOT, 'server/src/index.js')}
Restart=always
RestartSec=3

[Install]
WantedBy=${system ? 'multi-user.target' : 'default.target'}
`;
}

async function installStartup(ctx, enable) {
  const system = process.getuid?.() === 0;
  const file = system ? '/etc/systemd/system/master-music-manager.service' : path.join(os.homedir(), '.config/systemd/user/master-music-manager.service');
  const sc = system ? ['systemctl'] : ['systemctl', '--user'];
  if (!enable) {
    await ctx.run(sc[0], [...sc.slice(1), 'disable', 'master-music-manager'], { allowFail: true });
    fs.rmSync(file, { force: true });
    await ctx.run(sc[0], [...sc.slice(1), 'daemon-reload'], { allowFail: true });
    return { removed: file };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unitFile({ system }));
  ctx.log(`Wrote ${file}`);
  await ctx.run(sc[0], [...sc.slice(1), 'daemon-reload']);
  await ctx.run(sc[0], [...sc.slice(1), 'enable', 'master-music-manager']);
  if (!system) {
    ctx.log('Letting it run without being logged in (loginctl enable-linger)');
    await ctx.run('loginctl', ['enable-linger', os.userInfo().username], { allowFail: true });
  }
  ctx.log('It starts with the computer now. It takes over from this process after the next restart.');
  return { file, system };
}

// ---- backup ----
const BACKUP_TABLES = ['settings', 'users', 'profiles', 'shares', 'scrobbles', 'local_playlists', 'artist_info', 'nodes', 'app_passwords', 'restore_points', 'sync_groups'];

function exportBackup({ passphrase, includeSecrets }) {
  const data = {};
  for (const t of BACKUP_TABLES) data[t] = db.prepare(`SELECT * FROM ${t}`).all();
  // Sealed values are tied to this server's key; re-seal with the passphrase or drop them.
  const salt = crypto.randomBytes(16);
  const key = passphrase ? passphraseKey(passphrase, salt) : null;
  const reseal = (v) => (v && includeSecrets && key ? seal(unseal(v), key) : null);
  data.profiles = data.profiles.map((p) => ({ ...p, secret: reseal(p.secret) }));
  data.users = data.users.map((u) => ({ ...u, totp_secret: reseal(u.totp_secret) }));
  data.nodes = data.nodes.map((n) => ({ ...n, their_key: reseal(n.their_key) }));
  data.settings = data.settings.map((s) => {
    if (s.key !== 'auth' && s.key !== 'plugin') return s;
    const v = JSON.parse(s.value);
    if (s.key === 'auth' && v.discord?.clientSecret) v.discord.clientSecret = includeSecrets && key ? seal(v.discord.clientSecret, key) : '';
    if (s.key === 'plugin' && v.secret) v.secret = includeSecrets && key ? seal(v.secret, key) : '';
    return { ...s, value: JSON.stringify(v) };
  });
  data.restore_points = data.restore_points.map((r) => ({ ...r, file: null }));
  return { app: 'master-music-manager', version: VERSION, format: 1, created: now(), salt: key ? salt.toString('base64') : null, secrets: Boolean(includeSecrets && key), check: key ? seal('ok', key) : null, data };
}

function importBackup(b, { passphrase, mode = 'merge' }) {
  if (b.app !== 'master-music-manager') throw httpError(400, 'This is not a Master Music Manager backup');
  let key = null;
  if (b.secrets) {
    if (!passphrase) throw httpError(400, 'This backup has passwords inside. Enter its passphrase (or untick "restore passwords").');
    key = passphraseKey(passphrase, Buffer.from(b.salt, 'base64'));
    if (unseal(b.check, key) !== 'ok') throw httpError(400, 'Wrong passphrase');
  }
  const local = (v) => (v && key ? seal(unseal(v, key)) : null);
  const counts = {};
  tx(() => {
    for (const t of BACKUP_TABLES) {
      const rows = b.data?.[t];
      if (!Array.isArray(rows)) continue;
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      if (mode === 'replace' && t !== 'users') db.prepare(`DELETE FROM ${t}`).run();
      let n = 0;
      for (const raw of rows) {
        const r = { ...raw };
        if (t === 'profiles') r.secret = local(r.secret);
        if (t === 'users') r.totp_secret = local(r.totp_secret);
        if (t === 'nodes') r.their_key = local(r.their_key);
        if (t === 'restore_points') continue;
        if (t === 'settings' && (r.key === 'auth' || r.key === 'plugin')) {
          const v = JSON.parse(r.value);
          if (v.discord?.clientSecret) v.discord.clientSecret = key ? unseal(v.discord.clientSecret, key) || '' : '';
          if (v.secret) v.secret = key ? unseal(v.secret, key) || '' : '';
          r.value = JSON.stringify(v);
        }
        const keys = Object.keys(r).filter((k) => cols.includes(k)); // old/new versions: only shared columns
        if (!keys.length) continue;
        const verb = mode === 'replace' || t === 'settings' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
        const res = db.prepare(`${verb} INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k]));
        n += res.changes;
      }
      counts[t] = n;
    }
  });
  return counts;
}

export function register(app) {
  app.get('/api/health', json(() => ({ ok: true, version: VERSION })));
  app.get(
    '/api/system',
    requireUser,
    json(async () => ({
      version: VERSION,
      repo: REPO_URL,
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      hostname: os.hostname(),
      uptime: process.uptime(),
      memory: process.memoryUsage().rss,
      dataDir: DATA_DIR,
      logDir: PATHS.logs,
      install: isGit() ? 'git' : 'archive',
      supervised: Boolean(process.env.INVOCATION_ID || process.env.MMM_SUPERVISED),
      port: PORT,
      lanUrls: (await import('./federation.js')).lanUrls(),
    })),
  );

  // ---- settings ----
  app.get(
    '/api/settings',
    requireUser,
    json((req) => {
      const s = settings.forClient();
      if (req.user.role === 'admin') return s;
      // Only what the interface needs; no keys, accounts or server details.
      return { appearance: s.appearance, player: s.player, shares: { siteName: s.shares.siteName }, setupDone: s.setupDone, public: s.public, privacy: { fullLocal: s.privacy.fullLocal } };
    }),
  );
  app.get('/api/settings/defaults', requireUser, json(() => settings.DEFAULTS));
  app.put(
    '/api/settings/:key',
    requireAdmin,
    json((req) => {
      const key = req.params.key;
      if (!(key in settings.DEFAULTS)) throw httpError(404, 'Unknown setting');
      const body = { ...req.body };
      if (key === 'auth' && body.discord?.clientSecret === '••••••') body.discord = { ...body.discord, clientSecret: settings.get('auth').discord.clientSecret };
      if (key === 'plugin' && body.secret === '••••••') delete body.secret;
      if (key === 'auth' && body.required && !db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) throw httpError(400, 'Create an admin account first, or you would lock yourself out');
      const v = settings.set(key, body);
      audit(req.user.id, 'settings', { key });
      return v;
    }),
  );
  app.get('/api/themes', requireUser, json(() => THEMES));
  // Fetch a theme from its address (install / update). Own servers on the LAN are fine here.
  app.get(
    '/api/themes/fetch',
    requireAdmin,
    json(async (req) => {
      const { safeFetch } = await import('./lib/net.js');
      const url = str(req.query.url, 2000);
      const r = await safeFetch(url, { maxBytes: 512 * 1024, allowPrivate: true, timeout: 15000 });
      const text = r.body.toString('utf8');
      if (/<html|<!doctype/i.test(text.slice(0, 200))) throw httpError(400, 'That address is a web page, not a CSS file');
      return { css: text, url: r.url };
    }),
  );

  // ---- jobs ----
  app.get('/api/jobs', requireUser, json((req) => jobs.list({ limit: Math.min(Number(req.query.limit) || 100, 500), kind: req.query.kind })));
  app.get('/api/jobs/:id', requireUser, json((req) => ({ ...jobs.get(req.params.id), log: jobs.readLog(req.params.id, { tail: Number(req.query.tail) || 400_000 }) })));
  app.get('/api/jobs/:id/log', requireUser, (req, res) => res.type('text/plain').attachment(`job-${req.params.id}.log`).send(jobs.readLog(req.params.id)));
  app.post('/api/jobs/:id/cancel', requireUser, json((req) => ({ ok: jobs.cancel(req.params.id) })));
  app.delete('/api/jobs', requireUser, json(() => ({ removed: jobs.clearFinished() })));
  // The same events over a WebSocket: browsers don't count an open WebSocket
  // as "the page is still loading" (they do for EventSource). index.js hands
  // upgrade requests to the app, so login and roles apply as for any route.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  app.get('/api/ws', requireUser, (req, res) => {
    if (!req.wsHead) return res.status(426).json({ error: 'Use a WebSocket here' });
    // Only our own pages may open it (no cross-site WebSocket hijacking).
    const origin = req.get('origin');
    try {
      if (!origin || new URL(origin).host !== (req.get('x-forwarded-host') || req.get('host'))) return res.status(403).end();
    } catch {
      return res.status(403).end();
    }
    res.detachSocket?.(req.socket);
    wss.handleUpgrade(req, req.socket, req.wsHead, (ws) => {
      const send = (type, data) => ws.readyState === 1 && ws.send(JSON.stringify({ type, data }));
      const offJobs = jobs.subscribe((e) => send(e.type, e));
      const offLog = log.subscribe((e) => e.level !== 'debug' && send('applog', e));
      const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 25_000);
      ws.on('close', () => {
        clearInterval(ping);
        offJobs();
        offLog();
      });
      ws.on('message', () => {}); // nothing to receive
    });
  });

  app.get('/api/events', requireUser, (req, res) => {
    const send = sendSse(res);
    const offJobs = jobs.subscribe((e) => send(e.type, e));
    const offLog = log.subscribe((e) => e.level !== 'debug' && send('applog', e));
    req.on('close', () => {
      offJobs();
      offLog();
    });
  });

  // ---- logs ----
  app.get(
    '/api/logs',
    requireAdmin,
    json(() => {
      const files = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else {
            const st = fs.statSync(f);
            files.push({ name: path.relative(PATHS.logs, f), size: st.size, modified: st.mtimeMs });
          }
        }
      };
      walk(PATHS.logs);
      return { dir: PATHS.logs, files: files.sort((a, b) => b.modified - a.modified), recent: log.recent().slice(-500) };
    }),
  );
  app.get('/api/logs/file', requireAdmin, (req, res, next) => {
    const f = path.resolve(PATHS.logs, str(req.query.name, 500));
    if (!f.startsWith(PATHS.logs)) return next(httpError(400, 'Bad path'));
    if (!fs.existsSync(f)) return next(httpError(404, 'No such log'));
    if (bool(req.query.download)) res.attachment(path.basename(f));
    const tail = Number(req.query.tail) || 0;
    if (tail) {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, 'r');
      const len = Math.min(tail, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      return res.type('text/plain').send(buf.toString());
    }
    res.type('text/plain').sendFile(f);
  });
  app.get('/api/logs/export', requireAdmin, async (req, res) => {
    res.attachment(`mmm-logs-${new Date().toISOString().slice(0, 10)}.zip`);
    const z = new ZipArchive({ zlib: { level: 9 } });
    z.pipe(res);
    z.directory(PATHS.logs, 'logs');
    z.append(JSON.stringify({ version: VERSION, node: process.version, os: `${os.type()} ${os.release()}`, at: new Date().toISOString() }, null, 2), { name: 'about.json' });
    await z.finalize();
  });
  app.delete('/api/logs', requireAdmin, json(() => {
    for (const f of fs.readdirSync(PATHS.jobs)) fs.rmSync(path.join(PATHS.jobs, f), { force: true });
    jobs.clearFinished();
    return { ok: true };
  }));
  app.get('/api/audit', requireAdmin, json((req) => db.prepare('SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY ts DESC LIMIT ?').all(Math.min(Number(req.query.limit) || 300, 5000))));

  // ---- updates / restart / startup ----
  app.get('/api/update', requireUser, json((req) => checkUpdate({ force: bool(req.query.force) })));
  app.post('/api/update', requireAdmin, json((req) => ({ job: jobs.start('update', 'Updating Master Music Manager', runUpdate, { userId: req.user.id }) })));
  app.post('/api/restart', requireAdmin, json((req) => {
    audit(req.user.id, 'restart');
    setTimeout(restart, 500);
    return { ok: true };
  }));
  app.get('/api/startup', requireAdmin, json(() => {
    const system = process.getuid?.() === 0;
    const file = system ? '/etc/systemd/system/master-music-manager.service' : path.join(os.homedir(), '.config/systemd/user/master-music-manager.service');
    return { installed: fs.existsSync(file), file, system, unit: unitFile({ system }), supervised: Boolean(process.env.INVOCATION_ID), platform: process.platform };
  }));
  app.post('/api/startup', requireAdmin, json((req) => {
    if (process.platform !== 'linux') throw httpError(400, 'Automatic startup entries are made for Linux (systemd). See the README for other systems.');
    return { job: jobs.start('system', bool(req.body.enable) ? 'Start with the computer' : 'Remove the startup entry', (ctx) => installStartup(ctx, bool(req.body.enable)), { userId: req.user.id }) };
  }));

  // ---- backup ----
  app.post('/api/backup/export', requireAdmin, json((req, res) => {
    const b = exportBackup({ passphrase: str(req.body.passphrase, 500), includeSecrets: bool(req.body.includeSecrets) });
    audit(req.user.id, 'backup.export', { secrets: b.secrets });
    res.attachment(`mmm-backup-${new Date().toISOString().slice(0, 10)}.json`).type('application/json').send(JSON.stringify(b));
  }));
  app.post(
    '/api/backup/import',
    requireAdmin,
    express.json({ limit: '200mb' }),
    json((req) => {
      let backup = req.body.backup;
      if (req.body.upload) {
        const u = take(String(req.body.upload), req.user.id);
        backup = JSON.parse(fs.readFileSync(u.file, 'utf8'));
        fs.rmSync(u.file, { force: true });
      }
      const counts = importBackup(backup, { passphrase: str(req.body.passphrase, 500), mode: req.body.mode === 'replace' ? 'replace' : 'merge' });
      audit(req.user.id, 'backup.import', counts);
      return { ok: true, counts, restartRecommended: true };
    }),
  );

  // ---- the Navidrome plugin ----
  const pluginAuth = (req, _res, next) => {
    const p = settings.get('plugin');
    const got = String(req.get('authorization') || '').replace(/^Bearer /, '');
    if (!p.secret || !safeEqual(sha256(got), sha256(p.secret))) return next(httpError(401, 'Wrong plugin secret'));
    settings.set('plugin', { lastSeen: now(), version: req.get('x-mmm-plugin') || p.version });
    next();
  };
  app.post('/api/plugin/secret', requireAdmin, json(() => {
    const secret = token(24);
    settings.set('plugin', { secret });
    return { secret };
  }));
  app.get('/api/plugin/status', requireUser, json(() => {
    const p = settings.get('plugin');
    return { configured: Boolean(p.secret), lastSeen: p.lastSeen, version: p.version, port: PORT };
  }));
  app.post('/api/plugin/scrobble', express.json({ limit: '2mb' }), pluginAuth, json((req) => {
    const b = req.body || {};
    const t = b.track || {};
    const profile = db.prepare("SELECT id FROM profiles WHERE kind = 'navidrome' AND owner_id IS NULL ORDER BY sort LIMIT 1").get();
    return mergeScrobbles([{ ts: b.timestamp, title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist, duration: t.duration, mbid: t.mbzRecordingId }], { profileId: profile?.id, username: b.username, source: 'navidrome-plugin' });
  }));
  app.post('/api/plugin/history', express.json({ limit: '50mb' }), pluginAuth, json((req) => {
    const items = (req.body.items || []).map((i) => ({ ts: i.ts, title: i.title, artist: i.artist, album: i.album, duration: i.duration, mbid: i.mbid }));
    const profile = db.prepare("SELECT id FROM profiles WHERE kind = 'navidrome' AND owner_id IS NULL ORDER BY sort LIMIT 1").get();
    return mergeScrobbles(items, { profileId: profile?.id, username: req.body.username, source: 'navidrome-history' });
  }));
  const nowPlaying = PLUGIN_PLAYING;
  app.post('/api/plugin/playback', express.json(), pluginAuth, json((req) => {
    nowPlaying.set(`${req.body.username}:${req.body.playerId || ''}`, { ...req.body, at: now() });
    return { ok: true };
  }));
  app.get('/api/plugin/now-playing', requireUser, json(() => [...nowPlaying.values()].filter((x) => now() - x.at < 10 * 60_000 && x.state !== 'stopped')));
  app.get('/api/plugin/artist', pluginAuth, json((req) => aboutByName(str(req.query.name, 300)) || {}));
}
