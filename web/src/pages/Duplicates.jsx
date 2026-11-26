import { useState } from 'react';
import { Copy, Play, Check, Merge, ScanSearch, CircleAlert, Pause } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post } from '../lib/api.js';
import { fmtTime, fmtSize, plural, cx } from '../lib/util.js';
import { Empty, Notice, Spinner, Toggle, Segmented, useConfirm, Progress } from '../components/ui.jsx';

export default function Duplicates() {
  const { pid, fail, toast, afterJob, settings, jobs } = useApp();
  const p = usePlayer();
  const confirm = useConfirm();
  const [likely, setLikely] = useState(true);
  const { data, loading, error, reload } = useLoad(() => get(`p/${pid}/duplicates`, { likely: likely ? 1 : 0 }), [pid, likely]);
  const [choice, setChoice] = useState({});
  const [fill, setFill] = useState(true);
  const [scanJob, setScanJob] = useState(null);
  const [filter, setFilter] = useState('all');
  const job = scanJob ? jobs[scanJob] : null;

  const scan = async () => {
    const r = await post(`p/${pid}/duplicates/scan`, { autoMerge: false });
    setScanJob(r.job);
    await afterJob(r.job);
    reload();
  };
  const merge = async (g, forceConfirm) => {
    const keep = choice[g.id]?.keep ?? g.keep;
    const remove = choice[g.id]?.remove ?? g.tracks.filter((t) => t.id !== keep).map((t) => t.id);
    try {
      await post(`p/${pid}/merge`, { keep, remove, fillTags: fill, confirm: forceConfirm });
      toast(`Kept one, moved ${plural(remove.length, 'copy', 'copies')} to the trash`);
      reload();
    } catch (e) {
      if (e.body?.needsConfirm) {
        const ok = await confirm({
          title: 'These may not be the same song',
          confirm: 'Merge anyway',
          danger: true,
          body: (
            <div className="col">
              {e.body.checks.map((c) => (
                <div key={c.id}>
                  <b>{c.title}</b> <span className={cx('badge', c.score >= 75 ? 'ok' : c.score >= 45 ? 'warn' : 'danger')}>{c.score}% sure</span>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {c.notes.map((n, i) => <li key={i} style={{ color: n.ok === false ? 'var(--warn)' : undefined }}>{n.text}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          ),
        });
        if (ok) merge(g, true);
      } else fail(e);
    }
  };
  const mergeAllExact = async () => {
    const exact = (data || []).filter((g) => g.kind === 'exact');
    if (!(await confirm({ title: `Merge ${plural(exact.length, 'group')} of identical songs?`, body: 'For each, the best copy is kept (lossless, higher bitrate, more tags) and the rest go to the trash.', confirm: 'Merge all' }))) return;
    for (const g of exact) await post(`p/${pid}/merge`, { keep: g.keep, remove: g.tracks.filter((t) => t.id !== g.keep).map((t) => t.id), fillTags: fill }).catch(() => {});
    toast('Merged');
    reload();
  };
  const groups = (data || []).filter((g) => filter === 'all' || g.kind === filter);
  const exactCount = (data || []).filter((g) => g.kind === 'exact').length;
  const playOne = (t) => p.playList([{ id: `l:${t.id}`, localId: t.id, title: t.title, artist: t.artist, duration: t.duration, coverArt: t.cover ? `l:${t.id}` : null }], 0, pid);

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Duplicates</h1>
          <p className="page-sub">“Identical” means the same audio, even if names or tags differ. “Look alike” means same title, artist and length; listen before you decide.</p>
        </div>
        <button className="btn primary" onClick={scan} disabled={job && ['queued', 'running'].includes(job.status)}><ScanSearch /> Check the whole library</button>
      </div>
      {job && ['queued', 'running'].includes(job.status) && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <b>{job.detail || 'Fingerprinting…'}</b>
          <Progress value={job.progress} indeterminate={!job.progress} />
          <p className="faint" style={{ margin: '8px 0 0', fontSize: 12.5 }}>The first run reads every file once. Later runs only look at new ones.</p>
        </div>
      )}
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: `All ${data?.length ?? ''}` }, { value: 'exact', label: `Identical ${exactCount}` }, { value: 'likely', label: `Look alike ${(data?.length || 0) - exactCount}` }]} />
        <Toggle checked={likely} onChange={setLikely} label="Find look-alikes too" />
        <Toggle checked={fill} onChange={setFill} label="Copy missing tags to the one I keep" />
        <span className="grow" />
        {exactCount > 0 && <button className="btn" onClick={mergeAllExact}><Merge /> Merge all identical</button>}
      </div>
      {settings?.duplicates?.autoMergeExact && <Notice>Identical copies are merged automatically after every check (Settings → Library).</Notice>}
      {loading && !data && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {data && !groups.length && <Empty icon={Copy} title="No duplicates found">{!scanJob ? 'Run “Check the whole library” once so identical audio can be recognized.' : 'Nice and tidy.'}</Empty>}
      <div className="col" style={{ gap: 12 }}>
        {groups.slice(0, 300).map((g) => {
          const keep = choice[g.id]?.keep ?? g.keep;
          const remove = choice[g.id]?.remove ?? g.tracks.filter((t) => t.id !== keep).map((t) => t.id);
          return (
            <div key={g.id} className="panel" style={{ padding: 14 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className={cx('badge', g.kind === 'exact' ? 'ok' : g.score >= 75 ? 'accent' : 'warn')}>{g.kind === 'exact' ? 'Identical' : `${g.score}% alike`}</span>
                <b className="grow ellipsis">{g.tracks[0].artist} – {g.tracks[0].title}</b>
                <button className="btn small primary" onClick={() => merge(g)} disabled={!remove.length}><Merge /> Keep 1, remove {remove.length}</button>
              </div>
              {g.kind !== 'exact' && g.notes.some((n) => n.ok === false) && (
                <div className="row wrap" style={{ marginBottom: 8, gap: 6 }}>
                  {g.notes.filter((n) => n.ok === false).map((n) => <span key={n.text} className="badge warn"><CircleAlert size={11} /> {n.text}</span>)}
                </div>
              )}
              {g.tracks.map((t) => {
                const isKeep = t.id === keep;
                const isRemove = remove.includes(t.id);
                const now = p.current?.localId === t.id;
                return (
                  <div key={t.id} className="row" style={{ padding: '6px 4px', borderTop: '1px solid var(--line)', opacity: isRemove ? 0.6 : 1 }}>
                    <button className="btn icon small" onClick={() => (now ? p.toggle() : playOne(t))} aria-label="Listen">{now && p.playing ? <Pause /> : <Play />}</button>
                    <label className="row" style={{ gap: 6, cursor: 'pointer' }} title="Keep this one">
                      <input type="radio" name={g.id} checked={isKeep} onChange={() => setChoice({ ...choice, [g.id]: { keep: t.id, remove: g.tracks.filter((x) => x.id !== t.id).map((x) => x.id) } })} />
                      <span className="faint" style={{ fontSize: 12 }}>keep</span>
                    </label>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="ellipsis">{t.title} <span className="faint">· {t.album || 'no album'}</span></div>
                      <div className="faint mono ellipsis" style={{ fontSize: 11.5 }}>{t.path}</div>
                    </div>
                    <span className="badge">{t.ext?.toUpperCase()}{t.lossless ? ' lossless' : t.bitrate ? ` ${t.bitrate}k` : ''}</span>
                    <span className="tabular faint" style={{ width: 46, textAlign: 'right' }}>{fmtTime(t.duration)}</span>
                    <span className="tabular faint" style={{ width: 66, textAlign: 'right' }}>{fmtSize(t.size)}</span>
                    {!t.cover && <span className="badge warn">no cover</span>}
                    {isKeep && <span className="badge ok"><Check size={11} /> best</span>}
                    {!isKeep && (
                      <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={isRemove} onChange={(e) => setChoice({ ...choice, [g.id]: { keep, remove: e.target.checked ? [...remove, t.id] : remove.filter((x) => x !== t.id) } })} />
                        <span className="faint" style={{ fontSize: 12 }}>remove</span>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
