// Applies the look: light/dark, theme colours, accent, density, radius,
// graphics, animations, custom CSS themes and the global CSS.
import { store } from './util.js';

let themes = [];
export const setThemes = (t) => {
  themes = t;
};

export function resolvedMode(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ink(hex) {
  const m = String(hex).replace('#', '').match(/.{2}/g);
  if (!m) return '#fff';
  const [r, g, b] = m.map((x) => Number.parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#15121f' : '#ffffff';
}

/** CSS variables for a theme in a mode (used by the app and by previews). */
export function themeVars(themeId, mode, accent, list = themes) {
  const th = list.find((t) => t.id === themeId) || list[0];
  if (!th) return {};
  const base = th[mode] || th.dark || th.light;
  const a = accent || th.accent || '#8b5cf6';
  return { ...Object.fromEntries(Object.entries(base).map(([k, v]) => [`--${k}`, v])), '--accent': a, '--accent-ink': ink(a), modeUsed: th[mode] ? mode : th.dark ? 'dark' : 'light' };
}

export function applyAppearance(a) {
  if (!a) return;
  const root = document.documentElement;
  const custom = (a.customThemes || []).find((t) => t.id === a.theme);
  const themeId = custom ? custom.base || 'midnight' : a.theme;
  const wanted = resolvedMode(a.mode);
  const vars = themeVars(themeId, wanted, a.accent);
  const { modeUsed, ...cssVars } = vars;
  for (const [k, v] of Object.entries(cssVars)) root.style.setProperty(k, v);
  root.style.setProperty('--radius', `${a.radius ?? 12}px`);
  root.dataset.mode = modeUsed || wanted;
  root.dataset.graphics = a.graphics === false ? 'off' : 'on';
  root.dataset.animations = a.animations === false ? 'off' : 'on';
  root.dataset.density = a.density || 'comfortable';
  store.set('mode', a.mode);
  // The app's own colour wins over the light/dark defaults in index.html (both tags).
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', cssVars['--bg'] || '#14131c');
  setStyle('mmm-theme-css', custom?.css || '');
  setStyle('mmm-global-css', a.globalCss || '');
}

function setStyle(id, css) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.append(el);
  }
  // Global CSS goes last so it always wins.
  if (id === 'mmm-global-css') document.head.append(el);
  el.textContent = css;
}

/** A small, self-contained HTML document that shows how a theme looks. */
export function previewDoc({ themeId, mode, accent, css = '', globalCss = '', list = themes }) {
  const { modeUsed, ...v } = themeVars(themeId, mode, accent, list);
  const vars = Object.entries(v)
    .map(([k, x]) => `${k}:${x}`)
    .join(';');
  return `<!doctype html><html data-mode="${modeUsed}"><head><style>
:root{${vars};--radius:10px;font:12px/1.4 system-ui,sans-serif}
body{margin:0;background:var(--bg);color:var(--text);height:100vh;display:grid;grid-template-columns:28px 1fr 54px;overflow:hidden}
.r{background:var(--bg-2);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:6px;padding:8px 6px}.r i{height:12px;border-radius:4px;background:var(--surface-2)}.r i.a{background:var(--accent)}
.m{padding:8px}.h{font-weight:700;font-size:13px;margin-bottom:6px}.row{display:flex;gap:6px;align-items:center;padding:4px;border-radius:6px}.row.s{background:color-mix(in oklab,var(--accent) 18%,transparent)}
.c{width:18px;height:18px;border-radius:4px;background:linear-gradient(135deg,var(--accent),var(--surface-2))}.t{flex:1}.t b{display:block;font-weight:600}.t s{color:var(--text-2);text-decoration:none;font-size:10px}
.d{background:var(--bg-2);border-left:1px solid var(--line);padding:6px;display:flex;flex-direction:column;gap:5px;align-items:center}.art{width:40px;height:40px;border-radius:7px;background:linear-gradient(135deg,var(--accent),var(--surface))}.p{width:18px;height:18px;border-radius:50%;background:var(--accent)}
.btn{display:inline-block;padding:3px 8px;border-radius:99px;background:var(--accent);color:var(--accent-ink);font-weight:600;font-size:10px}
</style><style>${css}</style><style>${globalCss}</style></head><body>
<div class="r"><i class="a"></i><i></i><i></i><i></i></div>
<div class="m app"><div class="h">Library</div>
<div class="row s"><span class="c"></span><span class="t"><b>Selected song</b><s>Artist</s></span></div>
<div class="row"><span class="c"></span><span class="t"><b>Another song</b><s>Someone</s></span></div>
<div class="row"><span class="c"></span><span class="t"><b>One more</b><s>Band</s></span></div>
<span class="btn">Import</span></div>
<div class="d deck"><div class="art"></div><div class="p"></div></div>
</body></html>`;
}
