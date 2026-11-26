// pnpm dev: the server (restarts on changes) and the web app with hot reload.
import { spawn } from 'node:child_process';
const run = (cmd, args, name, color) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'development' } });
  const tag = `\x1b[${color}m${name}\x1b[0m`;
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => process.stdout.write(d.toString().replace(/^/gm, `${tag} `)));
  p.on('exit', (c) => process.exit(c ?? 0));
  return p;
};
run('node', ['--watch', 'server/src/index.js'], 'server', 35);
run('npx', ['vite', '--config', 'web/vite.config.js'], 'web   ', 36);
console.log('Open http://localhost:5173 (the API runs on :4545)');
