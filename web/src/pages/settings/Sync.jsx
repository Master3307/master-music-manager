import { useState } from 'react';
import { ArrowLeftRight, Plus, RefreshCw, Trash2, Pencil, HardDrive, Network, CircleAlert, Check } from 'lucide-react';
import { useApp, useLoad } from '../../lib/app.jsx';
import { get, post, patch, del } from '../../lib/api.js';
import { ago, cx, plural } from '../../lib/util.js';
import { Field, Toggle, Notice, Modal, Spinner, Empty, useConfirm, JobDetails } from '../../components/ui.jsx';

const EVERY = [
  [15, 'Every 15 minutes'],
  [60, 'Every hour'],
  [360, 'Every 6 hours'],
  [1440, 'Once a day'],
  [0, 'Only when I press Sync now'],
];

/** Keep libraries and linked instances completely in sync. */
export function SyncSettings() {
  const { profiles, fail, toast, afterJob } = useApp();
  const confirm = useConfirm();
  const groups = useLoad(() => get('sync'), []);
  const nodes = useLoad(() => get('nodes').then((r) => r.nodes), []);
  const [edit, setEdit] = useState(null);
  const places = [
    ...profiles.filter((p) => p.localPath).map((p) => ({ key: `p:${p.id}`, member: { profileId: p.id }, name: p.name, sub: p.localPath, icon: HardDrive })),
    ...(nodes.data || []).map((n) => ({ key: `n:${n.id}`, member: { nodeId: n.id }, name: n.name, sub: `Linked instance${n.online ? '' : ' (offline right now)'}`, icon: Network })),
  ];
  const keyOf = (m) => (m.nodeId ? `n:${m.nodeId}` : `p:${m.profileId}`);
  const runNow = async (g) => {
    try {
      const { job } = await post(`sync/${g.id}/run`);
      toast(`Syncing ${g.name}…`);
      groups.reload();
      afterJob(job).then((j) => {
        toast(j.status === 'done' ? `${g.name}: ${j.result.copied} copied, ${j.result.removed} removed` : j.error, { kind: j.status === 'done' ? 'ok' : 'error' });
        groups.reload();
      });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <h1 className="page-title">Keep in sync</h1>
      <p className="page-sub">Places in a sync all end up with every song of every other one: libraries on this machine, or other computers you linked. Songs are compared by their sound, so the same recording is never copied twice, even with different names or tags.</p>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn primary" disabled={places.length < 2} onClick={() => setEdit({ name: '', members: [], removals: false, edits: true, everyMinutes: 60 })}><Plus /> New sync</button>
        {places.length < 2 && <span className="faint" style={{ fontSize: 13 }}>You need two places first: two libraries with a music folder, or a library and a linked instance.</span>}
      </div>
      {groups.loading && !groups.data && <Spinner />}
      {groups.data && !groups.data.length && <Empty icon={ArrowLeftRight} title="Nothing is kept in sync yet">Make a sync to have, for example, your home server and your PC hold the same music.</Empty>}
      {groups.data?.map((g) => (
        <div key={g.id} className="panel col" style={{ gap: 10, marginBottom: 12, opacity: g.enabled ? 1 : 0.6 }}>
          <div className="row">
            <ArrowLeftRight size={18} />
            <b className="grow ellipsis">{g.name}</b>
            {g.running ? <span className="badge accent"><Spinner size={11} /> syncing</span> : g.lastResult?.ok === false ? <span className="badge danger" title={g.lastResult.error}><CircleAlert size={11} /> last run failed</span> : g.lastRun ? <span className="badge ok"><Check size={11} /> {ago(g.lastRun)}</span> : null}
          </div>
          <div className="chips">{g.members.map((m) => <span key={keyOf(m)} className="chip">{m.nodeId ? <Network /> : <HardDrive />} {m.name}</span>)}</div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {EVERY.find(([v]) => v === g.options.everyMinutes)?.[1] || `Every ${g.options.everyMinutes} minutes`} · removals {g.options.removals ? 'follow' : 'don’t follow'} · edits {g.options.edits ? 'follow' : 'don’t follow'}
            {g.lastResult?.ok && ` · last time: ${g.lastResult.copied} copied, ${g.lastResult.updated} updated, ${g.lastResult.removed} removed${g.lastResult.failed ? `, ${g.lastResult.failed} failed` : ''}`}
            {g.lastResult?.ok === false && ` · ${g.lastResult.error}`}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn small primary" disabled={Boolean(g.running)} onClick={() => runNow(g)}><RefreshCw /> Sync now</button>
            <button className="btn small ghost" onClick={() => setEdit({ id: g.id, name: g.name, members: g.members.map(({ nodeId, profileId }) => (nodeId ? { nodeId, profileId } : { profileId })), ...g.options })}><Pencil /> Edit</button>
            <Toggle checked={g.enabled} onChange={(v) => patch(`sync/${g.id}`, { enabled: v }).then(groups.reload, fail)} label="On" />
            <span className="grow" />
            <button className="btn small ghost danger" onClick={async () => { if (await confirm({ title: `Stop syncing ${g.name}?`, body: 'No songs are deleted. The places just stop being kept in sync.', confirm: 'Stop syncing', danger: true })) del(`sync/${g.id}`).then(groups.reload, fail); }}><Trash2 /> Remove</button>
          </div>
          {(g.running || g.lastJob) && <JobDetails jobId={g.running || g.lastJob} live={Boolean(g.running)} />}
        </div>
      ))}
      <Notice>
        A place that can’t be reached (a disk that isn’t mounted, a computer that’s off) is simply left out of that run and catches up later. If a place suddenly misses a large part of its songs, that’s treated as an accident, not as deleting them. Removed songs always go to the trash first.
      </Notice>
      {edit && (
        <SyncEditor
          value={edit}
          places={places}
          keyOf={keyOf}
          onClose={() => setEdit(null)}
          onSave={async (v) => {
            try {
              if (v.id) await patch(`sync/${v.id}`, v);
              else {
                const r = await post('sync', v);
                toast(`Syncing ${r.name}…`);
                if (r.job) afterJob(r.job).then(groups.reload);
              }
              setEdit(null);
              groups.reload();
            } catch (e) {
              fail(e);
            }
          }}
        />
      )}
    </>
  );
}

function SyncEditor({ value, places, keyOf, onClose, onSave }) {
  const [v, setV] = useState(value);
  const picked = new Set(v.members.map(keyOf));
  const toggle = (pl) => setV({ ...v, members: picked.has(pl.key) ? v.members.filter((m) => keyOf(m) !== pl.key) : [...v.members, pl.member] });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={v.id ? 'Edit sync' : 'New sync'}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={v.members.length < 2 || busy} onClick={async () => { setBusy(true); await onSave(v); setBusy(false); }}>
            {v.id ? 'Save' : `Keep ${plural(v.members.length, 'place')} in sync`}
          </button>
        </>
      }
    >
      <Field label="Places" hint="Pick two or more. Each one gets every song the others have.">
        <div className="col" style={{ gap: 6 }}>
          {places.map((pl) => (
            <label key={pl.key} className={cx('choice', picked.has(pl.key) && 'active')} style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(pl.key)} onChange={() => toggle(pl)} />
              <pl.icon />
              <span><b>{pl.name}</b><small>{pl.sub}</small></span>
            </label>
          ))}
        </div>
      </Field>
      <Field label="Name" hint="Optional.">
        <input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="For example: Server ⇄ PC" />
      </Field>
      <Field label="How often">
        <select className="select" value={v.everyMinutes} onChange={(e) => setV({ ...v, everyMinutes: Number(e.target.value) })}>
          {EVERY.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
        </select>
      </Field>
      <Toggle checked={v.edits} onChange={(x) => setV({ ...v, edits: x })} label="Edits follow" description="When a song’s tags or cover change in one library, the other libraries get the newer file (with a restore point for the old one)." />
      <Toggle checked={v.removals} onChange={(x) => setV({ ...v, removals: x })} label="Removals follow" description="A song you delete in one place is deleted everywhere (into the trash). Off: it comes back from the other places." />
      {v.members.some((m) => m.nodeId) && <Notice>For a linked instance, it has to share its songs with this one and accept songs from it (both are on by default in Linked instances).</Notice>}
    </Modal>
  );
}
