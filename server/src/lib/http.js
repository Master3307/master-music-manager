export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const httpError = (status, message, extra) => new HttpError(status, message, extra);

/** Express 5 forwards rejected promises itself; this only adds JSON replies. */
export const json = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req, res, next);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};

export function str(v, max = 2000) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

export function bool(v) {
  return v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
}

/** Simple fixed-window limiter, per key. */
export function limiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (key) => {
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n <= max;
  };
}

export function sendSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => clearInterval(ping));
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
