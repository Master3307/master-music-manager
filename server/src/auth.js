// Accounts and sessions.
// - Local accounts: scrypt password hashes, optional TOTP second factor.
// - Service accounts: log in with your Navidrome / Jellyfin / OpenSubsonic account
//   (only against servers an admin added; otherwise anyone could point us at a
//   server they control). Logging in this way gives you your own profile, so
//   your playlists, stars and shares are yours.
// - Discord OAuth, the same way HomeSite does it (state cookie, identify scope).
// Sessions: random token in an httpOnly SameSite=Lax cookie, stored as SHA-256.
// Mutations need the X-MMM header (forces a CORS preflight we never allow) and
// a same-site Origin.
import crypto from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { db, now, audit } from './db.js';
import * as settings from './settings.js';
import { hashPassword, verifyPassword, seal, unseal, sha256, token, uuid, safeEqual } from './lib/crypto.js';
import { httpError, json, str, limiter, bool } from './lib/http.js';
import { log } from './lib/log.js';

const COOKIE = 'mmm_session';
const STATE_COOKIE = 'mmm_oauth_state';
const loginLimit = limiter({ windowMs: 10 * 60_000, max: 20 });

export const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
export const adminCount = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    role: u.role,
    provider: u.provider,
    avatar: u.avatar,
    totp: Boolean(u.totp_secret),
    hasPassword: Boolean(u.password_hash),
    prefs: JSON.parse(u.prefs || '{}'),
    extraPerms: JSON.parse(u.perms || '[]'),
    createdAt: u.created_at,
    lastLogin: u.last_login,
  };
}

const ANON = Object.freeze({ id: null, username: 'guest', displayName: 'Guest', role: 'admin', anonymous: true, prefs: {} });
const GUEST = Object.freeze({ id: null, username: 'guest', displayName: 'Guest', role: 'guest', anonymous: true, guest: true, prefs: {} });

// ---- who may do what ----
// listen: browse, play, read stats · self: own account and settings · personal: own playlists,
// favorites, ratings, listens · share: make share links · download: files and exports ·
// manage: everything that changes the library or the server.
export const ROLE_PERMS = {
  admin: ['listen', 'self', 'personal', 'share', 'download', 'manage'],
  user: ['listen', 'self', 'personal', 'share'],
  visitor: ['listen', 'self'],
  guest: ['listen'],
};
export const ROLES = {
  admin: 'Owner rights: everything, including people and settings.',
  user: 'Own playlists, favorites and shares. Downloads only if allowed.',
  visitor: 'Listens and keeps personal settings. Nothing else.',
};
export function permsOf(user) {
  if (!user) return [];
  const base = ROLE_PERMS[user.role] || [];
  return [...new Set([...base, ...(user.extraPerms || [])])];
}
export const can = (user, perm) => perm === 'open' || permsOf(user).includes(perm);

const L = 'listen';
const RULES = [
  // [method regex, path regex, permission]
  [/.*/, /^\/api\/(auth\/|health$|plugin\/|fed\/)/, 'open'],
  [/.*/, /^\/api\/account\//, 'self'],
  [/^POST$/, /^\/api\/download-requests$/, 'self'],
  [/^GET$/, /^\/api\/(settings|profiles|library\/fields|themes|smart\/fields|editor\/ops|links\/|recognize\/providers|lyrics\/providers|export\/formats|downloads\/sources|update$|system$|events$|jobs|stats\/|scrobbles$|nodes\/catalog|radios|quickplay)/, L],
  [/^GET$/, /^\/api\/p\/[^/]+\/tracks\/[^/]+\/file/, 'download'],
  [/^GET$/, /^\/api\/export\//, 'download'],
  [/^POST$/, /^\/api\/p\/[^/]+\/export\//, 'download'],
  [/^GET$/, /^\/api\/p\/[^/]+\//, L],
  [/^POST$/, /^\/api\/p\/[^/]+\/(star|rate|scrobble|queue)$/, 'personal'],
  [/^(POST|PATCH|DELETE)$/, /^\/api\/p\/[^/]+\/playlists/, 'personal'],
  [/^(PUT|DELETE)$/, /^\/api\/p\/[^/]+\/image\/playlist\//, 'personal'],
  [/^POST$/, /^\/api\/p\/[^/]+\/smart\/preview$/, L],
  [/^GET$/, /^\/api\/shares$/, 'personal'],
  [/^(POST|PATCH|DELETE)$/, /^\/api\/shares/, 'share'],
  [/^POST$/, /^\/api\/lyrics\/(parse|search)$/, L],
  [/^GET$/, /^\/api\/lookup$/, 'manage'],
  [/^GET$/, /^\/api\/(inbox|trash|logs|audit|users|backup|startup|fs|detect|downloads\/tools|nodes|plugin)/, 'manage'],
];
export function neededPerm(req) {
  if (!req.path.startsWith('/api/')) return 'open';
  for (const [m, re, perm] of RULES) if (m.test(req.method) && re.test(req.path)) return perm;
  return 'manage';
}

/** One gate for every API call. */
export function policy(req, _res, next) {
  const need = neededPerm(req);
  if (need === 'open') return next();
  if (!req.user) return next(httpError(401, 'Please log in'));
  if (!can(req.user, need)) {
    const what = { download: 'Downloading needs permission from an admin (Settings → Account → ask for downloads).', manage: 'Only admins can change this.', personal: 'Log in to save playlists, favorites and listens.', share: 'Log in to share.', self: 'Log in first.' }[need];
    return next(httpError(req.user.guest ? 401 : 403, what || 'Not allowed'));
  }
  next();
}

function cookieOpts(req, maxAge) {
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge };
}

export function createSession(req, res, user) {
  const raw = token();
  const days = settings.get('auth').sessionDays || 30;
  const maxAge = days * 86400_000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sha256(raw),
    user.id,
    now(),
    now() + maxAge,
    now(),
    str(req.headers['user-agent'], 300),
    req.ip,
  );
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), user.id);
  res.cookie(COOKIE, raw, cookieOpts(req, maxAge));
}

function sessionUser(raw) {
  if (!raw) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(raw));
  if (!s) return null;
  if (s.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash);
    return null;
  }
  // Sliding expiry, written at most once an hour.
  if (now() - s.last_seen > 3600_000) {
    const days = settings.get('auth').sessionDays || 30;
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(now(), now() + days * 86400_000, s.token_hash);
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  return u ? { ...publicUser(u), sessionHash: s.token_hash } : null;
}

// The `mmm` command on this machine: a token in the data folder, only from loopback.
import fs from 'node:fs';
import { PATHS } from './config.js';
const CLI_TOKEN_FILE = `${PATHS.data}/cli.token`;
if (!fs.existsSync(CLI_TOKEN_FILE)) fs.writeFileSync(CLI_TOKEN_FILE, token(32), { mode: 0o600 });
const CLI_TOKEN = fs.readFileSync(CLI_TOKEN_FILE, 'utf8').trim();
const CLI_USER = Object.freeze({ id: null, username: 'mmm-cli', displayName: 'Command line', role: 'admin', prefs: {} });
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

// Before the first admin exists, the app is wide open; only allow that from
// this machine or the local network, never through a public tunnel or proxy.
import { isPrivate } from './lib/net.js';
// A one-time code proves you have access to the machine (shown by `mmm setup-code`
// and in the log), so the first admin can be made from anywhere.
const SETUP_FILE = `${PATHS.data}/setup-code`;
function setupCode() {
  if (adminCount() > 0) {
    fs.rmSync(SETUP_FILE, { force: true });
    return null;
  }
  if (!fs.existsSync(SETUP_FILE)) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
    fs.writeFileSync(SETUP_FILE, `${code.slice(0, 4)}-${code.slice(4)}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(SETUP_FILE, 'utf8').trim();
}
export function announceSetupCode() {
  const c = setupCode();
  if (c) log.info(`Not set up yet. To create the admin through the internet, use the setup code ${c} (also: mmm setup-code).`);
}
const codeOk = (req) => {
  const c = setupCode();
  const got = String(req.get('x-mmm-setup-code') || req.body?.setupCode || '').trim().toUpperCase().replace(/\s/g, '');
  return Boolean(c && got && safeEqual(got.replace(/-/g, ''), c.replace(/-/g, '')));
};
const fromLan = (req) => {
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  return isLoopback(req.ip) || ip === '127.0.0.1' || isPrivate(ip);
};

/** Attach req.user. Without required auth, visitors act as an admin "guest". */
export function attachUser(req, _res, next) {
  const cli = req.get('x-mmm-cli');
  if (cli && isLoopback(req.socket.remoteAddress) && safeEqual(cli, CLI_TOKEN)) {
    req.user = CLI_USER;
    return next();
  }
  const user = sessionUser(req.cookies?.[COOKIE]);
  const a = settings.get('auth');
  if (user) req.user = user;
  else if (!a.required && (adminCount() > 0 || fromLan(req))) req.user = ANON;
  else if (!a.required) req.user = null; // open mode, but not for the internet before setup
  else if (a.guestAccess === 'listen') req.user = GUEST;
  next();
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Please log in'));
  next();
}
export function requireAdmin(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Please log in'));
  if (req.user.role !== 'admin') return next(httpError(403, 'Only admins can do this'));
  next();
}

/** CSRF: mutations need our header and, when the browser sends one, a matching Origin. */
export function csrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/plugin/') || req.path.startsWith('/s/')) return next(); // token-authenticated
  if (req.get('x-mmm') !== '1') return next(httpError(403, 'Missing request header'));
  const origin = req.get('origin');
  if (origin) {
    try {
      const o = new URL(origin);
      const host = req.get('x-forwarded-host') || req.get('host');
      if (o.host !== host) return next(httpError(403, 'Cross-site request refused'));
    } catch {
      return next(httpError(403, 'Bad origin'));
    }
  }
  next();
}

function checkTotp(user, code) {
  if (!user.totp_secret) return true;
  const secret = unseal(user.totp_secret);
  if (!secret) return false;
  const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
  return totp.validate({ token: String(code || '').replace(/\s/g, ''), window: 1 }) !== null;
}

export function findOrCreateUser({ provider, ref, username, displayName, avatar, role }) {
  let u = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_ref = ?').get(provider, ref);
  if (!u) {
    let name = username;
    for (let i = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(name); i++) name = `${username}${i}`;
    const id = uuid();
    // The very first account is always an admin.
    const finalRole = userCount() === 0 ? 'admin' : role || 'user';
    db.prepare('INSERT INTO users (id, username, display_name, role, provider, provider_ref, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      name,
      displayName || username,
      finalRole,
      provider,
      ref,
      avatar || null,
      now(),
    );
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    audit(id, 'user.create', { provider, username: name });
  } else if (avatar || displayName) {
    db.prepare('UPDATE users SET avatar = COALESCE(?, avatar), display_name = COALESCE(?, display_name) WHERE id = ?').run(avatar || null, displayName || null, u.id);
  }
  return u;
}

export function register(app, { services }) {
  app.get(
    '/api/auth/me',
    json((req) => {
      const a = settings.get('auth');
      return {
        user: req.user && !req.user.anonymous ? req.user : null,
        guest: req.user?.anonymous || false,
        setupFromLanOnly: adminCount() === 0 && !fromLan(req),
        setupNeedsCode: adminCount() === 0 && !fromLan(req),
        listenOnly: Boolean(req.user?.guest),
        perms: permsOf(req.user),
        role: req.user?.role || null,
        roles: ROLES,
        required: a.required,
        needsAdmin: adminCount() === 0,
        methods: {
          local: a.allowLocal,
          discord: Boolean(a.discord.enabled && a.discord.clientId && a.discord.clientSecret),
          services: a.allowService
            ? db
                .prepare("SELECT id, name, kind, url FROM profiles WHERE kind != 'local' AND owner_id IS NULL ORDER BY sort, created_at")
                .all()
                .map((p) => ({ id: p.id, name: p.name, kind: p.kind, host: safeHost(p.url) }))
            : [],
        },
      };
    }),
  );

  app.post(
    '/api/auth/setup-code',
    json((req) => {
      if (!loginLimit(req.ip)) throw httpError(429, 'Too many attempts. Wait a few minutes.');
      if (adminCount() > 0) throw httpError(409, 'Already set up');
      if (!codeOk(req)) throw httpError(401, 'That code is not right. Get it with: mmm setup-code');
      return { ok: true };
    }),
  );

  // First admin. Only possible while no admin exists.
  app.post(
    '/api/auth/setup-admin',
    json(async (req, res) => {
      if (adminCount() > 0) throw httpError(409, 'An admin already exists');
      if (!fromLan(req) && !codeOk(req)) throw httpError(403, 'Enter the setup code. Get it on the server with: mmm setup-code');
      const username = str(req.body.username, 64).trim();
      const password = str(req.body.password, 256);
      if (!/^[\w.@-]{2,64}$/.test(username)) throw httpError(400, 'Use 2-64 letters, numbers, dots, dashes or underscores');
      if (password.length < 8) throw httpError(400, 'The password needs at least 8 characters');
      const id = uuid();
      db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, provider, created_at) VALUES (?, ?, ?, ?, 'admin', 'local', ?)").run(
        id,
        username,
        str(req.body.displayName, 64) || username,
        await hashPassword(password),
        now(),
      );
      if (req.body.requireLogin !== false) settings.set('auth', { required: true });
      fs.rmSync(SETUP_FILE, { force: true }); // used up
      audit(id, 'user.create-admin', { username });
      createSession(req, res, { id });
      return { ok: true };
    }),
  );

  app.post(
    '/api/auth/login',
    json(async (req, res) => {
      if (!loginLimit(req.ip)) throw httpError(429, 'Too many attempts. Wait a few minutes.');
      if (!settings.get('auth').allowLocal) throw httpError(403, 'Local accounts are switched off');
      const u = db.prepare("SELECT * FROM users WHERE username = ? AND provider = 'local'").get(str(req.body.username, 64).trim());
      const ok = u?.password_hash && (await verifyPassword(str(req.body.password, 256), u.password_hash));
      if (!ok) throw httpError(401, 'Wrong username or password');
      if (u.totp_secret) {
        if (!req.body.code) return { needsCode: true };
        if (!checkTotp(u, req.body.code)) throw httpError(401, 'That code is not right (or expired)');
      }
      createSession(req, res, u);
      audit(u.id, 'login', { method: 'local' });
      return { ok: true };
    }),
  );

  // Log in with a Navidrome / Jellyfin / OpenSubsonic account.
  app.post(
    '/api/auth/service-login',
    json(async (req, res) => {
      if (!loginLimit(req.ip)) throw httpError(429, 'Too many attempts. Wait a few minutes.');
      const a = settings.get('auth');
      if (!a.allowService) throw httpError(403, 'Service logins are switched off');
      const base = db.prepare("SELECT * FROM profiles WHERE id = ? AND owner_id IS NULL AND kind != 'local'").get(str(req.body.profileId, 64));
      if (!base) throw httpError(404, 'Unknown server');
      const username = str(req.body.username, 128).trim();
      const password = str(req.body.password, 512);
      if (!username || !password) throw httpError(400, 'Enter your username and password');
      let identity;
      try {
        identity = await services.verifyLogin(base, username, password);
      } catch (e) {
        throw httpError(e.offline ? 503 : 401, e.offline ? `${base.name} can't be reached right now` : e.message || 'Login refused by the server');
      }
      const provider = `service:${base.id}`;
      const u = findOrCreateUser({
        provider,
        ref: identity.id || username.toLowerCase(),
        username,
        displayName: identity.name || username,
        role: identity.admin && a.serviceRole === 'mirror' ? 'admin' : a.serviceRole === 'admin' ? 'admin' : 'user',
      });
      // The person's own profile on that server, sharing the admin's folder link.
      const own = db.prepare('SELECT id FROM profiles WHERE owner_id = ? AND url = ?').get(u.id, base.url);
      const secret = seal(identity.secret ?? password);
      if (own) db.prepare('UPDATE profiles SET username = ?, secret = ?, user_id = ? WHERE id = ?').run(username, secret, identity.userId ?? null, own.id);
      else
        db.prepare(
          'INSERT INTO profiles (id, name, kind, url, public_url, username, secret, user_id, local_path, link_checked_at, link_score, options, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          uuid(),
          `${base.name} (${username})`,
          base.kind,
          base.url,
          base.public_url,
          username,
          secret,
          identity.userId ?? null,
          base.local_path,
          base.link_checked_at,
          base.link_score,
          base.options,
          u.id,
          now(),
        );
      createSession(req, res, u);
      audit(u.id, 'login', { method: provider });
      return { ok: true };
    }),
  );

  app.post(
    '/api/auth/logout',
    json((req, res) => {
      const raw = req.cookies?.[COOKIE];
      if (raw) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(raw));
      res.clearCookie(COOKIE, cookieOpts(req));
      return { ok: true };
    }),
  );

  // ---- Discord (as on HomeSite) ----
  app.get('/api/auth/discord', (req, res) => {
    const d = settings.get('auth').discord;
    if (!d.enabled || !d.clientId) return res.redirect('/login?error=discord-off');
    const state = token(24);
    res.cookie(STATE_COOKIE, state, { ...cookieOpts(req, 10 * 60_000) });
    const q = new URLSearchParams({ client_id: d.clientId, response_type: 'code', redirect_uri: discordRedirect(req), scope: 'identify', state, prompt: 'none' });
    res.redirect(`https://discord.com/oauth2/authorize?${q}`);
  });

  app.get('/api/auth/discord/callback', async (req, res) => {
    const d = settings.get('auth').discord;
    const expected = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, cookieOpts(req));
    if (!req.query.code || !safeEqual(expected, req.query.state)) return res.redirect('/login?error=state');
    try {
      const t = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: d.clientId,
          client_secret: d.clientSecret,
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: discordRedirect(req),
        }),
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.json());
      if (!t.access_token) throw new Error(t.error_description || 'No token');
      const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(10000) }).then((r) =>
        r.json(),
      );
      const allowed = splitIds(d.allowedIds);
      const admins = splitIds(d.adminIds);
      if (allowed.length && !allowed.includes(me.id) && !admins.includes(me.id)) return res.redirect('/login?error=not-allowed');
      const u = findOrCreateUser({
        provider: 'discord',
        ref: me.id,
        username: me.username,
        displayName: me.global_name || me.username,
        avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : null,
        role: admins.includes(me.id) ? 'admin' : 'user',
      });
      if (admins.includes(me.id) && u.role !== 'admin') db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
      createSession(req, res, u);
      audit(u.id, 'login', { method: 'discord' });
      res.redirect('/');
    } catch (e) {
      log.warn('discord login failed:', e.message);
      res.redirect('/login?error=discord');
    }
  });

  // ---- Own account ----
  app.post(
    '/api/account/password',
    requireUser,
    json(async (req) => {
      if (req.user.anonymous) throw httpError(400, 'Log in first');
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (u.password_hash && !(await verifyPassword(str(req.body.current, 256), u.password_hash))) throw httpError(401, 'The current password is wrong');
      const next = str(req.body.password, 256);
      if (next.length < 8) throw httpError(400, 'The password needs at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, req.user.sessionHash);
      audit(u.id, 'password.change');
      return { ok: true };
    }),
  );

  app.post(
    '/api/account/totp/start',
    requireUser,
    json((req) => {
      if (req.user.anonymous) throw httpError(400, 'Log in first');
      const secret = new Secret({ size: 20 });
      const totp = new TOTP({ issuer: 'Master Music Manager', label: req.user.username, secret, digits: 6, period: 30 });
      return { secret: secret.base32, uri: totp.toString() };
    }),
  );
  app.post(
    '/api/account/totp/enable',
    requireUser,
    json((req) => {
      const secret = str(req.body.secret, 64);
      const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
      if (totp.validate({ token: str(req.body.code, 10).replace(/\s/g, ''), window: 1 }) === null) throw httpError(400, 'That code is not right. Check the time on your phone.');
      db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(seal(secret), req.user.id);
      audit(req.user.id, 'totp.enable');
      return { ok: true };
    }),
  );
  app.post(
    '/api/account/totp/disable',
    requireUser,
    json((req) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!checkTotp(u, req.body.code)) throw httpError(401, 'That code is not right');
      db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ?').run(u.id);
      audit(u.id, 'totp.disable');
      return { ok: true };
    }),
  );
  app.put(
    '/api/account/prefs',
    requireUser,
    json((req) => {
      if (req.user.anonymous) return { ok: true };
      const prefs = { ...req.user.prefs, ...(req.body || {}) };
      const s = JSON.stringify(prefs);
      if (s.length > 200_000) throw httpError(413, 'Preferences are too large');
      db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(s, req.user.id);
      return { ok: true, prefs };
    }),
  );
  app.get(
    '/api/account/sessions',
    requireUser,
    json((req) =>
      db
        .prepare('SELECT token_hash, created_at, last_seen, user_agent, ip FROM sessions WHERE user_id = ? ORDER BY last_seen DESC')
        .all(req.user.id)
        .map((s) => ({ id: s.token_hash.slice(0, 16), current: s.token_hash === req.user.sessionHash, createdAt: s.created_at, lastSeen: s.last_seen, userAgent: s.user_agent, ip: s.ip })),
    ),
  );
  app.delete(
    '/api/account/sessions/:id',
    requireUser,
    json((req) => {
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?").run(req.user.id, str(req.params.id, 16));
      return { ok: true };
    }),
  );

  // ---- asking an admin for download permission ----
  app.post(
    '/api/download-requests',
    requireUser,
    json((req) => {
      if (req.user.anonymous) throw httpError(401, 'Log in first');
      if (can(req.user, 'download')) return { ok: true, already: true };
      if (db.prepare("SELECT 1 FROM download_requests WHERE user_id = ? AND status = 'open'").get(req.user.id)) return { ok: true, pending: true };
      db.prepare('INSERT INTO download_requests (id, user_id, note, created_at) VALUES (?, ?, ?, ?)').run(uuid(), req.user.id, str(req.body.note, 500) || null, now());
      audit(req.user.id, 'download.request');
      return { ok: true, pending: true };
    }),
  );
  app.get(
    '/api/account/download-request',
    requireUser,
    json((req) => db.prepare('SELECT status, created_at, decided_at FROM download_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id) || null),
  );
  app.get(
    '/api/download-requests',
    requireAdmin,
    json(() => db.prepare("SELECT r.*, u.username, u.display_name FROM download_requests r JOIN users u ON u.id = r.user_id WHERE r.status = 'open' ORDER BY r.created_at").all()),
  );
  app.post(
    '/api/download-requests/:id',
    requireAdmin,
    json((req) => {
      const r = db.prepare('SELECT * FROM download_requests WHERE id = ?').get(req.params.id);
      if (!r) throw httpError(404, 'No such request');
      const ok = bool(req.body.approve);
      db.prepare('UPDATE download_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(ok ? 'approved' : 'declined', req.user.id, now(), r.id);
      if (ok) {
        const u = db.prepare('SELECT perms FROM users WHERE id = ?').get(r.user_id);
        const perms = new Set(JSON.parse(u?.perms || '[]'));
        perms.add('download');
        db.prepare('UPDATE users SET perms = ? WHERE id = ?').run(JSON.stringify([...perms]), r.user_id);
      }
      audit(req.user.id, ok ? 'download.approve' : 'download.decline', { user: r.user_id });
      return { ok: true };
    }),
  );

  // ---- Admin: users ----
  app.get('/api/users', requireAdmin, json(() => db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser)));
  app.post(
    '/api/users',
    requireAdmin,
    json(async (req) => {
      const username = str(req.body.username, 64).trim();
      if (!/^[\w.@-]{2,64}$/.test(username)) throw httpError(400, 'Use 2-64 letters, numbers, dots, dashes or underscores');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw httpError(409, 'That username is taken');
      const password = str(req.body.password, 256);
      if (password.length < 8) throw httpError(400, 'The password needs at least 8 characters');
      const id = uuid();
      db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, provider, created_at) VALUES (?, ?, ?, ?, ?, 'local', ?)").run(
        id,
        username,
        str(req.body.displayName, 64) || username,
        await hashPassword(password),
        ROLES[req.body.role] ? req.body.role : 'user',
        now(),
      );
      audit(req.user.id, 'user.create', { username });
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    }),
  );
  app.patch(
    '/api/users/:id',
    requireAdmin,
    json(async (req) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      if (!u) throw httpError(404, 'No such user');
      if (req.body.role && req.body.role !== u.role) {
        if (u.role === 'admin' && adminCount() === 1) throw httpError(400, 'There must be at least one admin');
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(ROLES[req.body.role] ? req.body.role : 'user', u.id);
      }
      if (req.body.password) {
        if (String(req.body.password).length < 8) throw httpError(400, 'The password needs at least 8 characters');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      }
      if (Array.isArray(req.body.extraPerms)) db.prepare('UPDATE users SET perms = ? WHERE id = ?').run(JSON.stringify(req.body.extraPerms.filter((x) => ['download', 'share', 'personal'].includes(x))), u.id);
      if (req.body.resetTotp) db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ?').run(u.id);
      if (req.body.displayName !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(str(req.body.displayName, 64), u.id);
      audit(req.user.id, 'user.update', { id: u.id });
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id));
    }),
  );
  app.delete(
    '/api/users/:id',
    requireAdmin,
    json((req) => {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      if (!u) throw httpError(404, 'No such user');
      if (u.role === 'admin' && adminCount() === 1) throw httpError(400, 'There must be at least one admin');
      db.prepare('DELETE FROM profiles WHERE owner_id = ?').run(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      audit(req.user.id, 'user.delete', { username: u.username });
      return { ok: true };
    }),
  );
}

function splitIds(s) {
  return String(s || '')
    .split(/[\s,;]+/)
    .filter(Boolean);
}
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
function discordRedirect(req) {
  const pub = settings.get('public').url;
  const base = pub ? pub.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
  return `${base}/api/auth/discord/callback`;
}
