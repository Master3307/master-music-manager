import { useMemo, useRef } from 'react';

// A small code editor: line numbers, Tab / Shift+Tab indent, colours.
function highlight(css) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return esc(css)
    .replace(/(\/\*[\s\S]*?\*\/)/g, '\u0001c$1\u0002')
    .replace(/("[^"\n]*"|'[^'\n]*')/g, '\u0001s$1\u0002')
    .replace(/(@[\w-]+)/g, '\u0001a$1\u0002')
    .replace(/(--[\w-]+|[\w-]+)(\s*:)(?![^{]*\{)/g, '\u0001p$1\u0002$2')
    .replace(/(#[0-9a-fA-F]{3,8}\b|\b\d+(\.\d+)?(px|rem|em|%|s|ms|deg|vh|vw)?\b)/g, '\u0001n$1\u0002')
    .replace(/\u0001(\w)([\s\S]*?)\u0002/g, (_, k, t) => `<span class="hl-${k}">${t.replace(/\u0001\w|\u0002/g, '')}</span>`);
}

export function CssEditor({ value, onChange, rows = 18, placeholder }) {
  const ta = useRef(null);
  const pre = useRef(null);
  const nums = useRef(null);
  const lines = (value || '').split('\n').length;
  const html = useMemo(() => `${highlight(value || '')}\n`, [value]);
  const sync = () => {
    pre.current.scrollTop = ta.current.scrollTop;
    pre.current.scrollLeft = ta.current.scrollLeft;
    nums.current.scrollTop = ta.current.scrollTop;
  };
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = el;
    const v = value || '';
    const lineStart = v.lastIndexOf('\n', a - 1) + 1;
    if (a === b && !e.shiftKey) {
      onChange(`${v.slice(0, a)}  ${v.slice(b)}`);
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
      return;
    }
    const block = v.slice(lineStart, b);
    const next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
    onChange(v.slice(0, lineStart) + next + v.slice(b));
    requestAnimationFrame(() => el.setSelectionRange(lineStart, lineStart + next.length));
  };
  return (
    <div className="css-editor" style={{ height: `${rows * 1.55 + 1.4}em` }}>
      <div className="css-lines" ref={nums} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <div className="css-code">
        <pre ref={pre} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
        <textarea ref={ta} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onScroll={sync} onKeyDown={onKey} spellCheck={false} autoCapitalize="off" autoComplete="off" aria-label="CSS" />
      </div>
    </div>
  );
}

// ---- the theme header ----
export const META_KEYS = ['name', 'author', 'version', 'description', 'license', 'homepage', 'updateURL', 'base'];

export function parseMeta(css) {
  const m = String(css || '').match(/\/\*\s*==MMMTheme==([\s\S]*?)==\/MMMTheme==\s*\*\//);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const x = line.match(/^\s*\*?\s*@(\w+)\s+(.+?)\s*$/);
    if (x) meta[x[1]] = x[2];
  }
  return meta;
}

export function withMeta(css, meta) {
  const body = String(css || '').replace(/\/\*\s*==MMMTheme==[\s\S]*?==\/MMMTheme==\s*\*\/\n?/, '');
  const lines = META_KEYS.filter((k) => meta[k]).map((k) => `@${k.padEnd(12)}${meta[k]}`);
  if (!lines.length) return body;
  return `/* ==MMMTheme==\n${lines.join('\n')}\n==/MMMTheme== */\n${body}`;
}

/** 1.10.0 > 1.9.2 */
export function newer(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
