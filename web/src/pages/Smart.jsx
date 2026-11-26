import { useEffect, useState } from 'react';
import { Plus, Trash2, Wand2, Save, Eye, FolderTree } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post, del } from '../lib/api.js';
import { Field, Notice, Spinner, Empty, Segmented, useConfirm } from '../components/ui.jsx';
import { SongList } from '../components/Songs.jsx';

const OPS = {
  text: [['contains', 'contains'], ['notContains', 'does not contain'], ['is', 'is'], ['isNot', 'is not'], ['startsWith', 'starts with'], ['endsWith', 'ends with']],
  number: [['is', 'is'], ['isNot', 'is not'], ['gt', 'more than'], ['lt', 'less than'], ['inTheRange', 'between']],
  date: [['inTheLast', 'in the last (days)'], ['notInTheLast', 'not in the last (days)'], ['before', 'before'], ['after', 'after'], ['inTheRange', 'between']],
  bool: [['is', 'is'], ['isNot', 'is not']],
};
const TEMPLATES = [
  { name: 'Recently added', rules: { all: [{ inTheLast: { dateadded: 30 } }], sort: 'dateadded', order: 'desc', limit: 200 } },
  { name: 'Loved but forgotten', rules: { all: [{ is: { loved: true } }, { notInTheLast: { lastplayed: 90 } }], sort: 'random', limit: 100 } },
  { name: 'Never played', rules: { all: [{ is: { playcount: 0 } }], sort: 'random', limit: 200 } },
  { name: 'Top rated', rules: { all: [{ gt: { rating: 3 } }], sort: 'rating', order: 'desc' } },
  { name: '2000s throwback', rules: { all: [{ inTheRange: { year: [2000, 2009] } }], sort: 'random', limit: 150 } },
  { name: 'Short and sweet', rules: { all: [{ lt: { duration: 150 } }], sort: 'random', limit: 100 } },
  { name: 'Lossless only', rules: { any: [{ is: { filetype: 'flac' } }, { is: { filetype: 'wav' } }, { is: { filetype: 'alac' } }] } },
];

const blankRule = () => ({ contains: { title: '' } });

function RuleRow({ rule, fields, onChange, onRemove }) {
  const [op, cond] = Object.entries(rule)[0];
  const [field, value] = Object.entries(cond)[0];
  const def = fields.find((f) => f.key === field) || fields[0];
  const ops = OPS[def?.type || 'text'];
  const set = (nf, nop, nv) => onChange({ [nop]: { [nf]: nv } });
  const range = op === 'inTheRange';
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <select className="select" style={{ width: 190 }} value={field} onChange={(e) => {
        const nd = fields.find((f) => f.key === e.target.value);
        const nop = OPS[nd.type][0][0];
        set(e.target.value, nop, nd.type === 'bool' ? true : nd.type === 'number' ? 0 : nd.type === 'date' ? 30 : '');
      }}>
        {fields.map((f) => <option key={f.key} value={f.key}>{f.label}{f.service ? ' ·' : ''}</option>)}
      </select>
      <select className="select" style={{ width: 200 }} value={op} onChange={(e) => set(field, e.target.value, e.target.value === 'inTheRange' ? (Array.isArray(value) ? value : [value || 0, value || 0]) : Array.isArray(value) ? value[0] : value)}>
        {ops.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {def?.type === 'bool' ? (
        <select className="select" style={{ width: 120 }} value={String(value)} onChange={(e) => set(field, op, e.target.value === 'true')}>
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      ) : range ? (
        <>
          <input className="input" style={{ width: 130 }} type={def.type === 'date' ? 'date' : 'number'} value={value?.[0] ?? ''} onChange={(e) => set(field, op, [def.type === 'number' ? Number(e.target.value) : e.target.value, value?.[1]])} />
          <span className="faint">and</span>
          <input className="input" style={{ width: 130 }} type={def.type === 'date' ? 'date' : 'number'} value={value?.[1] ?? ''} onChange={(e) => set(field, op, [value?.[0], def.type === 'number' ? Number(e.target.value) : e.target.value])} />
        </>
      ) : (
        <input className="input grow" style={{ minWidth: 160 }} type={def?.type === 'number' || ['inTheLast', 'notInTheLast'].includes(op) ? 'number' : def?.type === 'date' ? 'date' : 'text'} value={value ?? ''} onChange={(e) => set(field, op, def?.type === 'number' || ['inTheLast', 'notInTheLast'].includes(op) ? Number(e.target.value) : e.target.value)} />
      )}
      <button className="btn icon ghost" onClick={onRemove} aria-label="Remove rule"><Trash2 /></button>
    </div>
  );
}

function Group({ group, fields, onChange, onRemove, depth = 0 }) {
  const kind = group.all ? 'all' : 'any';
  const items = group[kind] || [];
  const setItems = (list) => onChange({ [kind]: list });
  return (
    <div className="panel" style={{ padding: 14, background: depth ? 'var(--surface)' : undefined }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="muted">Songs that match</span>
        <Segmented value={kind} onChange={(k) => onChange({ [k]: items })} options={[{ value: 'all', label: 'all' }, { value: 'any', label: 'any' }]} />
        <span className="muted grow">of these</span>
        {onRemove && <button className="btn icon small ghost" onClick={onRemove} aria-label="Remove group"><Trash2 /></button>}
      </div>
      <div className="col" style={{ gap: 8 }}>
        {items.map((r, i) =>
          r.all || r.any ? (
            <Group key={i} group={r} fields={fields} depth={depth + 1} onChange={(n) => setItems(items.map((x, j) => (j === i ? n : x)))} onRemove={() => setItems(items.filter((_, j) => j !== i))} />
          ) : (
            <RuleRow key={i} rule={r} fields={fields} onChange={(n) => setItems(items.map((x, j) => (j === i ? n : x)))} onRemove={() => setItems(items.filter((_, j) => j !== i))} />
          ),
        )}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => setItems([...items, blankRule()])}><Plus /> Rule</button>
        {depth < 2 && <button className="btn small ghost" onClick={() => setItems([...items, { any: [blankRule()] }])}><Plus /> Group</button>}
      </div>
    </div>
  );
}

export default function Smart() {
  const { pid, caps, fail, toast } = useApp();
  const confirm = useConfirm();
  const fields = useLoad(() => get('smart/fields'), []);
  const list = useLoad(() => get(`p/${pid}/smart`), [pid]);
  const [cur, setCur] = useState({ name: '', comment: '', path: null, rules: { all: [blankRule()], sort: 'title', order: 'asc', limit: '' } });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const r = cur.rules;
  const group = r.all ? { all: r.all } : { any: r.any || [] };
  const usesService = JSON.stringify(group).match(/loved|playcount|lastplayed|rating|dateloved/);
  const runPreview = async () => {
    try {
      setPreview(await post(`p/${pid}/smart/preview`, { rules: { ...group, sort: r.sort, order: r.order, limit: r.limit ? Number(r.limit) : undefined } }));
    } catch (e) {
      fail(e);
    }
  };
  useEffect(() => {
    const t = setTimeout(runPreview, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(cur.rules), pid]);
  const save = async () => {
    setBusy(true);
    try {
      const res = await post(`p/${pid}/smart`, { name: cur.name, comment: cur.comment, path: cur.path, rules: { ...group, sort: r.sort || undefined, order: r.order || undefined, limit: r.limit ? Number(r.limit) : undefined } });
      toast(`Saved as ${res.path}. ${caps.service ? 'The server picks it up with its next scan (asked for one).' : ''}`);
      setCur({ ...cur, path: res.path });
      list.reload();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  if (!caps.files) return <Empty icon={Wand2} title="Smart playlists need the music folder">They are small files in your library that Navidrome reads. Link the folder in Settings → Libraries.</Empty>;
  const F = fields.data || [];
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Smart playlists</h1>
          <p className="page-sub">Playlists that fill themselves from rules. Saved as Navidrome <span className="mono">.nsp</span> files in your library, so the server and every app see them.</p>
        </div>
        <button className="btn" onClick={() => { setCur({ name: '', comment: '', path: null, rules: { all: [blankRule()], sort: 'title', order: 'asc', limit: '' } }); setPreview(null); }}><Plus /> New</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 20 }}>
        <div className="col" style={{ gap: 14 }}>
          <div className="fields two">
            <Field label="Name"><input className="input" value={cur.name} onChange={(e) => setCur({ ...cur, name: e.target.value })} placeholder="e.g. Late night phonk" /></Field>
            <Field label="Description"><input className="input" value={cur.comment} onChange={(e) => setCur({ ...cur, comment: e.target.value })} /></Field>
          </div>
          {F.length ? <Group group={group} fields={F} onChange={(g) => setCur({ ...cur, rules: { ...g, sort: r.sort, order: r.order, limit: r.limit } })} /> : <Spinner />}
          <div className="fields" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <Field label="Sort by">
              <select className="select" value={r.sort || ''} onChange={(e) => setCur({ ...cur, rules: { ...r, sort: e.target.value } })}>
                <option value="random">Random</option>
                {F.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Order">
              <select className="select" value={r.order || 'asc'} onChange={(e) => setCur({ ...cur, rules: { ...r, order: e.target.value } })}>
                <option value="asc">A → Z, low → high, old → new</option>
                <option value="desc">Z → A, high → low, new → old</option>
              </select>
            </Field>
            <Field label="At most" hint="Empty = no limit"><input className="input" type="number" min={1} value={r.limit || ''} onChange={(e) => setCur({ ...cur, rules: { ...r, limit: e.target.value } })} /></Field>
          </div>
          {usesService && <Notice>Rules marked with · (play count, loved, rating, last played) come from the server, so the preview below ignores them.</Notice>}
          <div className="row">
            <button className="btn" onClick={runPreview}><Eye /> Preview</button>
            <button className="btn primary" onClick={save} disabled={!cur.name || busy}><Save /> Save</button>
            {cur.path && <span className="faint mono" style={{ fontSize: 12 }}><FolderTree size={13} /> {cur.path}</span>}
          </div>
          {preview && (
            <section className="section" style={{ marginTop: 10 }}>
              <div className="section-head"><h2>{preview.total} songs{preview.approximate ? ' (roughly)' : ''}</h2></div>
              {preview.tracks.length ? <SongList songs={preview.tracks} pid={pid} numbered="index" /> : <Empty>No song matches yet.</Empty>}
            </section>
          )}
        </div>
        <aside className="col" style={{ gap: 10 }}>
          <b>Start from an idea</b>
          {TEMPLATES.map((t) => (
            <button key={t.name} className="choice" style={{ padding: '10px 12px' }} onClick={() => setCur({ name: t.name, comment: '', path: null, rules: { ...t.rules, limit: t.rules.limit || '' } })}>
              <Wand2 /><span><b>{t.name}</b></span>
            </button>
          ))}
          <b style={{ marginTop: 14 }}>In your library</b>
          {list.loading && <Spinner />}
          {(list.data || []).map((s) => (
            <div key={s.path} className="row panel" style={{ padding: '8px 10px' }}>
              <button className="grow menu-item" style={{ padding: 4 }} onClick={() => setCur({ name: s.rules?.name || s.path.split('/').pop().replace(/\.nsp$/, ''), comment: s.rules?.comment || '', path: s.path, rules: { all: s.rules?.all, any: s.rules?.any, sort: s.rules?.sort, order: s.rules?.order, limit: s.rules?.limit || '' } })}>
                <span className="ellipsis">{s.rules?.name || s.path}</span>
              </button>
              <button className="btn icon small ghost" aria-label="Delete" onClick={async () => { if (await confirm({ title: 'Delete this smart playlist?', danger: true, confirm: 'Delete' })) del(`p/${pid}/smart`, { path: s.path }).then(list.reload, fail); }}><Trash2 /></button>
            </div>
          ))}
          {list.data && !list.data.length && <p className="faint" style={{ fontSize: 13 }}>None yet.</p>}
        </aside>
      </div>
    </>
  );
}
