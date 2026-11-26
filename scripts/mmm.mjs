#!/usr/bin/env node
// mmm: Master Music Manager from the terminal. `mmm help` lists everything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
// Read .env like the server does.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const PORT = Number(env.MMM_PORT || 4545);
const DATA = env.MMM_DATA_DIR || (process.getuid?.() === 0 ? '/var/lib/master-music-manager' : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'master-music-manager'));
const BASE = `http://127.0.0.1:${PORT}`;
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, acc: (s) => `\x1b[35m${s}\x1b[0m` };
const [cmd = 'help', ...args] = process.argv.slice(2);
const flag = (f) => args.includes(f);

function token() {
  try {
    return fs.readFileSync(path.join(DATA, 'cli.token'), 'utf8').trim();
  } catch {
    return null;
  }
}
async function api(p, { method = 'GET', body } = {}) {
  const t = token();
  const r = await fetch(`${BASE}/api/${p}`, {
    method,
    headers: { 'X-MMM': '1', ...(t ? { 'X-MMM-CLI': t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}
async function running() {
  try {
    return await api('health');
  } catch {
    return null;
  }
}
const systemd = () => {
  for (const [scope, file] of [['system', '/etc/systemd/system/master-music-manager.service'], ['user', path.join(os.homedir(), '.config/systemd/user/master-music-manager.service')]])
    if (fs.existsSync(file)) return scope;
  return null;
};
const sc = (scope, ...a) => spawnSync('systemctl', [...(scope === 'user' ? ['--user'] : []), ...a], { stdio: 'inherit' });
async function waitJob(id) {
  let last = '';
  for (;;) {
    const j = await api(`jobs/${id}?tail=20000`);
    const out = j.log.slice(last.length);
    if (out) process.stdout.write(c.dim(out));
    last = j.log;
    if (!['queued', 'running'].includes(j.status)) {
      console.log(j.status === 'done' ? c.ok('✓ done') : c.bad(`✗ ${j.status}: ${j.error || ''}`));
      return j;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

const commands = {
  async help() {
    console.log(`${c.b('Master Music Manager')} ${c.dim(`(${ROOT})`)}

  ${c.acc('mmm status')}            is it running, version, addresses
  ${c.acc('mmm start')}             start it (in this terminal, or the service)
  ${c.acc('mmm stop')} / ${c.acc('restart')}    stop / restart the service
  ${c.acc('mmm logs')} [-f]         show the log (-f keeps following)
  ${c.acc('mmm update')}            download the newest version, build, restart
  ${c.acc('mmm scan')} [--full]     read every library folder again
  ${c.acc('mmm jobs')}              what's running
  ${c.acc('mmm backup')} <file>     save settings, accounts, playlists… (no music)
  ${c.acc('mmm password')} <user>   set a new password for someone
  ${c.acc('mmm open-login')}        turn "require logging in" off (if you locked yourself out)
  ${c.acc('mmm setup-code')}        the code for creating the first admin through the internet
  ${c.acc('mmm doctor')}            check FFmpeg, spotDL, yt-dlp, permissions, port
  ${c.acc('mmm service')} on|off    start with the computer (systemd)
  ${c.acc('mmm setup')}             the terminal setup (port, folders, service)
  ${c.acc('mmm plugin')}            install the Navidrome plugin on this machine
  ${c.acc('mmm version')}`);
  },
  async 'setup-code'() {
    try {
      console.log(`Setup code: ${c.b(fs.readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim())}`);
      console.log(c.dim('Type it on the "Almost ready" page to create the admin account from anywhere.'));
    } catch {
      console.log('There is no setup code: the admin account already exists (or the app has not started yet).');
    }
  },
  async version() {
    console.log(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  },
  async status() {
    const h = await running();
    const s = systemd();
    console.log(`${h ? c.ok('● running') : c.bad('○ not running')}  ${h ? `version ${h.version}` : ''}  ${s ? c.dim(`(${s} service)`) : c.dim('(no service)')}`);
    console.log(`  data: ${DATA}`);
    for (const ip of ['localhost', ...lanIps()]) console.log(`  open: http://${ip}:${PORT}`);
    if (h) {
      const jobs = await api('jobs?limit=10').catch(() => []);
      const live = jobs.filter((j) => ['queued', 'running'].includes(j.status));
      if (live.length) console.log(`  busy: ${live.map((j) => j.title).join(', ')}`);
    }
  },
  async start() {
    const s = systemd();
    if (s && !flag('--here')) return sc(s, 'start', 'master-music-manager');
    const child = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], { stdio: 'inherit', cwd: ROOT, env });
    child.on('exit', (code) => process.exit(code ?? 0));
  },
  async stop() {
    const s = systemd();
    if (s) return sc(s, 'stop', 'master-music-manager');
    console.log('No service is installed; stop it with Ctrl C where it runs.');
  },
  async restart() {
    const s = systemd();
    if (s) return sc(s, 'restart', 'master-music-manager');
    await api('restart', { method: 'POST' });
    console.log('Restarting…');
  },
  async logs() {
    const s = systemd();
    if (s) return spawnSync('journalctl', [...(s === 'user' ? ['--user'] : []), '-u', 'master-music-manager', flag('-f') ? '-f' : '-n200', '--no-pager'], { stdio: 'inherit' });
    spawnSync('tail', [flag('-f') ? '-f' : '-n200', path.join(DATA, 'logs/mmm.log')], { stdio: 'inherit' });
  },
  async update() {
    if (await running()) {
      const r = await api('update', { method: 'POST' });
      return waitJob(r.job);
    }
    const run = (cmd, a) => {
      console.log(c.dim(`$ ${cmd} ${a.join(' ')}`));
      const r = spawnSync(cmd, a, { stdio: 'inherit', cwd: ROOT });
      if (r.status) process.exit(r.status);
    };
    run('git', ['pull', '--ff-only']);
    run('pnpm', ['install', '--frozen-lockfile']);
    run('pnpm', ['build']);
    console.log(c.ok('Updated. Start it with: mmm start'));
  },
  async scan() {
    const profiles = await api('profiles');
    for (const p of profiles.filter((x) => x.localPath)) {
      console.log(c.b(`${p.name}: ${p.localPath}`));
      const r = await api(`p/${p.id}/scan`, { method: 'POST', body: { full: flag('--full') } });
      await waitJob(r.job);
    }
  },
  async jobs() {
    for (const j of await api('jobs?limit=20')) console.log(`${j.status.padEnd(9)} ${new Date(j.created_at).toLocaleString().padEnd(22)} ${j.title}`);
  },
  async backup() {
    const out = args[0] || `mmm-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const t = token();
    const r = await fetch(`${BASE}/api/backup/export`, { method: 'POST', headers: { 'X-MMM': '1', 'X-MMM-CLI': t, 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    console.log(c.ok(`Saved ${out}`));
  },
  async password() {
    const user = args[0];
    if (!user) throw new Error('Usage: mmm password <username>');
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    const pw = await rl.question('New password (8+ characters): ');
    rl.close();
    if (pw.length < 8) throw new Error('Too short');
    process.env.MMM_DATA_DIR = DATA;
    const { db } = await import('../server/src/db.js');
    const { hashPassword } = await import('../server/src/lib/crypto.js');
    const r = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(await hashPassword(pw), user);
    if (!r.changes) throw new Error(`No user called ${user}`);
    db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(user);
    console.log(c.ok(`New password set for ${user}.`));
  },
  async 'open-login'() {
    process.env.MMM_DATA_DIR = DATA;
    const settings = await import('../server/src/settings.js');
    settings.set('auth', { required: false });
    console.log(c.ok('Logging in is no longer required. Restart: mmm restart'));
  },
  async doctor() {
    const check = (name, ok, hint) => console.log(`${ok ? c.ok('✓') : c.bad('✗')} ${name}${ok ? '' : c.dim(`  → ${hint}`)}`);
    const has = (b) => {
      try {
        execFileSync('sh', ['-c', `command -v ${b}`], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };
    check(`Node ${process.version}`, Number(process.versions.node.split('.')[0]) >= 22, 'Node 22 or newer is needed');
    check('FFmpeg', has('ffmpeg') && has('ffprobe'), 'sudo apt install ffmpeg');
    check('yt-dlp (YouTube & co.)', has('yt-dlp') || fs.existsSync(path.join(DATA, 'bin/yt-dlp')), 'install it in the app: Add → Tools');
    check('spotDL (Spotify links)', has('spotdl'), 'pipx install spotdl');
    check('fpcalc (recognize songs)', has('fpcalc') || fs.existsSync(path.join(DATA, 'bin/fpcalc')), 'sudo apt install libchromaprint-tools');
    check('bsdtar or 7z (archives)', has('bsdtar') || has('7z'), 'sudo apt install libarchive-tools');
    check('Web app built', fs.existsSync(path.join(ROOT, 'web/dist/index.html')), 'pnpm build');
    try {
      fs.accessSync(DATA, fs.constants.W_OK);
      check(`Data folder writable (${DATA})`, true);
    } catch {
      check(`Data folder writable (${DATA})`, false, `sudo chown -R ${os.userInfo().username} ${DATA}`);
    }
    const h = await running();
    check(`Running on port ${PORT}`, Boolean(h), 'mmm start');
  },
  async service() {
    const on = (args[0] || 'on') !== 'off';
    const system = process.getuid?.() === 0;
    const file = system ? '/etc/systemd/system/master-music-manager.service' : path.join(os.homedir(), '.config/systemd/user/master-music-manager.service');
    const scope = system ? 'system' : 'user';
    if (!on) {
      sc(scope, 'disable', '--now', 'master-music-manager');
      fs.rmSync(file, { force: true });
      sc(scope, 'daemon-reload');
      return console.log(c.ok('Removed the service.'));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `[Unit]\nDescription=Master Music Manager\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${ROOT}\nEnvironment=NODE_ENV=production\nEnvironment=MMM_PORT=${PORT}\nEnvironment=MMM_DATA_DIR=${DATA}\nExecStart=${process.execPath} ${path.join(ROOT, 'server/src/index.js')}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=${system ? 'multi-user.target' : 'default.target'}\n`,
    );
    sc(scope, 'daemon-reload');
    sc(scope, 'enable', '--now', 'master-music-manager');
    if (!system) spawnSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' });
    console.log(c.ok(`Installed and started (${scope} service).`));
  },
  async setup() {
    spawnSync(process.execPath, [path.join(ROOT, 'scripts/setup.mjs'), ...args], { stdio: 'inherit' });
  },
  async plugin() {
    const dirs = ['/var/lib/navidrome/plugins', '/opt/navidrome/plugins', '/data/plugins'];
    const dir = args[0] || dirs.find((d) => fs.existsSync(d));
    if (!dir) throw new Error('Navidrome’s plugin folder was not found. Give it: mmm plugin /path/to/navidrome/plugins');
    const rel = await fetch('https://api.github.com/repos/Master3307/master-music-manager/releases?per_page=20').then((r) => r.json());
    const asset = rel.find((r) => r.tag_name.startsWith('plugin-v'))?.assets?.find((a) => a.name.endsWith('.ndp'));
    if (!asset) throw new Error('No plugin release found on GitHub yet');
    const data = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
    const out = path.join(dir, 'master-music-manager.ndp');
    fs.writeFileSync(out, data);
    try {
      execFileSync('chown', ['--reference', dir, out]);
    } catch {}
    console.log(c.ok(`Installed ${out}`));
    console.log(`Next: make a secret in Master Music Manager (Settings → Navidrome plugin) and paste it in Navidrome → Plugins, or run the command shown there.`);
  },
};

const fn = commands[cmd];
if (!fn) {
  console.error(c.bad(`Unknown command: ${cmd}`));
  await commands.help();
  process.exit(1);
}
try {
  await fn();
} catch (e) {
  console.error(c.bad(e.message.includes('fetch failed') ? `Master Music Manager is not running on port ${PORT} (mmm start)` : e.message));
  process.exit(1);
}
