import { useState } from 'react';
import { Plus, Pencil, Trash2, Download, Copy, Share2, RefreshCw, Link2, Upload, Check } from 'lucide-react';
import { useApp } from '../../lib/app.jsx';
import { get } from '../../lib/api.js';
import { previewDoc } from '../../lib/theme.js';
import { cx, copy } from '../../lib/util.js';
import { Field, Modal, Notice, useConfirm, useDialog } from '../../components/ui.jsx';
import { CssEditor, parseMeta, withMeta, newer, META_KEYS } from '../../components/CssEditor.jsx';
import { ShareDialog } from '../../components/Songs.jsx';

const STARTER = `:root {
  /* Base colours (see the list on the right) */
  /* --bg: #101018; */
  /* --surface: #1a1a26; */
  /* --accent: #ff4d8d; */
}

/* Anything else, e.g. square covers: */
/* .cover { border-radius: 0; } */
`;

const LABELS = { name: 'Name', author: 'Made by', version: 'Version', description: 'Description', license: 'License', homepage: 'Website', updateURL: 'Update address', base: 'Starts from' };

export function ThemeStudio({ appearance, setA, mode }) {
  const { themes, toast, fail, isAdmin, pid } = useApp();
  const confirm = useConfirm();
  const dialog = useDialog();
  const [edit, setEdit] = useState(null);
  const [install, setInstall] = useState(null);
  const custom = appearance.customThemes || [];

  const saveTheme = (t) => {
    const meta = parseMeta(t.css);
    const theme = { ...t, name: meta.name || t.name, base: meta.base || t.base || 'midnight' };
    const list = custom.some((x) => x.id === theme.id) ? custom.map((x) => (x.id === theme.id ? theme : x)) : [...custom, theme];
    setA({ customThemes: list, theme: theme.id });
  };
  const fromCss = (css, source) => {
    const meta = parseMeta(css);
    return { id: `custom-${Date.now()}`, name: meta.name || 'Installed theme', base: meta.base || 'midnight', css, source };
  };
  const checkUpdate = async (t) => {
    const meta = parseMeta(t.css);
    try {
      const r = await get('themes/fetch', { url: meta.updateURL });
      const nm = parseMeta(r.css);
      if (newer(nm.version, meta.version) || (!meta.version && r.css !== t.css)) {
        if (await confirm({ title: `Update ${t.name} to ${nm.version || 'the new version'}?`, body: nm.description || 'A newer version is available.', confirm: 'Update' })) {
          saveTheme({ ...t, css: r.css });
          toast('Theme updated');
        }
      } else toast('This theme is up to date');
    } catch (e) {
      fail(e);
    }
  };
  const download = (t) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t.css], { type: 'text/css' }));
    a.download = `${t.name.replace(/[^\w -]+/g, '')}.css`;
    a.click();
  };

  return (
    <>
      <div className="theme-cards">
        {custom.map((t) => {
          const meta = parseMeta(t.css);
          return (
            <div key={t.id} className={cx('theme-card', appearance.theme === t.id && 'active')} onClick={() => setA({ theme: t.id })} role="button" tabIndex={0}>
              <iframe title={t.name} srcDoc={previewDoc({ themeId: t.base || 'midnight', mode, accent: appearance.accent, css: t.css, globalCss: appearance.globalCss })} loading="lazy" />
              <div className="label" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                <span>{t.name}</span>
                <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>{[meta.author && `by ${meta.author}`, meta.version && `v${meta.version}`].filter(Boolean).join(' · ') || 'your own'}</span>
                <span className="row" style={{ gap: 0, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn icon small ghost" title="Edit" onClick={() => setEdit({ ...t })}><Pencil size={14} /></button>
                  <button className="btn icon small ghost" title="Save as a file" onClick={() => download(t)}><Download size={14} /></button>
                  <button className="btn icon small ghost" title="Copy the CSS" onClick={() => copy(t.css).then(() => toast('Copied'))}><Copy size={14} /></button>
                  {isAdmin && <button className="btn icon small ghost" title="Share with a link (it stays up to date)" onClick={() => dialog(<ShareDialog kind="theme" refData={{ themeId: t.id }} title={t.name} pid={pid} />)}><Share2 size={14} /></button>}
                  {meta.updateURL && <button className="btn icon small ghost" title="Check for an update" onClick={() => checkUpdate(t)}><RefreshCw size={14} /></button>}
                  <button className="btn icon small ghost" title="Delete" onClick={async () => { if (await confirm({ title: `Delete ${t.name}?`, danger: true, confirm: 'Delete' })) setA({ customThemes: custom.filter((x) => x.id !== t.id), theme: appearance.theme === t.id ? 'midnight' : appearance.theme }); }}><Trash2 size={14} /></button>
                </span>
              </div>
            </div>
          );
        })}
        <button className="theme-card" style={{ display: 'grid', placeItems: 'center', minHeight: 150 }} onClick={() => setEdit({ id: `custom-${Date.now()}`, name: 'My theme', base: 'midnight', css: withMeta(STARTER, { name: 'My theme', version: '1.0.0' }) })}>
          <span className="row"><Plus /> Make a theme</span>
        </button>
      </div>
      <div className="row wrap">
        {isAdmin && <button className="btn small" onClick={() => setInstall({ url: '' })}><Link2 /> Install from a link</button>}
        <label className="btn small"><Upload /> Install a .css file<input type="file" accept=".css,text/css" hidden onChange={async (e) => { const f = e.target.files[0]; if (!f) return; saveTheme(fromCss(await f.text(), f.name)); toast('Theme installed'); }} /></label>
      </div>

      {install && (
        <Modal title="Install a theme" onClose={() => setInstall(null)} footer={<><button className="btn ghost" onClick={() => setInstall(null)}>Cancel</button><button className="btn primary" disabled={!install.url} onClick={async () => { try { const r = await get('themes/fetch', { url: install.url }); const t = fromCss(r.css, install.url); if (!parseMeta(r.css).updateURL) t.css = withMeta(r.css, { ...parseMeta(r.css), updateURL: install.url }); saveTheme(t); setInstall(null); toast(`Installed ${t.name}`); } catch (e) { fail(e); } }}>Install</button></>}>
          <Field label="Address of the theme" hint="A share link ending in /theme.css, or any link to a .css file. It can update itself later.">
            <input className="input mono" value={install.url} onChange={(e) => setInstall({ url: e.target.value })} placeholder="https://…/share/AbCdEf1234/theme.css" autoFocus />
          </Field>
        </Modal>
      )}

      {edit && <ThemeEditor theme={edit} themes={themes} appearance={appearance} mode={mode} onClose={() => setEdit(null)} onSave={(t) => { saveTheme(t); setEdit(null); toast('Theme saved'); }} />}
    </>
  );
}

function ThemeEditor({ theme, themes, appearance, mode, onClose, onSave }) {
  const [css, setCss] = useState(theme.css);
  const meta = parseMeta(css);
  const setMeta = (k, v) => setCss(withMeta(css, { ...meta, [k]: v }));
  const base = meta.base || theme.base || 'midnight';
  return (
    <Modal
      title={`Edit ${meta.name || theme.name}`}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <span className="faint grow" style={{ fontSize: 12.5 }}>The header (name, author, version …) is written into the CSS as a comment, so it travels with the file.</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave({ ...theme, css, base })}><Check /> Save and use</button>
        </>
      }
    >
      <div className="editor-grid" style={{ gridTemplateColumns: '300px minmax(0, 1fr)' }}>
        <div className="col" style={{ gap: 10 }}>
          {META_KEYS.map((k) =>
            k === 'base' ? (
              <Field key={k} label={LABELS[k]}>
                <select className="select" value={base} onChange={(e) => setMeta('base', e.target.value)}>{themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </Field>
            ) : (
              <Field key={k} label={LABELS[k]} hint={k === 'updateURL' ? 'Where newer versions are. Shared themes fill this in.' : k === 'license' ? 'e.g. MIT, CC-BY-4.0' : undefined}>
                <input className={cx('input', ['homepage', 'updateURL'].includes(k) && 'mono')} value={meta[k] || ''} onChange={(e) => setMeta(k, e.target.value)} />
              </Field>
            ),
          )}
          <span className="faint" style={{ fontSize: 12 }}>Preview</span>
          <iframe title="Preview" srcDoc={previewDoc({ themeId: base, mode, accent: appearance.accent, css, globalCss: appearance.globalCss })} style={{ border: '1px solid var(--line)', borderRadius: 10, height: 170, width: '100%' }} />
        </div>
        <div className="col" style={{ gap: 8, minWidth: 0 }}>
          <CssEditor value={css} onChange={setCss} rows={26} />
          <Notice>
            Variables: <span className="mono">--bg --bg-2 --surface --surface-2 --line --text --text-2 --text-3 --accent --accent-ink --radius --font --mono</span>. Classes worth knowing: <span className="mono">.rail .deck .topbar .trow .tile .cover .hero .panel .btn</span>.
          </Notice>
        </div>
      </div>
    </Modal>
  );
}
