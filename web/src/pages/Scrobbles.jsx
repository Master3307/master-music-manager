import { useState } from 'react';
import { History, Upload, Download, Send, Trash2, Database, Copy } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post, uploadFile, api } from '../lib/api.js';
import { ago, plural, date } from '../lib/util.js';
import { Empty, Field, Modal, Notice, Spinner, useConfirm } from '../components/ui.jsx';

export default function Scrobbles() {
  const { profiles, pid, caps, settings, fail, toast, afterJob, isAdmin } = useApp();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const { data, loading, reload } = useLoad(() => get('scrobbles', { q, limit: 100, offset: page * 100 }), [q, page]);
  const [imp, setImp] = useState(null);
  const [lfm, setLfm] = useState(null);
  const ndProfiles = profiles.filter((p) => p.kind === 'navidrome');

  const pickFile = async (file) => {
    try {
      const id = await uploadFile(file);
      const preview = await api('scrobbles/import', { method: 'POST', query: { upload: id, preview: 1 }, body: '' });
      setImp({ file, preview });
    } catch (e) {
      fail(e);
    }
  };
  const doImport = async () => {
    try {
      const id = await uploadFile(imp.file);
      const r = await api('scrobbles/import', { method: 'POST', query: { upload: id, profile: pid, user: imp.user || '' }, body: '' });
      toast(`${r.added} new listens, ${r.skipped} already known (${r.format})`);
      setImp(null);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Scrobbles</h1>
          <p className="page-sub">Every listen. Imports merge: a listen that’s already here (same song within 90 seconds) is never counted twice.</p>
        </div>
        <label className="btn primary"><Upload /> Import a file<input type="file" hidden accept=".csv,.tsv,.json,.jsonl,.ndjson,.log,.txt" onChange={(e) => e.target.files[0] && pickFile(e.target.files[0])} /></label>
      </div>
      <div className="fields" style={{ marginBottom: 18 }}>
        <div className="panel">
          <h3>Bring in your history</h3>
          <p className="muted" style={{ fontSize: 13 }}>Files from Last.fm (lastfm-to-csv, JSON), ListenBrainz (export), Spotify (Extended streaming history, StreamingHistory*.json), Rockbox / iPod <span className="mono">.scrobbler.log</span>, Spindle, or any CSV / JSON with artist, title and a time.</p>
          <div className="row wrap">
            {!settings?.privacy?.fullLocal && <button className="btn small" onClick={() => setLfm({ user: '', apiKey: '' })}>From Last.fm directly</button>}
            {ndProfiles.length > 0 && isAdmin && (
              <button className="btn small" onClick={async () => { try { const r = await post('scrobbles/navidrome-db', { profileId: ndProfiles[0].id }); toast('Reading Navidrome’s history…'); afterJob(r.job).then((j) => { toast(j.status === 'done' ? 'Navidrome’s history is in' : j.error, { kind: j.status === 'done' ? 'ok' : 'error' }); reload(); }); } catch (e) { fail(e); } }}><Database /> From Navidrome’s database</button>
            )}
          </div>
        </div>
        <div className="panel">
          <h3>Take it with you</h3>
          <div className="row wrap" style={{ marginTop: 8 }}>
            {[['csv', 'CSV'], ['json', 'JSON'], ['listenbrainz', 'ListenBrainz'], ['lastfm-csv', 'Last.fm CSV'], ['scrobbler-log', '.scrobbler.log']].map(([f, l]) => (
              <a key={f} className="btn small" href={`/api/scrobbles/export?format=${f}`}><Download /> {l}</a>
            ))}
          </div>
        </div>
        <div className="panel">
          <h3>Tidy up</h3>
          <div className="row wrap" style={{ marginTop: 8 }}>
            {caps.service && <button className="btn small" onClick={async () => { if (!(await confirm({ title: `Send listens to ${caps.kindLabel}?`, body: 'Play counts on the server go up for every listen it doesn’t know yet. Only do this once per import.', confirm: 'Send' }))) return; const r = await post('scrobbles/push', { profileId: pid, sources: ['lastfm', 'listenbrainz', 'spotify-streaming-history', 'csv', 'last.fm-csv', 'json'] }); afterJob(r.job).then((j) => toast(j.status === 'done' ? `${j.result.sent} sent, ${j.result.missing} not in the library` : j.error)); }}><Send /> Send imports to {caps.kindLabel}</button>}
            <button className="btn small" onClick={async () => { const r = await post('scrobbles/dedupe'); toast(`${r.removed} double listens removed`); reload(); }}><Copy /> Remove doubles</button>
          </div>
        </div>
      </div>
      <input className="input" placeholder="Search listens" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} style={{ maxWidth: 360, marginBottom: 12 }} />
      {loading && !data && <Spinner />}
      {data && !data.total && <Empty icon={History} title="No listens yet">Install the Navidrome plugin, play something here, or import a file.</Empty>}
      {data?.items?.map((s) => (
        <div key={s.id} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis"><b>{s.title}</b> <span className="muted">· {s.artist}</span>{s.album ? <span className="faint"> · {s.album}</span> : null}</div>
          </div>
          <span className="badge">{s.source}</span>
          {s.username && <span className="faint" style={{ fontSize: 12 }}>{s.username}</span>}
          <span className="faint tabular" style={{ fontSize: 12, width: 110, textAlign: 'right' }} title={new Date(s.ts * 1000).toLocaleString()}>{ago(s.ts)}</span>
          <button className="btn icon small ghost" aria-label="Remove" onClick={async () => { await api('scrobbles', { method: 'DELETE', body: { ids: [s.id] } }).catch(fail); reload(); }}><Trash2 /></button>
        </div>
      ))}
      {data && data.total > 100 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button className="btn small" disabled={!page} onClick={() => setPage(page - 1)}>Newer</button>
          <span className="faint">{page * 100 + 1}–{Math.min(data.total, (page + 1) * 100)} of {data.total.toLocaleString()}</span>
          <button className="btn small" disabled={(page + 1) * 100 >= data.total} onClick={() => setPage(page + 1)}>Older</button>
        </div>
      )}
      {imp && (
        <Modal title={`Import ${imp.file.name}`} onClose={() => setImp(null)} footer={<><button className="btn ghost" onClick={() => setImp(null)}>Cancel</button><button className="btn primary" onClick={doImport}>Import {plural(imp.preview.count, 'listen')}</button></>}>
          <Notice kind="accent">Looks like <b>{imp.preview.format}</b>: {plural(imp.preview.count, 'listen')} from {date(imp.preview.first)} to {date(imp.preview.last)}.</Notice>
          <Field label="Whose listens are these? (optional)" hint="A Navidrome user name keeps per-person stats apart."><input className="input" value={imp.user || ''} onChange={(e) => setImp({ ...imp, user: e.target.value })} /></Field>
          <div className="codeblock" style={{ maxHeight: 220 }}>{imp.preview.sample.map((x) => `${x.ts ? new Date(x.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '????'}  ${x.artist} – ${x.title}`).join('\n')}</div>
        </Modal>
      )}
      {lfm && (
        <Modal title="Import from Last.fm" onClose={() => setLfm(null)} footer={<><button className="btn ghost" onClick={() => setLfm(null)}>Cancel</button><button className="btn primary" disabled={!lfm.user} onClick={async () => { try { const r = await post('scrobbles/lastfm', lfm); setLfm(null); toast('Reading your Last.fm history… (Activity shows progress)'); afterJob(r.job).then(reload); } catch (e) { fail(e); } }}>Import</button></>}>
          <Field label="Last.fm user name"><input className="input" value={lfm.user} onChange={(e) => setLfm({ ...lfm, user: e.target.value })} /></Field>
          <Field label="API key" hint="Free: last.fm/api/account/create. Saved one in Settings → Privacy is used when this is empty."><input className="input mono" value={lfm.apiKey} onChange={(e) => setLfm({ ...lfm, apiKey: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}
