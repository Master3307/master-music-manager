import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Inbox as InboxIcon, Check, Trash2, Play, Pause, Image, Fingerprint, CircleAlert, Film, Wand2, Copy } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post, patch, del, api } from '../lib/api.js';
import { fmtTime, fmtSize, cx, plural, ago } from '../lib/util.js';
import { Empty, Notice, Spinner, Modal, Field, Segmented, Toggle, useConfirm } from '../components/ui.jsx';
import { ImageEditor } from '../components/ImageEditor.jsx';

const COLS = [['artist', 'Artist', 180], ['title', 'Title', 220], ['album', 'Album', 180], ['track', '#', 54], ['year', 'Year', 70], ['genre', 'Genre', 130]];

export function InboxPanel({ embedded }) {
  const { profiles, pid, settings, saveSetting, fail, toast, afterJob, jobs } = useApp();
  const confirm = useConfirm();
  const finished = Object.values(jobs).filter((j) => j.status === 'done' && ['ingest', 'download', 'import'].includes(j.kind)).length;
  const { data, loading, reload, setData } = useLoad(() => get('inbox'), [finished]);
  const [sel, setSel] = useState(new Set());
  const [target, setTarget] = useState(pid);
  const [playing, setPlaying] = useState(null);
  const [cover, setCover] = useState(null);
  const [rec, setRec] = useState(null);
  const [find, setFind] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [askMisc, setAskMisc] = useState(null);
  const [v, setV] = useState(0);
  const items = (data || []).filter((i) => i.status !== 'imported');
  const libs = profiles.filter((p) => p.localPath);
  const audioRef = useMemo(() => new Audio(), []);

  const saveField = async (it, key, value) => {
    const val = key === 'genre' ? value.split(/\s*;\s*/).filter(Boolean) : ['track', 'year'].includes(key) ? (value ? Number(value) : null) : value;
    setData((d) => d.map((x) => (x.id === it.id ? { ...x, meta: { ...x.meta, tags: { ...x.meta.tags, [key]: val } } } : x)));
    await patch(`inbox/${it.id}`, { tags: { [key]: val } }).catch(fail);
  };
  const play = (it) => {
    if (playing === it.id) {
      audioRef.pause();
      setPlaying(null);
      return;
    }
    audioRef.src = `/api/inbox/${it.id}/file`;
    audioRef.play();
    audioRef.onended = () => setPlaying(null);
    setPlaying(it.id);
  };
  const doImport = async (ids, misc) => {
    const list = items.filter((i) => ids.includes(i.id));
    const unknown = list.filter((i) => !i.meta.tags.title && !i.meta.tags.artist).length;
    if (unknown && misc === undefined && settings?.library?.misc?.enabled == null) return setAskMisc({ ids, unknown });
    try {
      const r = await post('inbox/import', { ids, profileId: target, misc });
      toast(`Importing ${plural(ids.length, 'song')}…`);
      setSel(new Set());
      afterJob(r.job).then((j) => {
        toast(j.status === 'done' ? `Imported ${j.result.imported.length} of ${ids.length}` : j.error, { kind: j.status === 'done' ? 'ok' : 'error' });
        reload();
      });
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (ids) => {
    if (!(await confirm({ title: `Throw away ${plural(ids.length, 'item')}?`, body: 'They are deleted from the inbox (your library is not touched).', danger: true, confirm: 'Throw away' }))) return;
    await post('inbox/clear', { ids }).catch(fail);
    setSel(new Set());
    reload();
  };
  const all = sel.size === items.length && items.length > 0;

  return (
    <>
      <div className="page-head" style={embedded ? { marginTop: 0 } : undefined}>
        <div className="grow">
          {embedded ? <h2 style={{ margin: 0, fontSize: 19 }}>2 · Check and import</h2> : <h1 className="page-title">Check and import</h1>}
          <p className="page-sub">{items.length ? `${plural(items.length, 'song')} waiting. Check the names and covers (click a field to change it), then import. Nothing is in your library until you do.` : 'Songs you add wait here so you can check them first.'}</p>
        </div>
        {items.length > 0 && (
          <>
            <select className="select" style={{ width: 220 }} value={target || ''} onChange={(e) => setTarget(e.target.value)} aria-label="Import into">
              {libs.map((p) => <option key={p.id} value={p.id}>Into {p.name}</option>)}
            </select>
            <button className="btn primary" onClick={() => doImport(sel.size ? [...sel] : items.map((i) => i.id))} disabled={!libs.length}><Check /> Import {sel.size ? plural(sel.size, 'song') : 'all'}</button>
          </>
        )}
      </div>
      {loading && !data && <Spinner />}
      {data && !items.length && (embedded ? <p className="faint">Nothing waiting right now.</p> : <Empty icon={InboxIcon} title="Nothing waiting" action={<Link className="btn primary" to="/add">Add music</Link>}>Downloads and uploads show up here.</Empty>)}
      {items.length > 0 && (
        <>
          <div className="row" style={{ marginBottom: 8, fontSize: 13 }}>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={all} onChange={() => setSel(all ? new Set() : new Set(items.map((i) => i.id)))} /> Select all</label>
            {sel.size > 0 && (
              <>
                <button className="btn small" onClick={() => setBulk({})}><Wand2 /> Set for {sel.size}</button>
                <button className="btn small ghost danger" onClick={() => remove([...sel])}><Trash2 /> Throw away</button>
              </>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 980 }}>
              <div className="thead" style={{ gridTemplateColumns: `32px 56px ${COLS.map((c) => `${c[2]}px`).join(' ')} minmax(160px, 1fr) 120px`, position: 'static' }}>
                <div /><div />{COLS.map((c) => <div key={c[0]}>{c[1]}</div>)}<div>Will be</div><div />
              </div>
              {items.map((it) => {
                const t = it.meta.tags;
                const plan = it.info.plan || {};
                return (
                  <div key={it.id} className={cx('trow', sel.has(it.id) && 'sel')} style={{ position: 'relative', gridTemplateColumns: `32px 56px ${COLS.map((c) => `${c[2]}px`).join(' ')} minmax(160px, 1fr) 120px`, height: 'auto', minHeight: 60, padding: '4px 0' }}>
                    <div><input type="checkbox" checked={sel.has(it.id)} onChange={() => { const n = new Set(sel); n.has(it.id) ? n.delete(it.id) : n.add(it.id); setSel(n); }} aria-label="Select" /></div>
                    <div style={{ position: 'relative', cursor: 'pointer' }} onClick={() => setCover(it)} title="Change the cover">
                      <img src={`/api/inbox/${it.id}/cover?v=${v}`} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: 'cover', background: 'var(--surface-2)' }} onError={(e) => (e.currentTarget.style.opacity = 0.15)} />
                      {it.info.video && <Film size={13} style={{ position: 'absolute', right: 2, bottom: 2, color: '#fff', filter: 'drop-shadow(0 0 2px #000)' }} />}
                    </div>
                    {COLS.map(([k]) => (
                      <div key={k} style={{ padding: '0 4px' }}>
                        <input className="input" style={{ height: 32 }} defaultValue={Array.isArray(t[k]) ? t[k].join('; ') : t[k] ?? ''} onBlur={(e) => e.target.value !== String(Array.isArray(t[k]) ? t[k].join('; ') : t[k] ?? '') && saveField(it, k, e.target.value)} aria-label={k} placeholder={k === 'album' ? t.title : ''} />
                      </div>
                    ))}
                    <div style={{ whiteSpace: 'normal', lineHeight: 1.35 }}>
                      <span className={cx('badge', plan.action === 'keep' ? '' : 'accent')}>{plan.action === 'keep' ? 'kept as is' : plan.format?.toUpperCase() || '?'}</span>{' '}
                      {it.info.video && <span className="badge accent">animated cover</span>}{' '}
                      {it.duplicateOf && <span className="badge warn" title="A song with the same name and length is already in the library"><Copy size={11} /> maybe a duplicate</span>}{' '}
                      {it.status === 'failed' && <span className="badge danger" title={it.info.error}><CircleAlert size={11} /> failed</span>}
                      <div className="faint ellipsis" style={{ fontSize: 11.5 }} title={it.name}>{it.source} · {it.name} · {fmtTime(it.info.duration)} · {fmtSize(it.size)}</div>
                      {it.info.suggestion && it.info.suggestion.score >= 55 && (
                        <button className="chip" style={{ marginTop: 4, height: 24 }} title="Found online. Click to use these details and the cover." onClick={async () => { await patch(`inbox/${it.id}`, { tags: it.info.suggestion.tags }).catch(fail); if (it.info.suggestion.cover) await api(`inbox/${it.id}/cover`, { method: 'PUT', query: { url: it.info.suggestion.cover } }).catch(() => {}); setV((x) => x + 1); reload(); }}>
                          <Wand2 /> {it.info.suggestion.score}%: {it.info.suggestion.artist} – {it.info.suggestion.title}{it.info.suggestion.album ? ` (${it.info.suggestion.album})` : ''}
                        </button>
                      )}
                    </div>
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      <button className="btn icon small ghost" onClick={() => play(it)} aria-label="Listen">{playing === it.id ? <Pause /> : <Play />}</button>
                      <button className="btn icon small ghost" onClick={() => setFind(it)} aria-label="Find details" title="Find the right details online"><Wand2 /></button>
                      <button className="btn icon small ghost" onClick={() => setRec(it)} aria-label="Recognize" title="Recognize from the sound"><Fingerprint /></button>
                      <button className="btn icon small ghost" onClick={() => doImport([it.id])} aria-label="Import" title="Import"><Check /></button>
                      <button className="btn icon small ghost" onClick={() => remove([it.id])} aria-label="Throw away"><Trash2 /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {cover && (
        <ImageEditor
          title={`Cover for ${cover.meta.tags.title || cover.name}`}
          allowAnimated={false}
          initialUrl={`/api/inbox/${cover.id}/cover`}
          onClose={() => setCover(null)}
          onSave={async (blob) => {
            await api(`inbox/${cover.id}/cover`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type } });
            setCover(null);
            setV((x) => x + 1);
          }}
        />
      )}
      {find && <FindDetails item={find} onClose={() => setFind(null)} onApply={async (c) => { await patch(`inbox/${find.id}`, { tags: c.tags }); if (c.cover) await api(`inbox/${find.id}/cover`, { method: 'PUT', query: { url: c.cover } }).catch(() => {}); setFind(null); setV((x) => x + 1); reload(); }} />}
      {rec && <RecognizeInbox item={rec} onClose={() => setRec(null)} onApply={async (tags) => { await patch(`inbox/${rec.id}`, { tags }); setRec(null); reload(); }} />}
      {bulk && (
        <Modal title={`Set for ${plural(sel.size, 'song')}`} onClose={() => setBulk(null)} footer={<><button className="btn ghost" onClick={() => setBulk(null)}>Cancel</button><button className="btn primary" onClick={async () => { const tags = Object.fromEntries(Object.entries(bulk).filter(([, x]) => x !== '')); if (tags.genre) tags.genre = tags.genre.split(/\s*;\s*/); await post('inbox/bulk', { ids: [...sel], tags }).catch(fail); setBulk(null); reload(); }}>Apply</button></>}>
          <p className="muted" style={{ margin: 0 }}>Empty fields stay as they are.</p>
          <div className="fields two">{['artist', 'album', 'albumartist', 'year', 'genre'].map((k) => <Field key={k} label={k}><input className="input" value={bulk[k] || ''} onChange={(e) => setBulk({ ...bulk, [k]: e.target.value })} /></Field>)}</div>
        </Modal>
      )}
      {askMisc && (
        <Modal title="Some songs have no artist or title" onClose={() => setAskMisc(null)}>
          <p className="muted" style={{ margin: 0 }}>{plural(askMisc.unknown, 'song')} couldn’t be named. Where should they go?</p>
          <div className="col">
            <button className="choice" onClick={async () => { await saveSetting('library', { misc: { ...settings.library.misc, enabled: true } }); setAskMisc(null); doImport(askMisc.ids, true); }}><InboxIcon /><span><b>Into a “!Misc” folder</b><small>Easy to find and sort out later.</small></span></button>
            <button className="choice" onClick={async () => { await saveSetting('library', { misc: { ...settings.library.misc, enabled: false } }); setAskMisc(null); doImport(askMisc.ids, false); }}><Check /><span><b>Named after the file</b><small>Filed like every other song, using the file name as the title.</small></span></button>
          </div>
          <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Your answer is remembered (Settings → Library).</p>
        </Modal>
      )}
    </>
  );
}

/** Search the details online by name, with a match score for each result. */
export function FindDetails({ item, track, onClose, onApply }) {
  const { fail } = useApp();
  const t = item ? item.meta.tags : track;
  const [q, setQ] = useState({ artist: t.artist || '', title: t.title || '', album: t.album || '' });
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const duration = item ? item.info.duration : track.duration;
  const run = async () => {
    setBusy(true);
    try {
      setRes(await get('lookup', { ...q, duration }));
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  return (
    <Modal title="Find the right details" size="wide" onClose={onClose}>
      <div className="row wrap">
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Artist" value={q.artist} onChange={(e) => setQ({ ...q, artist: e.target.value })} />
        <input className="input" style={{ flex: 1.4, minWidth: 180 }} placeholder="Title" value={q.title} onChange={(e) => setQ({ ...q, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Album (optional)" value={q.album} onChange={(e) => setQ({ ...q, album: e.target.value })} />
        <button className="btn primary" onClick={run} disabled={busy || !q.title}>{busy ? <Spinner size={14} /> : <Wand2 />} Search</button>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Searches MusicBrainz. The percentage says how well title, artist and length ({fmtTime(duration)}) fit. Check with the links if unsure.</p>
      {res && !res.length && <Empty>Nothing found. Try fewer words, or only the title.</Empty>}
      {res?.map((c) => (
        <div key={c.recordingId} className="panel row" style={{ padding: 10, gap: 12 }}>
          {c.cover ? <img src={`/api/fetch-image?url=${encodeURIComponent(c.cover)}`} alt="" width={56} height={56} style={{ borderRadius: 6, objectFit: 'cover', background: 'var(--surface-2)' }} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /> : <span style={{ width: 56 }} />}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis"><span className={cx('badge', c.score >= 80 ? 'ok' : c.score >= 55 ? 'warn' : 'danger')}>{c.score}%</span> <b>{c.artist} – {c.title}</b></div>
            <div className="faint ellipsis" style={{ fontSize: 12.5 }}>{[c.album, c.year, c.releaseType, c.track && `track ${c.track}${c.tracktotal ? ` of ${c.tracktotal}` : ''}`, c.duration && fmtTime(c.duration), c.country].filter(Boolean).join(' · ')}</div>
          </div>
          <a className="btn small ghost" href={c.links.spotify} target="_blank" rel="noopener noreferrer">Spotify</a>
          <a className="btn small ghost" href={c.links.ytmusic} target="_blank" rel="noopener noreferrer">YT Music</a>
          <button className="btn small primary" onClick={() => onApply(c).catch(fail)}><Check /> Use</button>
        </div>
      ))}
    </Modal>
  );
}

function RecognizeInbox({ item, onClose, onApply }) {
  const { fail } = useApp();
  const { data, loading, error } = useLoad(() => post(`inbox/${item.id}/recognize`, {}), [item.id]);
  return (
    <Modal title="What is this song?" size="wide" onClose={onClose}>
      {loading && <div className="row"><Spinner /> Listening…</div>}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {data?.errors?.map((e) => <Notice key={e.provider} kind="warn">{e.provider}: {e.error}</Notice>)}
      {data && !data.candidates.length && <Empty icon={Fingerprint}>No match.</Empty>}
      {data?.candidates?.map((c, i) => (
        <div key={i} className="panel row" style={{ padding: 12 }}>
          <span className={cx('badge', c.score >= 85 ? 'ok' : c.score >= 60 ? 'warn' : 'danger')}>{c.score}%</span>
          <div className="grow"><b>{c.artist} – {c.title}</b><div className="faint" style={{ fontSize: 12.5 }}>{[c.album, c.year, c.provider].filter(Boolean).join(' · ')}</div></div>
          {c.links?.spotify && <a className="btn small ghost" href={c.links.spotify} target="_blank" rel="noopener noreferrer">Spotify</a>}
          {c.links?.ytmusic && <a className="btn small ghost" href={c.links.ytmusic} target="_blank" rel="noopener noreferrer">YT Music</a>}
          <button className="btn small primary" onClick={() => onApply(c.tags).catch(fail)}>Use</button>
        </div>
      ))}
    </Modal>
  );
}

export { Segmented, Toggle, ago, del };

export default function Inbox() {
  return <InboxPanel />;
}
