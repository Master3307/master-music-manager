// Background jobs with a progress value, a status line and a full log file.
// The UI subscribes over SSE and can expand any job into a "Details" code block.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PATHS } from './config.js';
import { db, now } from './db.js';
import { uuid } from './lib/crypto.js';
import { log } from './lib/log.js';

const listeners = new Set();
const running = new Map(); // id -> { cancel }
const queue = [];
const LIMIT = 3;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(event) {
  for (const fn of listeners) fn(event);
}

export const logFile = (id) => path.join(PATHS.jobs, `${id}.log`);

function row(id) {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return r && { ...r, result: r.result ? JSON.parse(r.result) : null };
}

export function list({ limit = 100, kind } = {}) {
  const rows = kind
    ? db.prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, limit)
    : db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null, running: running.has(r.id) }));
}

export const get = row;

export function readLog(id, { tail } = {}) {
  try {
    const text = fs.readFileSync(logFile(id), 'utf8');
    return tail ? text.slice(-tail) : text;
  } catch {
    return '';
  }
}

/**
 * Start a job. `fn(ctx)` gets helpers: log(text), progress(0..1, detail),
 * run(cmd, args, opts) to spawn with output piped into the log, and signal for cancelling.
 */
export function start(kind, title, fn, { userId } = {}) {
  const id = uuid();
  db.prepare('INSERT INTO jobs (id, kind, title, status, progress, user_id, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(
    id,
    kind,
    title,
    'queued',
    userId ?? null,
    now(),
  );
  emit({ type: 'job', job: row(id) });
  queue.push({ id, fn });
  pump();
  return id;
}

function pump() {
  while (running.size < LIMIT && queue.length) {
    const { id, fn } = queue.shift();
    execute(id, fn);
  }
}

async function execute(id, fn) {
  const controller = new AbortController();
  const children = new Set();
  running.set(id, {
    cancel() {
      controller.abort();
      for (const c of children) c.kill('SIGTERM');
    },
  });
  const out = fs.createWriteStream(logFile(id), { flags: 'a' });
  let lastEmit = 0;
  const write = (text) => {
    const s = String(text);
    out.write(s.endsWith('\n') ? s : `${s}\n`);
    emit({ type: 'log', id, text: s.endsWith('\n') ? s : `${s}\n` });
  };
  const ctx = {
    id,
    signal: controller.signal,
    log: write,
    progress(p, detail) {
      db.prepare('UPDATE jobs SET progress = ?, detail = COALESCE(?, detail) WHERE id = ?').run(p, detail ?? null, id);
      const t = Date.now();
      if (t - lastEmit > 150 || p >= 1) {
        lastEmit = t;
        emit({ type: 'job', job: row(id) });
      }
    },
    detail(detail) {
      db.prepare('UPDATE jobs SET detail = ? WHERE id = ?').run(detail, id);
      emit({ type: 'job', job: row(id) });
    },
    check() {
      if (controller.signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    },
    run(cmd, args, opts = {}) {
      return new Promise((resolve, reject) => {
        write(`$ ${[cmd, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        let stdout = '';
        let stderr = '';
        const onData = (which) => (buf) => {
          const s = buf.toString();
          if (which === 'out') stdout += s;
          else stderr += s;
          if (!opts.quiet) write(s.replace(/\r(?!\n)/g, '\n'));
          opts.onData?.(s, which);
        };
        child.stdout.on('data', onData('out'));
        child.stderr.on('data', onData('err'));
        child.on('error', (e) => {
          children.delete(child);
          reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed (or not in PATH)`) : e);
        });
        child.on('close', (code) => {
          children.delete(child);
          if (controller.signal.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
          if (code === 0 || opts.allowFail) resolve({ code, stdout, stderr });
          else reject(new Error(`${path.basename(cmd)} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
        });
      });
    },
  };

  db.prepare('UPDATE jobs SET status = ?, started_at = ? WHERE id = ?').run('running', now(), id);
  emit({ type: 'job', job: row(id) });
  try {
    const result = await fn(ctx);
    db.prepare('UPDATE jobs SET status = ?, progress = 1, result = ?, finished_at = ? WHERE id = ?').run(
      'done',
      result === undefined ? null : JSON.stringify(result),
      now(),
      id,
    );
    write('✓ Finished');
  } catch (e) {
    const cancelled = e?.cancelled || controller.signal.aborted;
    db.prepare('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(cancelled ? 'cancelled' : 'failed', e?.message || String(e), now(), id);
    write(cancelled ? '■ Cancelled' : `✗ ${e?.stack || e}`);
    if (!cancelled) log.error(`job ${id} (${row(id)?.title}) failed:`, e?.message || e);
  } finally {
    out.end();
    running.delete(id);
    emit({ type: 'job', job: row(id) });
    pump();
  }
}

export function cancel(id) {
  const r = running.get(id);
  if (r) r.cancel();
  const i = queue.findIndex((q) => q.id === id);
  if (i >= 0) {
    queue.splice(i, 1);
    db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run('cancelled', now(), id);
    emit({ type: 'job', job: row(id) });
  }
  return Boolean(r || i >= 0);
}

export function clearFinished() {
  const ids = db.prepare("SELECT id FROM jobs WHERE status IN ('done','failed','cancelled')").all().map((r) => r.id);
  for (const id of ids) fs.rmSync(logFile(id), { force: true });
  db.prepare("DELETE FROM jobs WHERE status IN ('done','failed','cancelled')").run();
  emit({ type: 'cleared' });
  return ids.length;
}

// Jobs that were running when the process stopped can't resume.
db.prepare("UPDATE jobs SET status = 'failed', error = 'Interrupted by a restart', finished_at = ? WHERE status IN ('running','queued')").run(now());

/** Wait for a job to finish (used by the CLI and chained operations). */
export function wait(id) {
  return new Promise((resolve) => {
    const check = () => {
      const r = row(id);
      if (r && !['queued', 'running'].includes(r.status)) {
        off();
        resolve(r);
      }
    };
    const off = subscribe((e) => e.type === 'job' && e.job?.id === id && check());
    check();
  });
}
