import { useEffect, useState } from 'react';
import { ArrowRightLeft, Trash2, HardDrive, Network } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post } from '../lib/api.js';
import { plural } from '../lib/util.js';
import { Modal, Segmented, Toggle, Notice, Spinner, Field } from './ui.jsx';

function Places({ value, onChange, exclude, showAll }) {
  const { profiles } = useApp();
  const nodes = useLoad(() => get('nodes').catch(() => ({ nodes: [] })), []);
  const libs = profiles.filter((p) => p.localPath && p.id !== exclude);
  const has = (t) => value.some((v) => (t.profileId ? v.profileId === t.profileId && !v.nodeId : v.nodeId === t.nodeId));
  const flip = (t) => onChange(has(t) ? value.filter((v) => !(t.profileId ? v.profileId === t.profileId && !v.nodeId : v.nodeId === t.nodeId)) : [...value, t]);
  return (
    <div className="col" style={{ gap: 6 }}>
      {libs.map((p) => (
        <label key={p.id} className="choice" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={has({ profileId: p.id })} onChange={() => flip({ profileId: p.id })} />
          <HardDrive />
          <span><b>{p.name}</b><small className="mono">{p.localPath}</small></span>
        </label>
      ))}
      {(nodes.data?.nodes || []).map((n) => (
        <label key={n.id} className="choice" style={{ alignItems: 'center', opacity: n.online ? 1 : 0.6 }}>
          <input type="checkbox" checked={has({ nodeId: n.id })} onChange={() => flip({ nodeId: n.id })} />
          <Network />
          <span><b>{n.name}</b><small>{n.online ? `Linked instance · ${n.tracks} songs` : 'Linked instance · offline right now'}</small></span>
        </label>
      ))}
      {!libs.length && !(nodes.data?.nodes || []).length && !showAll && <Notice>There is nowhere else to put songs yet. Add another library with a folder, or link another computer under Settings → Linked instances.</Notice>}
    </div>
  );
}

export function TransferDialog({ ids, onClose }) {
  const { pid, toast, fail, afterJob } = useApp();
  const [to, setTo] = useState([]);
  const [mode, setMode] = useState('copy');
  const [skip, setSkip] = useState(true);
  const go = async () => {
    try {
      const r = await post('transfer', { from: pid, ids, to, mode, skipExisting: skip });
      toast(`${mode === 'move' ? 'Moving' : 'Copying'} ${plural(ids.length, 'song')}…`);
      onClose();
      afterJob(r.job).then((j) => j.status === 'done' ? toast(`Done: ${j.result.done} handled, ${j.result.skipped} already there`) : fail(j.error));
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={`${mode === 'move' ? 'Move' : 'Copy'} ${plural(ids.length, 'song')}`}
      icon={<ArrowRightLeft />}
      onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!to.length} onClick={go}>{mode === 'move' ? 'Move' : 'Copy'}</button></>}
    >
      <Segmented value={mode} onChange={setMode} options={[{ value: 'copy', label: 'Copy (keep them here)' }, { value: 'move', label: 'Move (remove them here)' }]} />
      <Places value={to} onChange={setTo} exclude={pid} />
      <Toggle checked={skip} onChange={setSkip} label="Skip songs that are already there" description="Compared by the actual audio, so renamed or retagged copies count as the same." />
      {mode === 'move' && <Notice kind="warn">Moved songs go to this library’s trash once they arrived everywhere, so it can be undone.</Notice>}
    </Modal>
  );
}

export function RemoveDialog({ ids, onClose, onDone }) {
  const { pid, profile, toast, fail, afterJob } = useApp();
  const [scope, setScope] = useState('here');
  const [places, setPlaces] = useState([]);
  const [preview, setPreview] = useState(null);
  const { isAdmin } = useApp();
  const [what, setWhat] = useState('trash'); // trash | out
  const [folder, setFolder] = useState('');
  const target = scope === 'here' ? [{ profileId: pid }] : scope === 'all' ? 'all' : [{ profileId: pid }, ...places];
  useEffect(() => {
    setPreview(null);
    post('remove-everywhere', { from: pid, ids, places: target, preview: true }).then(setPreview).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, JSON.stringify(places)]);
  const go = async () => {
    try {
      const r = await post('remove-everywhere', { from: pid, ids, places: target, takeOut: what === 'out' ? folder.trim() || true : undefined });
      onClose();
      afterJob(r.job).then((j) => {
        if (j.status === 'done') toast(j.result.folder ? `${plural(j.result.removed, 'song')} taken out, now in ${j.result.folder}` : `${j.result.removed} files moved to the trash`, { kind: 'ok' });
        else fail(j.error);
        onDone?.();
      });
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={`Remove ${plural(ids.length, 'song')}`}
      icon={<Trash2 />}
      onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className={what === 'out' ? 'btn primary' : 'btn danger solid'} onClick={go}>{what === 'out' ? 'Take out' : 'Remove'}</button></>}
    >
      <Segmented value={scope} onChange={setScope} options={[{ value: 'here', label: `From ${profile?.name}` }, { value: 'some', label: 'From some places' }, { value: 'all', label: 'From everywhere' }]} />
      {scope === 'some' && <Places value={places} onChange={setPlaces} exclude={pid} />}
      {preview ? (
        <div className="panel" style={{ padding: 12 }}>
          {preview.places.map((p, i) => (
            <div key={i} className="row"><span className="grow">{p.name || 'Unknown'}</span><b>{plural(p.count, 'file')}</b></div>
          ))}
          {preview.unhashed > 0 && scope !== 'here' && <p className="faint" style={{ margin: '6px 0 0', fontSize: 12.5 }}>{preview.unhashed} of these were never fingerprinted, so copies elsewhere can’t be found yet (run Duplicates once).</p>}
        </div>
      ) : (
        <Spinner />
      )}
      <Field label="What happens to the files">
        <Segmented value={what} onChange={setWhat} options={[{ value: 'trash', label: 'Into the trash' }, { value: 'out', label: 'Take them out, keep the files' }]} />
      </Field>
      {what === 'out' ? (
        <>
          <p className="muted" style={{ margin: 0 }}>The songs leave the library and your music server, but the files are kept in a folder outside it, sorted as before. Linked instances still put theirs in the trash.</p>
          {isAdmin && (
            <Field label="Folder" hint="Outside your libraries. Empty: the suggested one.">
              <input className="input mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={preview?.takeOutFolder || ''} />
            </Field>
          )}
          {!isAdmin && preview?.takeOutFolder && <p className="faint mono" style={{ margin: 0, fontSize: 12.5 }}>{preview.takeOutFolder}</p>}
        </>
      ) : (
        <Notice>Everything goes to the trash on each side first. Empty the trash to free the space.</Notice>
      )}
    </Modal>
  );
}
