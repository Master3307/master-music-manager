import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Network, RefreshCw, Check, WifiOff, HardDrive } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post } from '../lib/api.js';
import { fmtTime, store, cx } from '../lib/util.js';
import { Empty, Notice, Spinner } from '../components/ui.jsx';

/** Every song every linked instance has, merged by identical audio. */
export default function Everywhere() {
  const { toast, afterJob } = useApp();
  const [q, setQ] = useState('');
  const nodes = useLoad(() => get('nodes'), []);
  const { data, loading, reload } = useLoad(() => get('nodes/catalog', { q }), [q]);
  useEffect(() => {
    if (nodes.data) store.set('hasNodes', nodes.data.nodes.length > 0);
  }, [nodes.data]);
  if (nodes.data && !nodes.data.nodes.length)
    return <Empty icon={Network} title="No other instances linked" action={<Link className="btn primary" to="/settings/instances">Link another computer</Link>}>Install Master Music Manager on another machine (like your PC) and link it to see and play everything from both in one place.</Empty>;
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Everywhere</h1>
          <p className="page-sub">Songs on your linked instances. The same recording on several machines counts once; it plays from whichever one is reachable.</p>
        </div>
        <button className="btn" onClick={async () => { const r = await post('nodes/sync'); toast('Syncing…'); afterJob(r.job).then(() => { reload(); nodes.reload(); }); }}><RefreshCw /> Sync now</button>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {(nodes.data?.nodes || []).map((n) => <span key={n.id} className={cx('chip', n.online && 'active')}>{n.online ? <Check /> : <WifiOff />} {n.name} · {n.tracks}</span>)}
      </div>
      <input className="input" placeholder="Search across everything" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 380, marginBottom: 14 }} />
      {loading && !data && <Spinner />}
      {data && !data.length && <Empty>Nothing found.</Empty>}
      {data?.map((t, i) => (
        <div key={i} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)', opacity: t.available ? 1 : 0.5 }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis"><b>{t.title || t.path}</b> <span className="muted">· {t.artist}</span>{t.album && <span className="faint"> · {t.album}</span>}</div>
          </div>
          {t.here && <span className="badge ok"><HardDrive size={11} /> here</span>}
          {t.on.map((o) => <span key={o.id} className={cx('badge', o.online ? 'accent' : '')}>{o.online ? '' : '⦸ '}{o.name}</span>)}
          {!t.available && <span className="badge danger">not available now</span>}
          <span className="faint tabular" style={{ width: 50, textAlign: 'right' }}>{fmtTime(t.duration)}</span>
        </div>
      ))}
      <Notice>Songs show as “not available” while every instance that has them is offline. They come back by themselves.</Notice>
    </>
  );
}
