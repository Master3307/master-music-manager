import { useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useSearchParams } from 'react-router';
import {
  Settings as Cog, Palette, Library, FolderTree, FileAudio, Download, Play, Share2, Shield, User, Network, Puzzle, Archive, ScrollText, RefreshCw, Plus, Trash2, Pencil, Wifi, WifiOff,
  HardDrive, ExternalLink, Check, Copy as CopyIcon,
} from 'lucide-react';
import { useApp } from '../../lib/app.jsx';
import { get, post, del, patch } from '../../lib/api.js';
import { previewDoc, resolvedMode } from '../../lib/theme.js';
import { cx, ago } from '../../lib/util.js';
import { Field, Toggle, Notice, Segmented, Modal, Spinner, useConfirm, CopyField } from '../../components/ui.jsx';
import { ProfileForm, useDetect } from '../../components/ProfileForm.jsx';
import { Account, Instances, Plugin, Backup, Logs, System } from './More.jsx';
import { ThemeStudio } from './Themes.jsx';
import { CssEditor } from '../../components/CssEditor.jsx';

const NAV = [
  ['general', 'General', Cog],
  ['look', 'Look', Palette],
  ['profiles', 'Libraries', Library],
  ['library', 'Library & naming', FolderTree],
  ['import', 'Import & formats', FileAudio],
  ['downloads', 'Downloads', Download],
  ['player', 'Player', Play],
  ['sharing', 'Sharing', Share2],
  ['privacy', 'Privacy & online', Shield],
  ['account', 'Account & security', User],
  ['instances', 'Linked instances', Network],
  ['plugin', 'Navidrome plugin', Puzzle],
  ['backup', 'Backup', Archive],
  ['logs', 'Logs', ScrollText],
  ['system', 'System & updates', RefreshCw],
];

/** A settings section bound to one settings key; saves on every change. */
export function useSection(key) {
  const { settings, saveSetting, fail } = useApp();
  const [v, setV] = useState(settings?.[key] || {});
  useEffect(() => setV(settings?.[key] || {}), [settings, key]);
  const set = (patchObj) => {
    const next = { ...v, ...patchObj };
    setV(next);
    clearTimeout(set.t);
    set.t = setTimeout(() => saveSetting(key, next).catch(fail), 350);
  };
  return [v, set];
}

export function Section({ title, children, description }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {description && <p className="muted" style={{ marginTop: 4 }}>{description}</p>}
      <div className="col" style={{ gap: 12, marginTop: 12 }}>{children}</div>
    </div>
  );
}

export default function Settings() {
  const { isAdmin } = useApp();
  return (
    <div className="settings" style={{ marginTop: 10 }}>
      <nav className="settings-nav" aria-label="Settings">
        {NAV.filter(([id]) => isAdmin || ['look', 'account', 'player'].includes(id)).map(([id, label, I]) => (
          <NavLink key={id} to={`/settings/${id}`} className={({ isActive }) => cx(isActive && 'active')}>
            <I /> {label}
          </NavLink>
        ))}
      </nav>
      <div className="setting-list">
        <Routes>
          <Route index element={<Navigate to={isAdmin ? 'general' : 'look'} replace />} />
          <Route path="general" element={<General />} />
          <Route path="look" element={<Look />} />
          <Route path="profiles" element={<Profiles />} />
          <Route path="library" element={<LibrarySettings />} />
          <Route path="import" element={<ImportSettings />} />
          <Route path="downloads" element={<DownloadSettings />} />
          <Route path="player" element={<PlayerSettings />} />
          <Route path="sharing" element={<Sharing />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="account" element={<Account />} />
          <Route path="instances" element={<Instances />} />
          <Route path="plugin" element={<Plugin />} />
          <Route path="backup" element={<Backup />} />
          <Route path="logs" element={<Logs />} />
          <Route path="system" element={<System />} />
        </Routes>
      </div>
    </div>
  );
}

function General() {
  const [pub, setPub] = useSection('public');
  const [inst, setInst] = useSection('instance');
  return (
    <>
      <h1 className="page-title">General</h1>
      <Section title="Addresses" description="How people reach this app.">
        <Field label="Public address of Master Music Manager" hint="E.g. https://music-manager.example.com. Used for share links, link previews and logging in with Discord. Leave empty if it’s only used at home.">
          <input className="input mono" value={pub.url || ''} onChange={(e) => setPub({ url: e.target.value.trim().replace(/\/$/, '') })} placeholder="https://" />
        </Field>
        <Field label="Name of this installation" hint="Shown to other computers you link it with.">
          <input className="input" value={inst.name || ''} onChange={(e) => setInst({ name: e.target.value })} />
        </Field>
      </Section>
      <Section title="About">
        <p className="muted" style={{ margin: 0 }}>
          Master Music Manager is open source (Apache 2.0). <a href="https://github.com/Master3307/master-music-manager" target="_blank" rel="noopener noreferrer">Source code on GitHub</a> · made by <a href="https://home.master3307.org" target="_blank" rel="noopener noreferrer">MrKoby07</a>.
        </p>
      </Section>
    </>
  );
}

const ACCENTS = ['#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#d946ef', '#a3a3a3'];

function Look() {
  const { themes, settings, fail, resetMyLook, saveSetting, isAdmin, toast } = useApp();
  const [a, setA] = useSection('appearance');
  const [edit, setEdit] = useState(null);
  const confirm = useConfirm();
  const mode = resolvedMode(a.mode || 'system');
  const custom = a.customThemes || [];
  return (
    <>
      <h1 className="page-title">Look</h1>
      <Section title="Light or dark">
        <Segmented value={a.mode} onChange={(v) => setA({ mode: v })} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Like the system' }]} />
      </Section>
      <Section title="Accent colour">
        <div className="swatches">
          {ACCENTS.map((c) => <button key={c} className={cx('swatch', a.accent === c && 'active')} style={{ background: c }} onClick={() => setA({ accent: c })} aria-label={c} />)}
          <label className="swatch" style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)', position: 'relative', overflow: 'hidden' }} title="Any colour">
            <input type="color" value={a.accent || '#8b5cf6'} onChange={(e) => setA({ accent: e.target.value })} style={{ opacity: 0, position: 'absolute', inset: 0 }} />
          </label>
        </div>
      </Section>
      <Section title="Theme" description="Every theme has a light and a dark version (some only one).">
        <div className="theme-cards">
          {themes.map((t) => (
            <button key={t.id} className={cx('theme-card', a.theme === t.id && 'active')} onClick={() => setA({ theme: t.id })}>
              <iframe title={t.name} srcDoc={previewDoc({ themeId: t.id, mode, accent: a.accent, globalCss: a.globalCss })} loading="lazy" />
              <div className="label"><span>{t.name}</span>{!t[mode] && <span className="faint" style={{ fontWeight: 400 }}>{t.dark ? 'dark only' : 'light only'}</span>}</div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Your own themes" description="Themes are CSS. Make one, install one from a link or file, and share yours: shared themes update for everyone when you change them.">
        <ThemeStudio appearance={a} setA={setA} mode={mode} />
      </Section>
      <Section title="Simple or full">
        <Toggle checked={a.simple} onChange={(v) => setA({ simple: v })} label="Simple player" description="Just listening: hides the library tools, statistics and sharing. Everything is still there when you turn it off." />
      </Section>
      <Section title="Details">
        <Toggle checked={a.graphics !== false} onChange={(v) => setA({ graphics: v })} label="Graphics" description="Colour glow from the cover, blurred backgrounds behind pages, animated covers." />
        <Toggle checked={a.animations !== false} onChange={(v) => setA({ animations: v })} label="Animations" description="Off for a calmer, faster feel. Your system’s “reduce motion” is always respected." />
        <Field label="Rows">
          <Segmented value={a.density || 'comfortable'} onChange={(v) => setA({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        </Field>
        <Field label={`Corner roundness: ${a.radius ?? 12}px`}>
          <input type="range" min={0} max={22} value={a.radius ?? 12} onChange={(e) => setA({ radius: Number(e.target.value) })} style={{ accentColor: 'var(--accent)', maxWidth: 320 }} />
        </Field>
      </Section>
      <Section title="CSS for every theme" description="Applies on top of whatever theme is chosen. Change any variable (--bg, --accent, --radius …) or any class.">
        <CssEditor value={a.globalCss || ''} onChange={(v) => setA({ globalCss: v })} rows={10} placeholder="/* e.g. .page-title { letter-spacing: -0.04em; } */" />
      </Section>
      <Section title="Who sees this look" description="These settings are yours: they follow your account (or this browser when you’re not logged in).">
        <div className="row wrap">
          <button className="btn small" onClick={resetMyLook}>Use the default look</button>
          {isAdmin && <button className="btn small" onClick={() => saveSetting('appearance', a, { forEveryone: true }).then(() => toast('This is now the default for everyone'))}>Make my look the default for everyone</button>}
        </div>
      </Section>
      {settings && null}
      {fail && null}
    </>
  );
}

function Profiles() {
  const { profiles, loadProfiles, fail, toast, afterJob, setPid } = useApp();
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(params.get('add') === '1');
  const [editing, setEditing] = useState(null);
  const detected = useDetect();
  const confirm = useConfirm();
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Libraries</h1>
          <p className="page-sub">
            A library is where your music is: <b>a folder</b> on this machine, <b>a music server</b> (Navidrome, Jellyfin, OpenSubsonic), or <b>both linked together</b> (the best: you play through the server and can still edit the files). Add as many as you like; switch between them at the top right.
          </p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}><Plus /> Add</button>
      </div>
      {profiles.map((p) => (
        <div key={p.id} className="panel">
          <div className="row">
            {p.features?.service ? (p.status?.online ? <Wifi size={18} style={{ color: 'var(--ok)' }} /> : <WifiOff size={18} style={{ color: 'var(--danger)' }} />) : <HardDrive size={18} className="faint" />}
            <b className="grow">{p.name}</b>
            <span className="badge">{p.kindLabel}</span>
            {!p.shared && <span className="badge">yours</span>}
          </div>
          <div className="faint" style={{ fontSize: 13, margin: '6px 0 10px' }}>
            {p.url && <div>Server: <span className="mono">{p.url}</span>{p.publicUrl ? <> · public <span className="mono">{p.publicUrl}</span></> : null} · {p.status?.online ? `online${p.status.serverVersion ? `, ${p.status.type || ''} ${p.status.serverVersion}` : ''}` : `can’t be reached${p.status?.error ? `: ${p.status.error}` : ''}`}</div>}
            <div>Folder: {p.localPath ? <span className="mono">{p.localPath}</span> : 'none linked'}{p.linkScore != null && p.url ? ` · ${Math.round(p.linkScore * 100)}% of the server’s songs found in it` : ''}</div>
          </div>
          <div className="row wrap">
            <button className="btn small" onClick={() => setEditing(p)}><Pencil /> Edit</button>
            <button className="btn small" onClick={() => setPid(p.id)}>Use it now</button>
            {p.localPath && <button className="btn small" onClick={async () => { const r = await post(`p/${p.id}/scan`, { full: false }); toast('Reading the folder…'); afterJob(r.job).then(loadProfiles); }}><RefreshCw /> Read the folder</button>}
            {p.features?.scan && (
              <>
                <button className="btn small" onClick={() => post(`p/${p.id}/service-scan`, { full: false }).then(() => toast(`${p.name} is looking for changes`), fail)}>Quick server rescan</button>
                {p.features.fullScan && <button className="btn small" onClick={() => post(`p/${p.id}/service-scan`, { full: true }).then(() => toast(`${p.name} is reading everything again`), fail)}>Full server rescan</button>}
              </>
            )}
            {(p.publicUrl || p.url) && <a className="btn small ghost" href={p.publicUrl || p.url} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open {p.kindLabel}</a>}
            {p.publicUrl && p.url && <a className="btn small ghost" href={p.url} target="_blank" rel="noopener noreferrer">Local address</a>}
            <span className="grow" />
            {p.url && p.localPath && <button className="btn small ghost" onClick={async () => { if (await confirm({ title: 'Unlink the folder?', body: 'The library keeps working through the server, but editing files stops. Nothing is deleted.', confirm: 'Unlink' })) del(`profiles/${p.id}/link`).then(loadProfiles, fail); }}>Unlink folder</button>}
            {p.url && p.localPath && <button className="btn small ghost" onClick={async () => { if (await confirm({ title: `Remove ${p.kindLabel} from this library?`, body: 'It becomes a folder-only library. You can add the server back any time.', confirm: 'Remove the server' })) patch(`profiles/${p.id}`, { removeService: true }).then(loadProfiles, fail); }}>Folder only</button>}
            <button className="btn small ghost danger" onClick={async () => { if (await confirm({ title: `Remove ${p.name}?`, body: 'Only the connection is removed. No music is deleted.', danger: true, confirm: 'Remove' })) del(`profiles/${p.id}`).then(loadProfiles, fail); }}><Trash2 /></button>
          </div>
        </div>
      ))}
      <NavidromeImport />
      {adding && (
        <Modal title="Add a library" size="wide" onClose={() => setAdding(false)}>
          {detected ? <ProfileForm detected={detected} onCancel={() => setAdding(false)} onDone={async (p, o) => { await loadProfiles(); if (!o?.linkFailed) { setAdding(false); setPid(p.id); toast(`${p.name} added`); } }} /> : <Spinner />}
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit ${editing.name}`} size="wide" onClose={() => setEditing(null)}>
          {editing.kind === 'local' && <Notice>To connect a server to this folder: add the server as a new library and pick this same folder there.</Notice>}
          <ProfileForm existing={editing} detected={detected} onCancel={() => setEditing(null)} onDone={async (_p, o) => { await loadProfiles(); if (!o?.linkFailed) setEditing(null); }} />
        </Modal>
      )}
    </>
  );
}

function NavidromeImport() {
  const { profiles, fail, toast, afterJob } = useApp();
  const [file, setFile] = useState('');
  const { data, reload, loading } = useLoadSimple(() => get('import/navidrome', { file }), [file]);
  const libs = profiles.filter((p) => p.localPath);
  const [target, setTarget] = useState(libs[0]?.id);
  const [what, setWhat] = useState(['favorites', 'ratings', 'plays', 'playlists', 'radios', 'scrobbles']);
  const [typed, setTyped] = useState('');
  const KINDS = [['favorites', 'Favorites'], ['ratings', 'Ratings'], ['plays', 'Play counts'], ['playlists', 'Playlists'], ['radios', 'Radio stations'], ['scrobbles', 'Listening history']];
  return (
    <Section title="Bring over Navidrome’s data" description="When Navidrome runs on this machine, its favorites, ratings, play counts, playlists, radio stations and listening history can be copied into a library here, matched by file.">
      {loading && <Spinner />}
      {data && !data.found && (
        <>
          <Notice>Navidrome’s database wasn’t found here. {data.error}</Notice>
          <div className="row"><input className="input mono" placeholder="/var/lib/navidrome/navidrome.db" value={typed} onChange={(e) => setTyped(e.target.value)} /><button className="btn" onClick={() => setFile(typed)}>Look there</button></div>
        </>
      )}
      {data?.found && (
        <>
          <p className="muted" style={{ margin: 0 }}>Found <span className="mono">{data.file}</span>: {data.songs.toLocaleString()} songs, {data.favorites} favorites, {data.ratings} ratings, {data.plays} songs with plays, {data.playlists} playlists, {data.radios} stations, {data.scrobbles.toLocaleString()} listens (users: {data.users.join(', ')}).</p>
          <div className="chips">
            {KINDS.map(([k, l]) => <button key={k} className={cx('chip', what.includes(k) && 'active')} onClick={() => setWhat(what.includes(k) ? what.filter((x) => x !== k) : [...what, k])}>{what.includes(k) ? <Check /> : null}{l}</button>)}
          </div>
          <div className="row">
            <select className="select" style={{ maxWidth: 280 }} value={target || ''} onChange={(e) => setTarget(e.target.value)}>{libs.map((p) => <option key={p.id} value={p.id}>Into {p.name}</option>)}</select>
            <button className="btn primary" disabled={!target || !what.length} onClick={async () => { try { const r = await post('import/navidrome', { file: file || undefined, profileId: target, what }); toast('Copying from Navidrome…'); afterJob(r.job).then((j) => toast(j.status === 'done' ? 'Navidrome’s data is in' : j.error, { kind: j.status === 'done' ? 'ok' : 'error' })); } catch (e) { fail(e); } }}>Bring it over</button>
          </div>
          <span className="faint" style={{ fontSize: 12.5 }}>Nothing in Navidrome is changed. People are matched by user name; everything else goes to the shared library.</span>
        </>
      )}
      {reload && null}
    </Section>
  );
}

function useLoadSimple(fn, deps) {
  const [st, setSt] = useState({ data: null, loading: true });
  useEffect(() => {
    let live = true;
    setSt((x) => ({ ...x, loading: true }));
    fn().then((data) => live && setSt({ data, loading: false }), () => live && setSt({ data: null, loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...st, reload: null };
}

function ListEditor({ value, onChange, placeholder }) {
  const [t, setT] = useState('');
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="chips">
        {(value || []).map((x, i) => (
          <span key={i} className="chip" onClick={() => onChange(value.filter((_, j) => j !== i))} title="Click to remove" style={{ fontFamily: 'var(--mono)' }}>“{x}” ×</span>
        ))}
      </div>
      <div className="row">
        <input className="input" value={t} onChange={(e) => setT(e.target.value)} placeholder={placeholder} onKeyDown={(e) => { if (e.key === 'Enter' && t) { onChange([...(value || []), t]); setT(''); } }} />
        <button className="btn" disabled={!t} onClick={() => { onChange([...(value || []), t]); setT(''); }}>Add</button>
      </div>
    </div>
  );
}

function LibrarySettings() {
  const { fields } = useApp();
  const [l, setL] = useSection('library');
  const [d, setD] = useSection('duplicates');
  return (
    <>
      <h1 className="page-title">Library & naming</h1>
      <Section title="Folder layout" description="Where songs go when they’re imported or edited (with “rename and move” on). Library → Organize applies it to existing files with a preview.">
        <Field label="Layout"><input className="input mono" value={l.template || ''} onChange={(e) => setL({ template: e.target.value })} /></Field>
        <Toggle checked={l.autoOrganize} onChange={(v) => setL({ autoOrganize: v })} label="Rename and move files when their tags change" />
        <Field label="Artist folder uses">
          <Segmented value={l.folderArtist} onChange={(v) => setL({ folderArtist: v })} options={[{ value: 'primary', label: 'The first artist' }, { value: 'all', label: 'All artists' }]} />
        </Field>
        <div className="fields two">
          <Field label="Unknown artist"><input className="input" value={l.unknownArtist || ''} onChange={(e) => setL({ unknownArtist: e.target.value })} /></Field>
          <Field label="Unknown album"><input className="input" value={l.unknownAlbum || ''} onChange={(e) => setL({ unknownAlbum: e.target.value })} /></Field>
        </div>
        <Field label="Songs without artist and title">
          <Segmented value={l.misc?.enabled === true ? 'misc' : l.misc?.enabled === false ? 'keep' : 'ask'} onChange={(v) => setL({ misc: { ...l.misc, enabled: v === 'misc' ? true : v === 'keep' ? false : null } })} options={[{ value: 'misc', label: 'Into a folder' }, { value: 'keep', label: 'Named after the file' }, { value: 'ask', label: 'Ask me' }]} />
        </Field>
        {l.misc?.enabled && <Field label="Folder name"><input className="input" value={l.misc?.folder || '!Misc'} onChange={(e) => setL({ misc: { ...l.misc, folder: e.target.value } })} /></Field>}
        <Field label="Characters that aren’t allowed in file names">
          <Segmented value={l.illegalChars} onChange={(v) => setL({ illegalChars: v })} options={[{ value: 'replace', label: 'Replace with _' }, { value: 'remove', label: 'Leave out' }]} />
        </Field>
        <Field label="Smart playlist folder" hint="Inside the library."><input className="input mono" value={l.playlistsFolder || ''} onChange={(e) => setL({ playlistsFolder: e.target.value })} /></Field>
        <Toggle checked={l.rescanAfterChanges} onChange={(v) => setL({ rescanAfterChanges: v })} label="Tell the server to rescan after changes" description="A quick rescan a few seconds after the last edit." />
      </Section>
      <Section title="Your music disk" description="Reading thousands of files at once makes a spinning hard disk seek constantly (the grinding noise). The gentle way reads one file at a time in the order they lie on the disk, and pauses while music plays.">
        <Segmented value={l.diskMode || 'auto'} onChange={(v) => setL({ diskMode: v })} options={[{ value: 'auto', label: 'Find out by itself' }, { value: 'hdd', label: 'Spinning disk (gentle)' }, { value: 'ssd', label: 'SSD (fast)' }]} />
        <span className="faint" style={{ fontSize: 12.5 }}>“Find out by itself” is gentle unless it can tell for sure the disk is an SSD.</span>
      </Section>
      <Section title="Several artists" description="How “Artist feat. Someone & Another” is written in the tags.">
        <Toggle checked={l.splitArtists} onChange={(v) => setL({ splitArtists: v })} label="Split artists automatically" />
        <Field label="Write them like this">
          <select className="select" value={l.separator} onChange={(e) => setL({ separator: e.target.value })}>
            {(fields?.separators || []).map((s) => <option key={s.value} value={s.value}>{s.label}{s.note ? ` — ${s.note}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Split on" hint="Words need spaces around them (“ x ” won’t split “Xavier”).">
          <ListEditor value={l.splitOn} onChange={(v) => setL({ splitOn: v })} placeholder=' e.g.  " vs. "' />
        </Field>
        <Field label="Never split these names" hint="Bands with & or commas in their name.">
          <ListEditor value={l.keepTogether} onChange={(v) => setL({ keepTogether: v })} placeholder="e.g. Simon & Garfunkel" />
        </Field>
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Single songs can be excluded too: “Keep artists together” in the editor, or the command <span className="mono">keep-together on</span>.</p>
      </Section>
      <Section title="Duplicates">
        <Toggle checked={d.autoMergeExact} onChange={(v) => setD({ autoMergeExact: v })} label="Merge identical copies by itself" description="Only exact same audio. The better copy stays, the other goes to the trash." />
        <Field label={`Lengths count as the same within ${d.durationTolerance ?? 3} s`}><input type="range" min={1} max={15} value={d.durationTolerance ?? 3} onChange={(e) => setD({ durationTolerance: Number(e.target.value) })} style={{ accentColor: 'var(--accent)', maxWidth: 320 }} /></Field>
        <Toggle checked={d.ignoreFeat} onChange={(v) => setD({ ignoreFeat: v })} label="Ignore featured artists when comparing" />
      </Section>
    </>
  );
}

function ImportSettings() {
  const [c, setC] = useSection('convert');
  return (
    <>
      <h1 className="page-title">Import & formats</h1>
      <Section title="Format for new music" description="Uploads, downloads and imports. Your existing files are never converted unless you do it yourself.">
        <select className="select" value={c.format} onChange={(e) => setC({ format: e.target.value })}>
          <option value="mp3">MP3 · plays everywhere (recommended)</option>
          <option value="flac">FLAC · lossless</option>
          <option value="opus">Opus · smallest for the quality</option>
          <option value="m4a">AAC / M4A · Apple devices</option>
          <option value="ogg">Ogg Vorbis</option>
          <option value="original">Keep whatever it comes in</option>
        </select>
        {c.format === 'mp3' && (
          <div className="fields two">
            <Field label="MP3 quality">
              <Segmented value={c.mp3Mode} onChange={(v) => setC({ mp3Mode: v })} options={[{ value: 'vbr', label: 'Variable (V0)' }, { value: 'cbr', label: 'Constant' }]} />
            </Field>
            {c.mp3Mode === 'cbr' && <Field label="Bitrate"><select className="select" value={c.bitrate} onChange={(e) => setC({ bitrate: Number(e.target.value) })}>{[128, 192, 256, 320].map((b) => <option key={b} value={b}>{b} kbps</option>)}</select></Field>}
          </div>
        )}
        <Toggle checked={c.keepLossless} onChange={(v) => setC({ keepLossless: v })} label="Keep lossless files lossless" description="FLAC, WAV and ALAC become FLAC instead of the format above." />
        <Toggle checked={c.normalize} onChange={(v) => setC({ normalize: v })} label="Even out loudness while converting" description="To −14 LUFS like streaming services. Changes the audio." />
      </Section>
      <Section title="Originals" description="When a file is converted, what happens to the file it came from?">
        <Segmented value={c.keepOriginal} onChange={(v) => setC({ keepOriginal: v })} options={[{ value: 'never', label: 'Throw away' }, { value: 'folder', label: 'Keep in the library' }, { value: 'inbox', label: 'Keep in the app’s folder' }]} />
        {c.keepOriginal === 'folder' && <Field label="Folder inside the library" hint="Hidden folders (starting with .) are skipped by Navidrome."><input className="input mono" value={c.originalsFolder || ''} onChange={(e) => setC({ originalsFolder: e.target.value })} /></Field>}
      </Section>
      <Section title="Animated covers" description="Music videos can become a moving cover, like Spotify’s Canvas. Navidrome and other apps show the normal cover; Master Music Manager and its share pages show the moving one.">
        <Toggle checked={c.animatedCovers} onChange={(v) => setC({ animatedCovers: v })} label="Make animated covers from videos" />
        <Field label={`Loop length: ${c.canvasSeconds} s`}><input type="range" min={3} max={15} value={c.canvasSeconds || 8} onChange={(e) => setC({ canvasSeconds: Number(e.target.value) })} style={{ accentColor: 'var(--accent)', maxWidth: 320 }} /></Field>
      </Section>
    </>
  );
}

function DownloadSettings() {
  const [d, setD] = useSection('downloads');
  return (
    <>
      <h1 className="page-title">Downloads</h1>
      <Section title="Before importing">
        <Toggle checked={d.reviewBeforeImport} onChange={(v) => setD({ reviewBeforeImport: v })} label="Let me check downloads in the inbox first" />
      </Section>
      <Section title="Matching (Spotify links)" description="Spotify gives the names, YouTube Music the sound. These are the same knobs the spotify-dl script had.">
        <Field label="Where to look for the audio" hint="In this order"><input className="input mono" value={d.providers || ''} onChange={(e) => setD({ providers: e.target.value })} /></Field>
        <Field label="Search with" hint="{artist} - {title} skips album and version names like “- Mixed”, which finds official uploads best."><input className="input mono" value={d.searchQuery || ''} onChange={(e) => setD({ searchQuery: e.target.value })} /></Field>
        <Toggle checked={d.filterResults} onChange={(v) => setD({ filterResults: v })} label="Reject poor matches" description="Recommended. Off allows live versions, long mixes and lookalikes." />
        <Field label={`Downloads at once: ${d.threads}`}><input type="range" min={1} max={8} value={d.threads || 2} onChange={(e) => setD({ threads: Number(e.target.value) })} style={{ accentColor: 'var(--accent)', maxWidth: 320 }} /></Field>
      </Section>
      <Section title="Advanced">
        <Field label="YouTube cookies file" hint="A cookies.txt from your browser helps with age-restricted songs and rate limits."><input className="input mono" value={d.cookies || ''} onChange={(e) => setD({ cookies: e.target.value })} placeholder="/root/youtube-cookies.txt" /></Field>
        <div className="fields two">
          <Field label="spotDL program"><input className="input mono" value={d.spotdlBin || ''} onChange={(e) => setD({ spotdlBin: e.target.value })} /></Field>
          <Field label="yt-dlp program"><input className="input mono" value={d.ytdlpBin || ''} onChange={(e) => setD({ ytdlpBin: e.target.value })} /></Field>
        </div>
        <Field label="Extra arguments" hint="Passed as they are. For experts."><input className="input mono" value={d.extraArgs || ''} onChange={(e) => setD({ extraArgs: e.target.value })} /></Field>
      </Section>
    </>
  );
}

function PlayerSettings() {
  const [p, setP] = useSection('player');
  return (
    <>
      <h1 className="page-title">Player</h1>
      <Section title="Listening">
        <Toggle checked={p.scrobble} onChange={(v) => setP({ scrobble: v })} label="Count plays on the server (scrobble)" />
        <Field label={`Counts as played after ${p.scrobbleAt}%`}><input type="range" min={20} max={90} step={5} value={p.scrobbleAt || 50} onChange={(e) => setP({ scrobbleAt: Number(e.target.value) })} style={{ accentColor: 'var(--accent)', maxWidth: 320 }} /></Field>
      </Section>
      <Section title="Looks">
        <Toggle checked={p.visualizer} onChange={(v) => setP({ visualizer: v })} label="Visualizer" />
        <Toggle checked={p.canvas} onChange={(v) => setP({ canvas: v })} label="Animated covers in the player" />
      </Section>
      <Notice>Speed, equalizer, sleep timer, A–B loop, crossfade and more are in the player itself: the sliders button next to the volume.</Notice>
    </>
  );
}

function Sharing() {
  const [s, setS] = useSection('shares');
  return (
    <>
      <h1 className="page-title">Sharing</h1>
      <Section title="New shares start as">
        <Segmented value={s.defaultVisibility} onChange={(v) => setS({ defaultVisibility: v })} options={[{ value: 'public', label: 'Anyone with the link' }, { value: 'key', label: 'Needs a key' }, { value: 'private', label: 'Only me' }]} />
        <Toggle checked={s.defaultDownload} onChange={(v) => setS({ defaultDownload: v })} label="Downloads allowed" />
        <Field label="Expire after (days, 0 = never)"><input className="input" type="number" min={0} value={s.defaultExpiryDays ?? 0} onChange={(e) => setS({ defaultExpiryDays: Number(e.target.value) || 0 })} style={{ maxWidth: 160 }} /></Field>
        <Field label="Name on share pages and previews"><input className="input" value={s.siteName || ''} onChange={(e) => setS({ siteName: e.target.value })} /></Field>
      </Section>
    </>
  );
}

function Privacy() {
  const [p, setP] = useSection('privacy');
  const off = p.fullLocal;
  return (
    <>
      <h1 className="page-title">Privacy & online</h1>
      <Section title="Fully local" description="Nothing leaves your network: no update checks, lookups, downloads or recognition. Your own servers and linked instances still work.">
        <Toggle checked={p.fullLocal} onChange={(v) => setP({ fullLocal: v })} label="Privacy mode" />
      </Section>
      <Section title="What may go online" description={off ? 'Privacy mode is on, so all of these are off.' : 'Each one can be switched off by itself.'}>
        <Toggle disabled={off} checked={p.updateCheck} onChange={(v) => setP({ updateCheck: v })} label="Check GitHub for updates" description="Asks github.com a few times a day for the newest version." />
        <Toggle disabled={off} checked={p.musicbrainz} onChange={(v) => setP({ musicbrainz: v })} label="MusicBrainz" description="Exact links on artist pages and song recognition." />
        <Toggle disabled={off} checked={p.coverSearch} onChange={(v) => setP({ coverSearch: v })} label="Pictures from the web" description="Loading a cover from an address you paste." />
        <Toggle disabled={off} checked={p.lyrics !== false} onChange={(v) => setP({ lyrics: v })} label="Lyric lookups" description="LRCLIB, NetEase, lyrics.ovh." />
        <Toggle disabled={off} checked={p.lastfm} onChange={(v) => setP({ lastfm: v })} label="Last.fm" description="Importing your Last.fm history." />
        {p.lastfm && !off && <Field label="Last.fm API key" hint="Free at last.fm/api/account/create"><input className="input mono" value={p.lastfmKey || ''} onChange={(e) => setP({ lastfmKey: e.target.value })} /></Field>}
      </Section>
      <Section title="Recognizing songs" description="Find out what a song is from its sound. Results are always shown first; nothing is written without you.">
        <Field label="AcoustID application key" hint="Free at acoustid.org/new-application. Needs Chromaprint (install it under Get music → Tools)."><input className="input mono" disabled={off} value={p.acoustidKey || ''} onChange={(e) => setP({ acoustidKey: e.target.value })} /></Field>
        <Toggle disabled={off} checked={p.shazam} onChange={(v) => setP({ shazam: v })} label="Shazam (unofficial)" description="Very good with clips, remixes and YouTube rips. It uses Shazam’s private API (shazamio), is against Shazam’s terms and can stop working any day. Install it under Get music → Tools." />
        <Field label="AudD API key (optional)" hint="Commercial recognition with a small free tier, audd.io"><input className="input mono" disabled={off} value={p.auddKey || ''} onChange={(e) => setP({ auddKey: e.target.value })} /></Field>
      </Section>
    </>
  );
}

export { useMemo, CopyField, CopyIcon, ago, get };
