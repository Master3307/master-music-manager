import { useEffect, useMemo, useState } from 'react';
import { Merge, Check, CircleAlert, Wand2, SkipForward, Play, Pause } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, patch, api } from '../lib/api.js';
import { fmtTime, fmtSize, cx, plural } from '../lib/util.js';
import { Modal, Notice, Spinner, Toggle, Field, Empty } from './ui.jsx';

/** Merge any songs into one; you pick which copy stays (the best one is suggested). */
export function MergeDialog({ tracks, onClose, onDone }) {
  const { pid, fail, toast } = useApp();
  const p = usePlayer();
  const best = useMemo(() => tracks.slice().sort((a, b) => (b.lossless - a.lossless) || (b.bitrate || 0) - (a.bitrate || 0) || (b.cover - a.cover))[0], [tracks]);
  const [keep, setKeep] = useState(best.id);
  const [fill, setFill] = useState(true);
  const [checks, setChecks] = useState(null);
  const others = tracks.filter((t) => t.id !== keep);
  useEffect(() => {
    setChecks(null);
    Promise.all(others.map((o) => post(`p/${pid}/compare`, { ids: [keep, o.id] }).then((r) => ({ id: o.id, ...r })))).then(setChecks).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keep]);
  const low = checks?.filter((c) => c.score < 75) || [];
  const go = async () => {
    try {
      await post(`p/${pid}/merge`, { keep, remove: others.map((o) => o.id), fillTags: fill, confirm: true });
      toast(`Merged into one; ${plural(others.length, 'copy', 'copies')} went to the trash`);
      onDone?.();
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title={`Merge ${tracks.length} songs into one`}
      icon={<Merge />}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <span className="grow"><Toggle checked={fill} onChange={setFill} label="Copy missing details to the one I keep" /></span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className={cx('btn', low.length ? 'danger solid' : 'primary')} onClick={go}>{low.length ? 'Merge anyway' : 'Merge'}</button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>Choose the copy that stays. The others go to the trash (you can put them back).</p>
      {tracks.map((t) => {
        const c = checks?.find((x) => x.id === t.id);
        const now = p.current?.localId === t.id;
        return (
          <label key={t.id} className={cx('choice', keep === t.id && 'active')} style={{ alignItems: 'center' }}>
            <input type="radio" checked={keep === t.id} onChange={() => setKeep(t.id)} />
            <button type="button" className="btn icon small" onClick={(e) => { e.preventDefault(); now ? p.toggle() : p.playList([{ id: `l:${t.id}`, localId: t.id, title: t.title, artist: t.artist }], 0, pid); }} aria-label="Listen">{now && p.playing ? <Pause /> : <Play />}</button>
            <span className="grow" style={{ minWidth: 0 }}>
              <b className="ellipsis" style={{ display: 'block' }}>{t.title || t.filename} <span className="faint" style={{ fontWeight: 400 }}>· {t.artist}</span></b>
              <small className="mono ellipsis" style={{ display: 'block' }}>{t.path}</small>
            </span>
            <span className="badge">{(t.ext || '').toUpperCase()} {t.lossless ? 'lossless' : t.bitrate ? `${t.bitrate}k` : ''}</span>
            <span className="faint tabular">{fmtTime(t.duration)} · {fmtSize(t.size)}</span>
            {t.id === best.id && <span className="badge ok">best</span>}
            {c && t.id !== keep && <span className={cx('badge', c.score >= 75 ? 'ok' : c.score >= 45 ? 'warn' : 'danger')}>{c.score}% alike</span>}
          </label>
        );
      })}
      {low.length > 0 && (
        <Notice kind="warn">
          <b>Some of these may not be the same song:</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {[...new Set(low.flatMap((c) => c.notes.filter((n) => n.ok === false).map((n) => n.text)))].map((t) => <li key={t}>{t}</li>)}
          </ul>
        </Notice>
      )}
    </Modal>
  );
}

/** One song at a time: what's missing, and what was found for it. */
export function FillMissing({ query, onClose, onDone }) {
  const { pid, fail, toast } = useApp();
  const [list, setList] = useState(null);
  const [i, setI] = useState(0);
  const [found, setFound] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  useEffect(() => {
    get(`p/${pid}/tracks`, { q: query || '(missing:artist OR missing:album OR missing:year OR missing:genre OR -has:cover)', limit: 500 }).then((r) => setList(r.tracks)).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const t = list?.[i];
  useEffect(() => {
    if (!t) return;
    setForm({ title: t.title || '', artist: t.artist || '', album: t.album || '', year: t.year || '', genre: (t.genre || []).join('; '), track: t.track || '' });
    setFound(null);
    const title = t.title || (t.filename || '').replace(/\.[^.]+$/, '').replace(/^\d+[\s.-]+/, '');
    get('lookup', { title, artist: t.artist || '', duration: t.duration }).then(setFound).catch(() => setFound([]));
  }, [t]);
  const next = () => setI((x) => x + 1);
  const save = async (extra) => {
    setBusy(true);
    try {
      const tags = { ...form, ...(extra?.tags || {}) };
      tags.genre = String(tags.genre || '').split(/\s*;\s*/).filter(Boolean);
      await patch(`p/${pid}/tracks/${t.id}`, { tags });
      if (extra?.cover && !t.cover) await api(`p/${pid}/tracks/${t.id}/cover`, { method: 'PUT', query: { url: extra.cover } }).catch(() => {});
      setDone((d) => d + 1);
      next();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const missing = t ? ['artist', 'album', 'year', 'genre'].filter((k) => !t[k] || (Array.isArray(t[k]) && !t[k].length)).concat(t.cover ? [] : ['cover']) : [];
  return (
    <Modal title="Fill in missing details" icon={<Wand2 />} size="wide" onClose={() => { if (done) onDone?.(); onClose(); }}>
      {!list && <Spinner />}
      {list && !list.length && <Empty title="Nothing is missing">Every song has an artist, album, year, genre and cover.</Empty>}
      {list && list.length > 0 && !t && <Empty title="All done" action={<button className="btn primary" onClick={() => { onDone?.(); onClose(); }}>Close</button>}>{plural(done, 'song')} updated.</Empty>}
      {t && (
        <>
          <div className="row">
            <span className="faint">{i + 1} of {list.length} · {done} saved</span>
            <span className="grow" />
            {missing.map((m) => <span key={m} className="badge warn">no {m}</span>)}
          </div>
          <div className="mono faint ellipsis" style={{ fontSize: 12 }}>{t.path}</div>
          <div className="fields">
            {['title', 'artist', 'album', 'year', 'track', 'genre'].map((k) => (
              <Field key={k} label={k === 'genre' ? 'Genre (several: separate with ;)' : k[0].toUpperCase() + k.slice(1)}>
                <input className="input" value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} style={!t[k] || (Array.isArray(t[k]) && !t[k].length) ? { borderColor: 'color-mix(in oklab, var(--warn) 50%, transparent)' } : undefined} />
              </Field>
            ))}
          </div>
          <div>
            <b style={{ fontSize: 13 }}>Found online</b>
            {!found && <div className="row" style={{ marginTop: 6 }}><Spinner size={14} /> <span className="faint">Looking…</span></div>}
            {found && !found.length && <p className="faint" style={{ margin: '6px 0' }}>Nothing found. Fill it in yourself, or skip.</p>}
            <div className="col" style={{ gap: 6, marginTop: 6, maxHeight: 240, overflow: 'auto' }}>
              {found?.slice(0, 5).map((c) => (
                <div key={c.recordingId} className="row panel" style={{ padding: '6px 10px' }}>
                  <span className={cx('badge', c.score >= 80 ? 'ok' : c.score >= 55 ? 'warn' : 'danger')}>{c.score}%</span>
                  <span className="grow ellipsis"><b>{c.artist} – {c.title}</b> <span className="faint">{[c.album, c.year].filter(Boolean).join(' · ')}</span></span>
                  <button className="btn small" onClick={() => setForm({ ...form, ...Object.fromEntries(Object.entries(c.tags).filter(([k]) => ['title', 'artist', 'album', 'year', 'track'].includes(k))) })}>Fill in</button>
                  <button className="btn small primary" disabled={busy} onClick={() => save(c)}><Check /> Use and save</button>
                </div>
              ))}
            </div>
          </div>
          <div className="row">
            <button className="btn ghost" onClick={next}><SkipForward /> Skip</button>
            <span className="grow" />
            <button className="btn primary" disabled={busy} onClick={() => save()}><Check /> Save and next</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export { CircleAlert };
