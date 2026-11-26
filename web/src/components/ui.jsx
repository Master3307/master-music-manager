import { cloneElement, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, CircleAlert, Info, Music2, Star, X, Check, Copy, Download, Disc3 } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { get } from '../lib/api.js';
import { coverUrl, cx, copy } from '../lib/util.js';

export function Logo({ size = 30 }) {
  // The mark: an "M" drawn as one waveform stroke, with a playhead dot.
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="mmm-bg" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="color-mix(in oklab, var(--accent) 62%, white)" />
          <stop offset=".55" stopColor="var(--accent)" />
          <stop offset="1" stopColor="color-mix(in oklab, var(--accent) 62%, black)" />
        </linearGradient>
      </defs>
      <path d="M32 2C52 2 62 12 62 32S52 62 32 62 2 52 2 32 12 2 32 2Z" fill="url(#mmm-bg)" />
      <path d="M15 43V23.5c0-2.2 2.6-3.3 4.2-1.8L32 34.5l12.8-12.8c1.6-1.5 4.2-.4 4.2 1.8V43" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="45.5" r="3.6" fill="#fff" />
    </svg>
  );
}

export function GithubIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.3-1.69-1.3-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export function Spinner({ size = 18 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Cover({ pid, id, src, size = 300, round, className, alt = '', icon: Icon = Disc3, animated, style, onClick }) {
  const [failed, setFailed] = useState(false);
  const url = src || (id ? coverUrl(pid, id, animated ? 0 : size) : null);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={cx('cover', round && 'round', className)} style={style} onClick={onClick}>
      {url && !failed ? <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <div className="ph"><Icon /></div>}
    </div>
  );
}

/** Animated cover (canvas) for a local track, falling back to the still cover. */
export function CanvasCover({ pid, localId, coverArt, className }) {
  const [hasVideo, setHasVideo] = useState(Boolean(localId));
  useEffect(() => setHasVideo(Boolean(localId)), [localId]);
  const { settings } = useApp();
  if (hasVideo && localId && settings?.player?.canvas !== false && settings?.appearance?.graphics !== false) {
    return (
      <video
        className={className}
        key={localId}
        src={`/api/p/${pid}/tracks/${localId}/canvas/mp4`}
        poster={coverArt ? coverUrl(pid, coverArt, 600) : undefined}
        autoPlay
        loop
        muted
        playsInline
        onError={() => setHasVideo(false)}
      />
    );
  }
  return coverArt ? <img className={className} src={coverUrl(pid, coverArt, 600)} alt="" /> : <div className="cover" style={{ width: '100%', height: '100%' }}><div className="ph"><Music2 /></div></div>;
}

export function Stars({ value = 0, onChange, size = 16 }) {
  const [hover, setHover] = useState(0);
  return (
    <span className="stars" onMouseLeave={() => setHover(0)} role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={cx((hover || value) >= n && 'on')} onMouseEnter={() => setHover(n)} onClick={() => onChange?.(value === n ? 0 : n)} aria-label={`${n} star${n > 1 ? 's' : ''}`} aria-checked={value === n} role="radio">
          <Star style={{ width: size, height: size }} fill={(hover || value) >= n ? 'currentColor' : 'none'} />
        </button>
      ))}
    </span>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>
        <span className="t">{label}</span>
        {description && <span className="d">{description}</span>}
      </span>
    </label>
  );
}

export function Field({ label, hint, children, style }) {
  return (
    <label className="field" style={style}>
      {label && <span className="label">{label}</span>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Notice({ kind = 'info', children, icon }) {
  const I = icon || (kind === 'info' || kind === 'accent' ? Info : CircleAlert);
  return (
    <div className={cx('notice', kind)}>
      <I />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ icon: I = Music2, title, children, action }) {
  return (
    <div className="empty">
      <I className="big" />
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, size, icon }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={cx('modal', size)} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          {icon}
          <h2 className="grow">{title}</h2>
          {onClose && (
            <button className="btn icon ghost" onClick={onClose} aria-label="Close">
              <X />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---- confirm() that returns a promise ----
const ConfirmCtx = createContext(null);
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const ask = useCallback((opts) => new Promise((resolve) => setReq({ ...opts, resolve })), []);
  const done = (v) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && (
        <Modal
          title={req.title || 'Are you sure?'}
          onClose={() => done(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => done(false)}>
                {req.cancel || 'Cancel'}
              </button>
              <button className={cx('btn', req.danger ? 'danger solid' : 'primary')} onClick={() => done(true)} autoFocus>
                {req.confirm || 'Continue'}
              </button>
            </>
          }
        >
          {typeof req.body === 'string' ? <p className="muted" style={{ margin: 0 }}>{req.body}</p> : req.body}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

// ---- context menus ----
// Rule for the whole app: right click opens our menu; a second right click on
// (almost) the same spot while it is open gives the browser's own menu.
let openMenu = null; // { x, y, close }
if (typeof window !== 'undefined' && !window.__mmmCtx) {
  window.__mmmCtx = true;
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (openMenu && Math.abs(e.clientX - openMenu.x) <= 6 && Math.abs(e.clientY - openMenu.y) <= 6) {
        e.stopImmediatePropagation(); // our handlers don't run, the native menu shows
        openMenu.close();
        openMenu = null;
      }
    },
    true,
  );
}

/** A menu that opens at a point (right click) or under an element. */
export function Menu({ at, onClose, children, align = 'left' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y, opacity: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = align === 'right' ? at.x - r.width : at.x;
    let top = at.y;
    if (left + r.width > innerWidth - 8) left = innerWidth - r.width - 8;
    if (top + r.height > innerHeight - 8) top = Math.max(8, at.y - r.height);
    setPos({ left: Math.max(8, left), top, opacity: 1 });
  }, [at, align]);
  useEffect(() => {
    openMenu = { x: at.x, y: at.y, close: onClose };
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    document.querySelector('.content')?.addEventListener('scroll', onClose, { passive: true });
    return () => {
      clearTimeout(t);
      if (openMenu?.close === onClose) openMenu = null;
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      document.querySelector('.content')?.removeEventListener('scroll', onClose);
    };
  }, [onClose, at]);
  // Arrow keys move between items.
  const onKey = (e) => {
    const items = [...ref.current.querySelectorAll('.menu-item:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  return createPortal(
    <div ref={ref} className="popover" style={{ position: 'fixed', ...pos }} role="menu" onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()} onClick={(e) => e.target.closest('.menu-item') && !e.target.closest('[data-keep]') && onClose()}>
      {children}
    </div>,
    document.body,
  );
}

/** Items as data: { label, icon, onClick, danger, hint, disabled } | 'sep' | { heading } */
export function MenuList({ items }) {
  return items.filter(Boolean).map((it, i) =>
    it === 'sep' ? (
      <MenuSep key={i} />
    ) : it.heading ? (
      <div key={i} className="menu-label">{it.heading}</div>
    ) : (
      <MenuItem key={i} icon={it.icon} onClick={it.onClick} danger={it.danger} hint={it.hint} disabled={it.disabled}>
        {it.label}
      </MenuItem>
    ),
  );
}

const CtxCtx = createContext(null);
/** openContext(event, items): one context menu for the whole app. */
const DialogCtx = createContext(null);
/** showDialog(<SomeModal />): the modal gets onClose added. */
export const useDialog = () => useContext(DialogCtx);
export function ContextMenuProvider({ children }) {
  const [m, setM] = useState(null);
  const [dialog, setDialog] = useState(null);
  const showDialog = useCallback((node) => setDialog(node), []);
  const open = useCallback((e, items) => {
    if (!items?.filter(Boolean).length) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.type === 'contextmenu' ? null : e.currentTarget?.getBoundingClientRect?.();
    setM({ at: r ? { x: r.right, y: r.bottom + 4 } : { x: e.clientX, y: e.clientY }, align: r ? 'right' : 'left', items });
  }, []);
  const close = useCallback(() => setM(null), []);
  return (
    <CtxCtx.Provider value={open}>
      <DialogCtx.Provider value={showDialog}>
        {children}
        {m && (
          <Menu at={m.at} align={m.align} onClose={close}>
            <MenuList items={m.items} />
          </Menu>
        )}
        {dialog && cloneElement(dialog, { onClose: () => { dialog.props.onClose?.(); setDialog(null); } })}
      </DialogCtx.Provider>
    </CtxCtx.Provider>
  );
}
export const useCtxMenu = () => useContext(CtxCtx);

export function MenuItem({ icon: I, children, onClick, danger, hint, disabled }) {
  return (
    <button className={cx('menu-item', danger && 'danger')} onClick={onClick} disabled={disabled} role="menuitem" style={disabled ? { opacity: 0.45 } : undefined}>
      {I && <I />}
      <span className="grow ellipsis">{children}</span>
      {hint && <small>{hint}</small>}
    </button>
  );
}
export const MenuSep = () => <div className="menu-sep" />;

export function useMenu() {
  const [menu, setMenu] = useState(null);
  const open = useCallback((e, data) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget?.getBoundingClientRect?.();
    setMenu({ at: e.type === 'contextmenu' || !r ? { x: e.clientX, y: e.clientY } : { x: r.right, y: r.bottom + 4 }, align: e.type === 'contextmenu' ? 'left' : 'right', data });
  }, []);
  return { menu, open, close: () => setMenu(null) };
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={cx(value === t.id && 'active')} onClick={() => onChange(t.id)}>
          {t.icon && <t.icon />}
          {t.label}
          {t.count != null && <span className="badge">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="btn-group" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" className={cx(value === o.value && 'active')} onClick={() => onChange(o.value)} role="radio" aria-checked={value === o.value} title={o.title}>
          {o.icon && <o.icon />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Colours a log so errors and commands stand out. */
function colorize(text) {
  return text.split('\n').map((l, i) => (
    <span key={i} className={/^(✗|!|Error|ERROR|failed)/.test(l.trim()) ? 'err' : /^(✓|ok\b|\+ )/.test(l.trim()) ? 'ok' : l.startsWith('$ ') ? 'cmd' : undefined}>
      {l}
      {'\n'}
    </span>
  ));
}

/** "Details": the full output of a job, collapsed until asked for. */
export function JobDetails({ jobId, defaultOpen = false, live }) {
  const { logs } = useApp();
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState('');
  const pre = useRef(null);
  useEffect(() => {
    if (!open) return;
    get(`jobs/${jobId}`, { tail: 200000 }).then((j) => setText(j.log || '')).catch(() => {});
  }, [open, jobId]);
  const shown = (text + (live && logs[jobId] && !text.includes(logs[jobId].slice(-200)) ? logs[jobId] : '')).slice(-200000);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [shown]);
  return (
    <details className="details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <ChevronRight /> Details
      </summary>
      {open && (
        <>
          <pre className="codeblock" ref={pre}>
            {shown ? colorize(shown) : 'No output yet.'}
          </pre>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small ghost" onClick={() => copy(shown)}>
              <Copy /> Copy
            </button>
            <a className="btn small ghost" href={`/api/jobs/${jobId}/log`}>
              <Download /> Save as file
            </a>
          </div>
        </>
      )}
    </details>
  );
}

export function Progress({ value, indeterminate }) {
  return (
    <div className={cx('bar', indeterminate && 'indet')} role="progressbar" aria-valuenow={Math.round((value || 0) * 100)}>
      <i style={{ width: `${Math.round((value || 0) * 100)}%` }} />
    </div>
  );
}

export function CopyField({ value, mono = true }) {
  const [done, setDone] = useState(false);
  return (
    <div className="row">
      <input className={cx('input', mono && 'mono')} readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        className="btn icon"
        onClick={() => {
          copy(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }}
        aria-label="Copy"
      >
        {done ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

export function Range({ value, max, onChange, onCommit, step = 'any', className, label }) {
  const p = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <input
      type="range"
      className={cx('range', className)}
      min={0}
      max={max || 0}
      step={step}
      value={value || 0}
      aria-label={label}
      style={{ '--p': `${p}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      onMouseUp={(e) => onCommit?.(Number(e.target.value))}
      onTouchEnd={(e) => onCommit?.(Number(e.target.value))}
      onKeyUp={(e) => onCommit?.(Number(e.target.value))}
    />
  );
}
