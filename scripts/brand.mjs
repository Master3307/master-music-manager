// pnpm brand: draws every logo, icon, the GitHub social card and the README
// banner from code (one source: the waveform "M"), then renders PNGs with
// headless Chromium so the type is the app's own font (Onest).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'brand');
const PUB = path.join(ROOT, 'web/public');
fs.mkdirSync(OUT, { recursive: true });

const ACCENT = { hi: '#a78bfa', mid: '#8b5cf6', lo: '#5b21b6' };
const INK = '#ecebf5';
const BG = '#14131c';
const M_PATH = 'M15 43V23.5c0-2.2 2.6-3.3 4.2-1.8L32 34.5l12.8-12.8c1.6-1.5 4.2-.4 4.2 1.8V43';
const TILE = 'M32 2C52 2 62 12 62 32S52 62 32 62 2 52 2 32 12 2 32 2Z';

function mark({ size = 64, pad = 0, bg = true } = {}) {
  const s = 64 + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-pad} ${-pad} ${s} ${s}">
<defs><linearGradient id="bg" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${ACCENT.hi}"/><stop offset=".55" stop-color="${ACCENT.mid}"/><stop offset="1" stop-color="${ACCENT.lo}"/></linearGradient>
<linearGradient id="gl" x1="32" y1="0" x2="32" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
${bg === 'square' ? `<rect x="${-pad}" y="${-pad}" width="${s}" height="${s}" fill="url(#bg)"/>` : bg ? `<path d="${TILE}" fill="url(#bg)"/><path d="${TILE}" fill="url(#gl)"/>` : ''}
<path d="${M_PATH}" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="45.5" r="3.6" fill="#fff"/></svg>`;
}

/** A waveform line, seeded so it looks the same every build. */
function wave(width, height, { seed = 7, bars = 160, amp = 0.42 } = {}) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const mid = height / 2;
  const pts = [];
  for (let i = 0; i <= bars; i++) {
    const t = i / bars;
    // Louder in the middle, like a song.
    const env = Math.sin(Math.PI * t) ** 0.6 * (0.55 + 0.45 * Math.sin(t * 9));
    const a = (rnd() * 0.8 + 0.2) * env * amp * height;
    pts.push([t * width, mid - (i % 2 ? a : -a)]);
  }
  return `M${pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')}`;
}

const fontCss = () => {
  const dir = path.join(ROOT, 'node_modules/@fontsource-variable/onest/files');
  const f = fs.readdirSync(dir).find((n) => /latin-wght-normal\.woff2$/.test(n));
  return `@font-face{font-family:Onest;font-weight:100 900;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}) format('woff2')}`;
};

function card(w, h, { tagline, small }) {
  const waveH = h * 0.42;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss()}
*{margin:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;overflow:hidden}
body{background:${BG};font-family:Onest,sans-serif;color:${INK};position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(${w * 0.5}px ${h * 0.7}px at 82% 18%,rgba(139,92,246,.30),transparent 70%),radial-gradient(${w * 0.4}px ${h * 0.6}px at 8% 100%,rgba(91,33,182,.28),transparent 70%)}
.wave{position:absolute;left:0;right:0;bottom:${h * 0.06}px;height:${waveH}px}
.top{position:absolute;left:${w * 0.07}px;top:${h * (small ? 0.2 : 0.16)}px;display:flex;align-items:center;gap:${h * 0.06}px}
h1{font-size:${h * (small ? 0.16 : 0.13)}px;font-weight:800;letter-spacing:-.035em;line-height:.95;background:linear-gradient(100deg,${INK} 35%,#c4b5fd);-webkit-background-clip:text;color:transparent;padding-bottom:.06em}
p{margin-top:${h * 0.025}px;font-size:${h * (small ? 0.05 : 0.042)}px;color:#a9a7bd;font-weight:500;max-width:${w * 0.6}px}
.tags{position:absolute;right:${w * 0.06}px;top:${h * 0.09}px;display:flex;gap:10px}
.tags span{font-size:${h * 0.028}px;font-weight:600;color:#c9c6dc;padding:.45em 1em;border-radius:99px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08)}
</style></head><body><div class="glow"></div>
<svg class="wave" viewBox="0 0 ${w} ${waveH}" preserveAspectRatio="none"><defs><linearGradient id="wg" x1="0" x2="1"><stop offset="0" stop-color="${ACCENT.lo}" stop-opacity="0"/><stop offset=".25" stop-color="${ACCENT.mid}"/><stop offset=".75" stop-color="${ACCENT.hi}"/><stop offset="1" stop-color="${ACCENT.hi}" stop-opacity="0"/></linearGradient></defs>
<path d="${wave(w, waveH, { bars: Math.round(w / 9) })}" fill="none" stroke="url(#wg)" stroke-width="${Math.max(2, h * 0.006)}" stroke-linejoin="round" opacity=".9"/></svg>
${small ? '' : '<div class="tags"><span>Navidrome</span><span>Jellyfin</span><span>OpenSubsonic</span><span>Local folders</span></div>'}
<div class="top">${mark({ size: Math.round(h * (small ? 0.34 : 0.26)) })}<div><h1>Master Music<br>Manager</h1><p>${tagline}</p></div></div>
</body></html>`;
}

function shoot(html, out, w, h) {
  const file = path.join(OUT, `.tmp-${path.basename(out)}.html`);
  fs.writeFileSync(file, html);
  execFileSync('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${w},${h}`, '--default-background-color=00000000', `--screenshot=${out}`, `file://${file}`], { stdio: 'ignore', timeout: 60000 });
  fs.rmSync(file);
}

// SVGs
fs.writeFileSync(path.join(OUT, 'mark.svg'), mark());
fs.writeFileSync(path.join(PUB, 'favicon.svg'), mark());
fs.writeFileSync(path.join(OUT, 'mark-mono.svg'), mark({ bg: false }).replace(/#fff/g, 'currentColor'));
fs.writeFileSync(
  path.join(OUT, 'logo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="72" viewBox="0 0 420 72"><g transform="translate(4 4)">${mark({ size: 64 }).replace(/<\/?svg[^>]*>/g, '')}</g><text x="84" y="34" font-family="Onest, Inter, system-ui, sans-serif" font-weight="800" font-size="27" letter-spacing="-0.6" fill="${INK}">Master Music</text><text x="84" y="61" font-family="Onest, Inter, system-ui, sans-serif" font-weight="500" font-size="20" fill="#a9a7bd">Manager</text></svg>`,
);

// PNG icons
const iconHtml = (size, opts) => `<!doctype html><html><body style="margin:0;background:transparent">${mark({ size, ...opts })}</body></html>`;
for (const [name, size, opts] of [
  ['favicon-16.png', 16, {}],
  ['favicon-32.png', 32, {}],
  ['favicon-48.png', 48, {}],
  ['apple-touch-icon.png', 180, { bg: 'square', pad: 10 }],
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { bg: 'square', pad: 22 }],
]) shoot(iconHtml(size, opts), path.join(PUB, name), size, size);
fs.copyFileSync(path.join(PUB, 'icon-512.png'), path.join(OUT, 'icon-512.png'));

// Every size phones, tablets and desktops ask for when installing the app.
const ICONS = path.join(PUB, 'icons');
fs.mkdirSync(ICONS, { recursive: true });
const SIZES = [48, 72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512];
for (const size of SIZES) shoot(iconHtml(size, {}), path.join(ICONS, `icon-${size}.png`), size, size);
// Maskable: the system cuts its own shape (circle, squircle …), so the mark sits in the safe middle.
for (const size of [192, 512]) shoot(iconHtml(size, { bg: 'square', pad: 22 }), path.join(ICONS, `maskable-${size}.png`), size, size);
// Monochrome (Android themed icons): only the shape counts.
shoot(`<!doctype html><html><body style="margin:0;background:transparent">${mark({ size: 512, bg: false }).replace(/#fff/g, '#ffffff')}</body></html>`, path.join(ICONS, 'monochrome-512.png'), 512, 512);
// Shortcut icons: the accent tile with a simple sign.
const GLYPHS = {
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  add: 'M12 5v14M5 12h14',
  library: 'M4 4v16M9 4v16M14 4l6 16',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
};
for (const [name, d] of Object.entries(GLYPHS))
  shoot(
    `<!doctype html><html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ACCENT.hi}"/><stop offset="1" stop-color="${ACCENT.lo}"/></linearGradient></defs><rect width="96" height="96" rx="24" fill="url(#g)"/><g transform="translate(24 24) scale(2)"><path d="${d}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g></svg></body></html>`,
    path.join(ICONS, `shortcut-${name}.png`),
    96,
    96,
  );
// Windows start-menu tile.
fs.writeFileSync(path.join(PUB, 'browserconfig.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<browserconfig><msapplication><tile><square150x150logo src="/icons/icon-144.png"/><TileColor>${BG}</TileColor></tile></msapplication></browserconfig>\n`);

// Cards
shoot(card(1280, 640, { tagline: 'Tag, sort, find duplicates, download, play and share your music library.' }), path.join(OUT, 'social-card.png'), 1280, 640);
shoot(card(1600, 480, { tagline: 'A cheat tool for your music library.', small: true }), path.join(OUT, 'banner.png'), 1600, 480);

// The web app manifest: what phones and computers show when installing it.
const icon = (src, size, purpose) => ({ src, sizes: `${size}x${size}`, type: 'image/png', ...(purpose ? { purpose } : {}) });
fs.writeFileSync(
  path.join(PUB, 'site.webmanifest'),
  JSON.stringify(
    {
      id: '/',
      name: 'Master Music Manager',
      short_name: 'Music Manager',
      description: 'Manage, tag, play and share your music library: Navidrome, Jellyfin, OpenSubsonic or just a folder. Downloads, duplicates, covers, lyrics and stats.',
      lang: 'en',
      dir: 'ltr',
      start_url: '/?from=app',
      scope: '/',
      display: 'standalone',
      display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
      orientation: 'any',
      background_color: BG,
      theme_color: BG,
      categories: ['music', 'entertainment', 'utilities'],
      prefer_related_applications: false,
      launch_handler: { client_mode: ['focus-existing', 'auto'] },
      icons: [...SIZES.map((n) => icon(`/icons/icon-${n}.png`, n, 'any')), icon('/icons/maskable-192.png', 192, 'maskable'), icon('/icons/maskable-512.png', 512, 'maskable'), icon('/icons/monochrome-512.png', 512, 'monochrome')],
      shortcuts: [
        { name: 'Shuffle everything', short_name: 'Shuffle', url: '/?do=shuffle', icons: [icon('/icons/shortcut-shuffle.png', 96)] },
        { name: 'Add music', short_name: 'Add', url: '/add', icons: [icon('/icons/shortcut-add.png', 96)] },
        { name: 'Library', url: '/library', icons: [icon('/icons/shortcut-library.png', 96)] },
        { name: 'Stats', url: '/stats', icons: [icon('/icons/shortcut-stats.png', 96)] },
      ],
      // Share a link (YouTube, Spotify …) from another app straight into "Add music".
      share_target: { action: '/add', method: 'GET', enctype: 'application/x-www-form-urlencoded', params: { title: 'title', text: 'text', url: 'url' } },
    },
    null,
    2,
  ),
);
console.log('Brand assets written to brand/ and web/public/');
