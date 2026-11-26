import { useState } from 'react';
import { Share2, Copy, ExternalLink, Trash2, Pencil, Globe, Lock, EyeOff, Download, Check } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, patch, del } from '../lib/api.js';
import { ago, date, copy, cx, plural } from '../lib/util.js';
import { Empty, Field, Modal, Notice, Spinner, Segmented, Toggle, CopyField, useConfirm } from '../components/ui.jsx';

const KIND = { track: 'Song', album: 'Album', artist: 'Artist', playlist: 'Playlist', radio: 'Radio', selection: 'Songs' };

export default function Shares() {
  const { fail, toast, settings } = useApp();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useLoad(() => get('shares'), []);
  const [edit, setEdit] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const save = async () => {
    try {
      const r = await patch(`shares/${edit.id}`, { name: edit.name, description: edit.description, visibility: edit.visibility, allowDownload: edit.allowDownload, expiresAt: edit.expiresAt, key: edit.key, profileId: edit.profileId });
      if (r.key) setNewKey(r.key);
      setEdit(null);
      reload();
      toast('Share saved');
    } catch (e) {
      fail(e);
    }
  };
  const shares = data?.shares || [];
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Shares</h1>
          <p className="page-sub">Links you gave out, here and on your server. Share anything from its menu: songs, albums, playlists, artists, radio stations.</p>
        </div>
      </div>
      {!settings?.public?.url && <Notice kind="warn">Set this app’s public address in Settings → General, so links work outside your network and previews show up in Discord and chats.</Notice>}
      {data?.errors?.map((e) => <Notice key={e.profile} kind="warn">{e.profile}: {e.error}</Notice>)}
      {loading && !data && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {data && !shares.length && <Empty icon={Share2} title="Nothing shared yet">Right-click a song or use the share button on an album, playlist or artist.</Empty>}
      <div className="col" style={{ gap: 8 }}>
        {shares.map((s) => (
          <div key={`${s.source}-${s.id}`} className="panel row" style={{ padding: '12px 14px' }}>
            <span className="badge">{KIND[s.kind] || 'Share'}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis"><b>{s.name || s.title || s.description || 'Untitled share'}</b> <span className="faint mono" style={{ fontSize: 12 }}>{s.id}</span></div>
              <div className="faint" style={{ fontSize: 12.5 }}>
                {plural(s.count || 0, 'song')} · {s.views || 0} views{s.lastVisited ? ` · last ${ago(s.lastVisited)}` : ''} · made {ago(s.createdAt)}{s.expiresAt ? ` · until ${date(s.expiresAt)}` : ''}
                {s.source === 'navidrome' ? ` · on ${s.profileName}` : s.remoteId ? ' · also on the server' : ''}
              </div>
            </div>
            {s.visibility === 'public' ? <Globe size={16} className="faint" aria-label="Public" /> : s.visibility === 'key' ? <Lock size={16} className="faint" aria-label="Needs a key" /> : <EyeOff size={16} className="faint" aria-label="Private" />}
            {s.allowDownload && <Download size={16} className="faint" aria-label="Downloads allowed" />}
            <button className="btn icon small ghost" onClick={() => copy(s.url).then(() => toast('Link copied'))} aria-label="Copy link"><Copy /></button>
            <a className="btn icon small ghost" href={s.url} target="_blank" rel="noopener noreferrer" aria-label="Open"><ExternalLink /></a>
            <button className="btn icon small ghost" onClick={() => setEdit({ ...s, key: '' })} aria-label="Edit"><Pencil /></button>
            <button className="btn icon small ghost danger" aria-label="Delete" onClick={async () => { if (await confirm({ title: 'Delete this share?', body: 'The link stops working.', danger: true, confirm: 'Delete' })) del(`shares/${s.id}`, { profileId: s.profileId, alsoOnService: 1 }).then(reload, fail); }}><Trash2 /></button>
          </div>
        ))}
      </div>
      {edit && (
        <Modal title="Edit share" onClose={() => setEdit(null)} footer={<><button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save}><Check /> Save</button></>}>
          <Field label="Link"><CopyField value={edit.url} /></Field>
          <Field label="Name"><input className="input" value={edit.name || ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          {edit.source !== 'navidrome' && (
            <>
              <Field label="Description"><textarea className="textarea" rows={2} value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
              <Field label="Who can open it"><Segmented value={edit.visibility} onChange={(v) => setEdit({ ...edit, visibility: v })} options={[{ value: 'public', label: 'Anyone', icon: Globe }, { value: 'key', label: 'Needs a key', icon: Lock }, { value: 'private', label: 'Only me', icon: EyeOff }]} /></Field>
              {edit.visibility === 'key' && <Field label="New key" hint="Leave empty to keep the current one (or get a new one if there is none)."><input className="input mono" value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} /></Field>}
              <Toggle checked={edit.allowDownload} onChange={(v) => setEdit({ ...edit, allowDownload: v })} label="Allow downloads" />
            </>
          )}
          <Field label="Expires">
            <input className="input" type="date" value={edit.expiresAt ? new Date(edit.expiresAt).toISOString().slice(0, 10) : ''} onChange={(e) => setEdit({ ...edit, expiresAt: e.target.value ? Date.parse(e.target.value) : null })} />
          </Field>
        </Modal>
      )}
      {newKey && <Modal title="The new key" onClose={() => setNewKey(null)}><p className="muted" style={{ margin: 0 }}>Give this to the people who should open the share. It’s shown only now.</p><CopyField value={newKey} /></Modal>}
    </>
  );
}

export { cx };
