#!/usr/bin/env node
// pnpm setup: the few things that must be decided before the app starts
// (port, data folder, start with the computer). Everything else is set up in
// the browser, where it's easier.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yes = process.argv.includes('--yes') || !process.stdin.isTTY;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, d) => (yes ? d : (await rl.question(`${q} \x1b[2m(${d})\x1b[0m `)).trim() || d);
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const acc = (s) => `\x1b[35m${s}\x1b[0m`;

const envFile = path.join(ROOT, '.env');
const cur = {};
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) cur[m[1]] = m[2]; }
const free = (port) => new Promise((res) => { const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port, '0.0.0.0'); });

console.log(`\n${acc('◉')} ${b('Master Music Manager setup')}\n`);
let port = Number(process.env.MMM_PORT || cur.MMM_PORT || 4545);
if (!process.env.MMM_PORT && !cur.MMM_PORT && !(await free(port))) for (let p = 4546; p < 4600; p++) if (await free(p)) { port = p; break; }
port = Number(await ask('Port', String(port)));
const defaultData = cur.MMM_DATA_DIR || (process.getuid?.() === 0 ? '/var/lib/master-music-manager' : path.join(os.homedir(), '.local/share/master-music-manager'));
const data = await ask('Where the app keeps its data (not your music)', defaultData);
fs.mkdirSync(data, { recursive: true });

// Hints for the browser setup.
try {
  const toml = fs.readFileSync('/etc/navidrome/navidrome.toml', 'utf8');
  const mf = toml.match(/MusicFolder\s*=\s*"([^"]+)"/)?.[1];
  console.log(`\n  Found Navidrome on this machine${mf ? ` with music in ${b(mf)}` : ''}. You can connect it in the browser in one step.`);
} catch {}

const lines = { ...cur, MMM_PORT: String(port), MMM_DATA_DIR: data };
fs.writeFileSync(envFile, `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
console.log(`\n  Saved ${envFile}`);

const service = process.platform === 'linux' && !process.argv.includes('--no-service') && (await ask('\nStart it with the computer (systemd service)? [Y/n]', 'y')).toLowerCase() !== 'n';
rl.close();
if (!fs.existsSync(path.join(ROOT, 'web/dist/index.html'))) {
  console.log('\n  Building the web app…');
  spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
}
if (service) spawnSync(process.execPath, [path.join(ROOT, 'scripts/mmm.mjs'), 'service', 'on'], { stdio: 'inherit', env: { ...process.env, MMM_PORT: String(port), MMM_DATA_DIR: data } });

const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address);
console.log(`\n${b('Done.')} ${service ? 'It’s running.' : `Start it with: ${acc('pnpm start')}`} Open it in your browser to finish:`);
for (const ip of ['localhost', ...ips]) console.log(`  ${acc(`http://${ip}:${port}`)}`);
console.log('');
