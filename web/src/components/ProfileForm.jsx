import { useEffect, useState } from 'react';
import { Server, HardDrive, Check, CircleAlert, FolderOpen, Wifi, WifiOff, Sparkles } from 'lucide-react';
import { get, post, patch } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { Field, Notice, Spinner, Toggle } from './ui.jsx';
import { FolderPicker } from './FolderPicker.jsx';
import { cx } from '../lib/util.js';

const KINDS = [
  { id: 'navidrome', label: 'Navidrome', note: 'Everything works, incl. smart playlists and the plugin.', port: 4533 },
  { id: 'jellyfin', label: 'Jellyfin / Emby', note: 'Playing, playlists, favorites, rescans.', port: 8096 },
  { id: 'subsonic', label: 'Other OpenSubsonic', note: 'Gonic, Airsonic, Ampache, LMS …', port: 4040 },
  { id: 'local', label: 'Just a folder', note: 'No server. Edit and play your files directly.' },
];

/**
 * Add (or edit) a library. Fills in what was detected and asks to confirm.
 * onDone(profile) after saving.
 */
export function ProfileForm({ detected, existing, onDone, onCancel, compact }) {
  const { fail } = useApp();
  const [kind, setKind] = useState(existing?.kind || detected?.servers?.[0]?.kind || 'navidrome');
  const [f, setF] = useState({
    name: existing?.name || '',
    url: existing?.url || detected?.servers?.find((s) => s.kind === (existing?.kind || detected?.servers?.[0]?.kind))?.url || '',
    publicUrl: existing?.publicUrl || '',
    username: existing?.username || '',
    password: '',
    localPath: existing?.localPath || detected?.servers?.[0]?.musicFolder || detected?.folders?.[0] || '',
  });
  const [test, setTest] = useState(null);
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [saveOffline, setSaveOffline] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const isLocal = kind === 'local';

  useEffect(() => {
    if (existing) return;
    const d = detected?.servers?.find((s) => s.kind === kind);
    if (d) setF((x) => ({ ...x, url: d.url, localPath: x.localPath || d.musicFolder || '' }));
  }, [kind, detected, existing]);

  const runTest = async () => {
    setTest({ busy: true });
    try {
      const r = await post('profiles/test', { id: existing?.id, kind, url: f.url, username: f.username, password: f.password });
      setTest(r);
      if (r.kind && r.kind !== kind) setKind(r.kind);
    } catch (e) {
      setTest({ ok: false, error: e.message });
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      let p;
      if (existing) {
        p = await patch(`profiles/${existing.id}`, { name: f.name, url: isLocal ? undefined : f.url, publicUrl: f.publicUrl, username: f.username, password: f.password || undefined });
      } else {
        p = await post('profiles', { kind, name: f.name || KINDS.find((k) => k.id === kind).label, url: f.url, publicUrl: f.publicUrl, username: f.username, password: f.password, localPath: isLocal ? f.localPath : undefined, saveOffline });
      }
      // Link the folder (checked against the server's songs).
      if (!isLocal && f.localPath && f.localPath !== existing?.localPath) {
        try {
          const r = await post(`profiles/${p.id}/link`, { path: f.localPath });
          setLink({ ok: true, ...r.check });
          p = r;
        } catch (e) {
          setLink({ ok: false, error: e.message, ...(e.body || {}) });
          setBusy(false);
          onDone?.(p, { linkFailed: true });
          return;
        }
      }
      onDone?.(p);
    } catch (e) {
      if (e.body?.offline) setTest({ ok: false, offline: true, error: e.message });
      else fail(e);
    }
    setBusy(false);
  };

  const checkLink = async () => {
    if (!existing) return;
    setLink({ busy: true });
    try {
      const r = await post(`profiles/${existing.id}/link`, { path: f.localPath, dryRun: true });
      setLink(r);
    } catch (e) {
      setLink({ ok: false, error: e.message });
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {!existing && (
        <div className="choices">
          {KINDS.map((k) => {
            const found = detected?.servers?.find((s) => s.kind === k.id);
            return (
              <button key={k.id} type="button" className={cx('choice', kind === k.id && 'active')} onClick={() => setKind(k.id)}>
                {k.id === 'local' ? <HardDrive /> : <Server />}
                <span>
                  <b>
                    {k.label} {found && <span className="badge accent"><Sparkles size={11} /> found</span>}
                  </b>
                  <small>{found ? `Running at ${found.url}${found.version ? ` (version ${found.version})` : ''}` : k.note}</small>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className={cx('fields', !compact && 'two')}>
        <Field label="Name" hint="How this library is called in the app.">
          <input className="input" value={f.name} onChange={set('name')} placeholder={isLocal ? 'My music' : `${KINDS.find((k) => k.id === kind)?.label} at home`} />
        </Field>
        {!isLocal && (
          <Field label="Server address" hint="How this computer reaches the server, e.g. http://192.168.1.20:4533">
            <input className="input mono" value={f.url} onChange={set('url')} placeholder={`http://localhost:${KINDS.find((k) => k.id === kind)?.port}`} />
          </Field>
        )}
        {!isLocal && (
          <>
            <Field label="Username">
              <input className="input" value={f.username} onChange={set('username')} autoComplete="off" />
            </Field>
            <Field label="Password" hint={existing?.hasSecret ? 'Saved. Type a new one to change it.' : 'Stored encrypted on this server, never sent to browsers.'}>
              <input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" placeholder={existing?.hasSecret ? '••••••••' : ''} />
            </Field>
            <Field label="Public address (optional)" hint="What people outside your network use. Used for share links and “Open in …”.">
              <input className="input mono" value={f.publicUrl} onChange={set('publicUrl')} placeholder="https://music.example.com" />
            </Field>
          </>
        )}
        <Field label={isLocal ? 'Music folder' : 'Music folder on this computer (optional)'} hint={isLocal ? 'Where the music files are.' : 'The same files the server plays. Needed for editing tags, covers, lyrics and moving files. It is checked against the server before it is saved.'}>
          <div className="row">
            <input className="input mono" value={f.localPath} onChange={set('localPath')} placeholder="/mnt/music" />
            <button type="button" className="btn icon" onClick={() => setPicker(true)} aria-label="Browse">
              <FolderOpen />
            </button>
          </div>
        </Field>
      </div>
      {detected?.folders?.length > 0 && (
        <div className="chips">
          <span className="faint" style={{ fontSize: 12.5, alignSelf: 'center' }}>Found:</span>
          {detected.folders.map((d) => (
            <button key={d} type="button" className={cx('chip', f.localPath === d && 'active')} onClick={() => setF({ ...f, localPath: d })}>
              {d}
            </button>
          ))}
        </div>
      )}
      {test && !test.busy && (
        <Notice kind={test.ok ? 'accent' : test.offline ? 'warn' : 'danger'} icon={test.ok ? Wifi : test.offline ? WifiOff : CircleAlert}>
          {test.ok ? (
            <>
              <b>Connected.</b> {test.info?.type ? `${test.info.type} ` : ''}
              {test.info?.serverVersion || ''} {test.info?.openSubsonic ? '· OpenSubsonic' : ''}
            </>
          ) : test.offline ? (
            <>
              <b>The server can’t be reached right now.</b> {test.error}
              <div style={{ marginTop: 8 }}>
                <Toggle checked={saveOffline} onChange={setSaveOffline} label="Add it anyway" description="It shows as offline until it’s back." />
              </div>
            </>
          ) : (
            <>
              <b>That didn’t work:</b> {test.error}
            </>
          )}
        </Notice>
      )}
      {link && !link.busy && (
        <Notice kind={link.ok ? 'accent' : 'warn'} icon={link.ok ? Check : CircleAlert}>
          {link.ok ? (
            <>
              <b>Folder linked.</b> {link.found != null ? `${link.found} of ${link.checked} songs the server knows were found in it.` : ''}
            </>
          ) : (
            <>
              <b>The folder doesn’t match the server, so it was not linked.</b> {link.reason || link.error}
              {link.misses?.length ? (
                <div className="faint mono" style={{ marginTop: 6, fontSize: 12 }}>
                  Not found, e.g.: {link.misses.slice(0, 3).join(' · ')}
                </div>
              ) : null}
            </>
          )}
        </Notice>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        {existing && !isLocal && f.localPath && (
          <button type="button" className="btn" onClick={checkLink}>
            {link?.busy ? <Spinner size={14} /> : null} Check the folder
          </button>
        )}
        {!isLocal && (
          <button type="button" className="btn" onClick={runTest} disabled={!f.url}>
            {test?.busy ? <Spinner size={14} /> : <Wifi />} Test connection
          </button>
        )}
        <button type="button" className="btn primary" onClick={save} disabled={busy || (isLocal ? !f.localPath : !f.url)}>
          {busy ? <Spinner size={14} /> : <Check />} {existing ? 'Save' : 'Add library'}
        </button>
      </div>
      {picker && (
        <FolderPicker
          start={f.localPath || '/'}
          onClose={() => setPicker(false)}
          onPick={(p) => {
            setF({ ...f, localPath: p });
            setPicker(false);
          }}
        />
      )}
    </div>
  );
}

export function useDetect() {
  const [d, setD] = useState(null);
  useEffect(() => {
    get('detect').then(setD).catch(() => setD({ servers: [], folders: [], tools: {} }));
  }, []);
  return d;
}
