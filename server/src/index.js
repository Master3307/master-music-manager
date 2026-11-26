// Master Music Manager: server entry point.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { PORT, HOST, ROOT, VERSION, TRUST_PROXY, DATA_DIR } from './config.js';
import { log } from './lib/log.js';
import * as auth from './auth.js';
import * as services from './services/index.js';
import * as libraryRoutes from './library/routes.js';
import * as uploads from './uploads.js';
import * as inbox from './inbox.js';
import * as downloads from './downloads.js';
import * as tools from './routes/tools.js';
import * as browse from './routes/browse.js';
import * as shares from './shares.js';
import * as scrobbles from './scrobbles.js';
import * as lyrics from './lyrics.js';
import * as artists from './artists.js';
import * as links from './links.js';
import * as recognize from './recognize.js';
import * as federation from './federation.js';
import * as webdav from './webdav.js';
import * as system from './system.js';
import * as transfer from './transfer.js';
import * as lookup from './lookup.js';
import * as navidromeDb from './navidromeDb.js';
import { checkUpdate } from './system.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!req.path.startsWith('/share/')) res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Our data lives in ~/.local/share and canvases in ".canvas" folders; Express's
// sendFile refuses dot-folders by default and answered 404 for every cover.
// Every path we send is built and checked by us, so allow them.
app.use((_req, res, next) => {
  const send = res.sendFile.bind(res);
  res.sendFile = (file, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    return send(file, { dotfiles: 'allow', ...(opts || {}) }, cb);
  };
  next();
});

// WebDAV reads raw bodies itself, so it goes before the body parsers.
webdav.mount(app);

app.use(cookieParser());
// Upload parts and raw image bodies are read by their routes, never by the parsers.
const rawBody = (req) => req.method === 'PUT' && /^\/api\/(uploads\/|p\/[^/]+\/(tracks\/[^/]+\/cover|image\/)|inbox\/[^/]+\/cover)/.test(req.path);
const skipRaw = (mw) => (req, res, next) => (rawBody(req) ? next() : mw(req, res, next));
app.use(skipRaw(express.json({ limit: '4mb', strict: false })));
app.use(skipRaw(express.urlencoded({ extended: false, limit: '64kb' })));
app.use(auth.attachUser);
app.use(auth.csrf);
app.use(auth.policy);

auth.register(app, { services });
services.register(app);
libraryRoutes.register(app);
uploads.register(app);
inbox.register(app);
downloads.register(app);
tools.register(app);
browse.register(app);
shares.register(app);
scrobbles.register(app);
lyrics.register(app);
artists.register(app);
links.register(app);
recognize.register(app);
federation.register(app);
webdav.register(app);
system.register(app);
transfer.register(app);
lookup.register(app);
navidromeDb.register(app);

app.use('/api', (_req, _res, next) => next(Object.assign(new Error('Not found'), { status: 404 })));

// The web app.
const dist = path.join(ROOT, 'web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, f) => /assets\//.test(f) && res.set('Cache-Control', 'public, max-age=31536000, immutable') }));
  const indexHtml = path.join(dist, 'index.html');
  app.get(/^\/(?!api\/|dav\/|share\/).*/, (_req, res) => res.sendFile(indexHtml));
} else {
  app.get('/', (_req, res) => res.type('text').send('The web app is not built yet. Run: pnpm build'));
}

// Errors: JSON for the API, plain for the rest.
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) log.error(`${req.method} ${req.originalUrl}:`, err.stack || err.message);
  if (res.headersSent) return res.end();
  const body = { error: status >= 500 && !err.status ? 'Something went wrong on the server. The details are in the logs.' : err.message, ...(err.extra || {}) };
  if (req.originalUrl.startsWith('/api') || req.accepts(['json', 'html']) === 'json') res.status(status).json(body);
  else res.status(status).type('text').send(body.error);
});

const server = app.listen(PORT, HOST, () => {
  log.info(`Master Music Manager ${VERSION} on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (data in ${DATA_DIR})`);
  for (const u of federation.lanUrls()) log.info(`  on your network: ${u}`);
  setTimeout(() => checkUpdate().catch(() => {}), 20_000);
});
server.requestTimeout = 0; // big uploads and archive downloads
server.headersTimeout = 65_000;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on('unhandledRejection', (e) => log.error('unhandled:', e?.stack || e));
