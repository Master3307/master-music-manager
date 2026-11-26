import { useEffect, useMemo, useState } from 'react';
import { Tags, Captions, Image, AudioWaveform, Fingerprint, FileAudio, Plus, Trash2, Check, RotateCcw, Copy, Download, Save, ExternalLink, Info, Link2Off } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, patch, del, api } from '../lib/api.js';
import { fmtTime, fmtSize, date, ago, cx, plural } from '../lib/util.js';
import { Modal, Tabs, Field, Notice, Spinner, Toggle, Empty, useConfirm } from './ui.jsx';
import { ImageEditor } from './ImageEditor.jsx';
import { LyricsEditor } from './LyricsEditor.jsx';
import { AudioEditor } from './AudioEditor.jsx';
import { FindDetails } from '../pages/Inbox.jsx';
import { Wand2 } from 'lucide-react';

const GROUPS = ['Main', 'People', 'Text', 'Sound', 'Release', 'Sorting', 'IDs'];
const asText = (v) => (v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v));

/** Edit one song (all tabs) or many (details, custom tags, cover). */
export function TrackEditor({ ids, onClose, onSaved }) {
  const { pid, fields, settings, fail, toast, afterJob } = useApp();
  const multi = ids.length > 1;
  const [tab, setTab] = useState('details');
  const [rows, setRows] = useState(null);
  const [detail, setDetail] = useState(null);
  const [edit, setEdit] = useState({});
  const [custom, setCustom] = useState({});
  const [newTag, setNewTag] = useState({ name: '', value: '' });
  const [noSplit, setNoSplit] = useState(undefined);
  const [organize, setOrganize] = useState(settings?.library?.autoOrganize !== false);
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState('Main');
  const [coverOpen, setCoverOpen] = useState(false);
  const [coverV, setCoverV] = useState(0);
  const [finding, setFinding] = useState(false);
  const confirm = useConfirm();

  const loadAll = async () => {
    const r = await get(`p/${pid}/tracks`, { ids: ids.join(',') });
    setRows(r.tracks);
    if (!multi) setDetail(await get(`p/${pid}/tracks/${ids[0]}`));
  };
  useEffect(() => {
    loadAll().catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(','), pid]);

  // What every field shows: the common value, or "mixed".
  const common = useMemo(() => {
    if (!rows) return {};
    const out = {};
    for (const f of fields?.tags || []) {
      const vals = new Set(rows.map((r) => asText(multi ? r[f.key] : detail?.tags?.[f.key] ?? r[f.key])));
      out[f.key] = vals.size === 1 ? { value: [...vals][0] } : { mixed: vals.size };
    }
    return out;
  }, [rows, detail, fields, multi]);
  const commonCustom = useMemo(() => {
    if (!rows) return {};
    const names = new Set(rows.flatMap((r) => Object.keys((multi ? r.custom : detail?.custom) || {})));
    const out = {};
    for (const n of names) {
      const vals = new Set(rows.map((r) => ((multi ? r.custom : detail?.custom) || {})[n] ?? ''));
      out[n] = vals.size === 1 ? { value: [...vals][0] } : { mixed: vals.size };
    }
    return out;
  }, [rows, detail, multi]);

  const dirty = Object.keys(edit).length || Object.keys(custom).length || noSplit !== undefined;

  const save = async () => {
    setBusy(true);
    try {
      if (!multi) {
        const tags = {};
        for (const [k, v] of Object.entries(edit)) {
          const f = fields.tags.find((x) => x.key === k);
          tags[k] = f?.list ? (v === '' ? [] : v.split(/\s*;\s*/).filter(Boolean)) : v;
        }
        const r = await patch(`p/${pid}/tracks/${ids[0]}`, { tags, custom: Object.keys(custom).length ? custom : undefined, noSplit, organize });
        toast(r.moved ? `Saved and moved to ${r.moved.to}` : 'Saved');
      } else {
        const ops = [
          ...Object.entries(edit).map(([field, value]) => ({ type: 'set', field, value })),
          ...Object.entries(custom).map(([name, value]) => ({ type: 'custom', name, value })),
          ...(noSplit !== undefined ? [{ type: 'nosplit', value: noSplit }] : []),
          ...(organize ? [{ type: 'organize' }] : []),
        ];
        const r = await post(`p/${pid}/bulk`, { ids, op: ops[0], ops: ops.slice(1), apply: true, restorePoints: ids.length <= 500 });
        if (r.job) {
          toast(`Saving ${plural(ids.length, 'song')}…`);
          await afterJob(r.job);
          toast(`Saved ${plural(ids.length, 'song')}`);
        }
      }
      setEdit({});
      setCustom({});
      setNoSplit(undefined);
      onSaved?.();
      await loadAll();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Discard your changes?', confirm: 'Discard', danger: true }))) return;
    onClose();
  };

  const t = rows?.[0];
  const tabs = [
    { id: 'details', label: 'Details', icon: Tags },
    { id: 'custom', label: 'More tags', icon: Plus },
    !multi && { id: 'lyrics', label: 'Lyrics', icon: Captions },
    { id: 'cover', label: 'Cover', icon: Image },
    !multi && { id: 'sound', label: 'Sound', icon: AudioWaveform },
    !multi && { id: 'recognize', label: 'Recognize', icon: Fingerprint },
    !multi && { id: 'file', label: 'File', icon: FileAudio },
  ].filter(Boolean);

  return (
    <Modal
      size="xl"
      title={multi ? `Edit ${plural(ids.length, 'song')}` : t ? t.title || t.filename : 'Edit'}
      onClose={close}
      footer={
        ['details', 'custom'].includes(tab) && (
          <>
            <span className="grow row wrap" style={{ gap: 16 }}>
              <Toggle checked={organize} onChange={setOrganize} label="Rename and move by the folder layout" />
              <Toggle checked={noSplit ?? (multi ? false : t?.nosplit)} onChange={setNoSplit} label="Keep artists together" description="Never split the artist into several" />
            </span>
            <button className="btn ghost" onClick={close}>Close</button>
            <button className="btn primary" onClick={save} disabled={!dirty || busy}>{busy ? <Spinner size={14} /> : <Check />} Save{multi ? ` ${plural(ids.length, 'song')}` : ''}</button>
          </>
        )
      }
    >
      {!rows ? (
        <Spinner />
      ) : (
        <>
          {!multi && t && (
            <div className="row" style={{ gap: 14 }}>
              <img src={`/api/p/${pid}/tracks/${t.id}/cover?v=${coverV}`} alt="" style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover', background: 'var(--surface)' }} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="mono faint ellipsis" style={{ fontSize: 12 }}>{t.path}</div>
                <div className="faint" style={{ fontSize: 12.5 }}>{[t.ext?.toUpperCase(), t.bitrate && `${t.bitrate} kbps`, t.samplerate && `${t.samplerate / 1000} kHz`, fmtTime(t.duration), fmtSize(t.size)].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          )}
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
          {tab === 'details' && !multi && (
            <div className="row" style={{ marginTop: -6 }}>
              <button className="btn small" onClick={() => setFinding(true)}><Wand2 /> Find the right details online</button>
              <span className="faint" style={{ fontSize: 12.5 }}>Fills in what you pick; you see everything before it’s saved.</span>
            </div>
          )}
          {finding && t && (
            <FindDetails
              track={{ ...t, ...Object.fromEntries(Object.entries(edit)) }}
              onClose={() => setFinding(false)}
              onApply={async (c) => {
                setEdit((e) => ({ ...e, ...Object.fromEntries(Object.entries(c.tags).map(([k, v]) => [k, Array.isArray(v) ? v.join('; ') : String(v)])) }));
                if (c.cover && !t.cover) await api(`p/${pid}/tracks/${t.id}/cover`, { method: 'PUT', query: { url: c.cover } }).then(() => setCoverV((x) => x + 1)).catch(() => {});
                setFinding(false);
                toast('Filled in. Check and press Save.');
              }}
            />
          )}
          {tab === 'details' && (
            <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 20, minHeight: 0 }}>
              <div className="settings-nav" style={{ position: 'static' }}>
                {GROUPS.map((g) => (
                  <a key={g} href="#" className={cx(group === g && 'active')} onClick={(e) => { e.preventDefault(); setGroup(g); }}>{g === 'IDs' ? 'Identifiers' : g}</a>
                ))}
              </div>
              <div className="fields" style={{ alignContent: 'start' }}>
                {(fields?.tags || []).filter((f) => f.group === group).map((f) => {
                  const c = common[f.key] || {};
                  const val = edit[f.key] ?? c.value ?? '';
                  const changed = f.key in edit;
                  const props = {
                    value: val,
                    placeholder: c.mixed ? `(${c.mixed} different values; typing replaces all)` : f.hint || '',
                    className: cx(f.type === 'text' ? 'textarea' : 'input', c.mixed && 'mixed'),
                    onChange: (e) => setEdit({ ...edit, [f.key]: e.target.value }),
                    style: changed ? { borderColor: 'var(--accent-line)' } : undefined,
                  };
                  return (
                    <Field key={f.key} label={<>{f.label}{changed && <button className="btn small ghost" style={{ height: 20, marginLeft: 6 }} onClick={(e) => { e.preventDefault(); const n = { ...edit }; delete n[f.key]; setEdit(n); }}>undo</button>}</>} hint={f.list ? 'Several values: separate with ;' : multi ? 'Use {title}, {artist}, {track:2} … to build it from each song' : undefined} style={f.type === 'text' ? { gridColumn: '1 / -1' } : undefined}>
                      {f.type === 'text' ? <textarea rows={f.key === 'lyrics' ? 6 : 3} {...props} /> : f.type === 'bool' ? (
                        <select className="select" value={val} onChange={props.onChange}><option value="">–</option><option value="true">Yes</option><option value="false">No</option></select>
                      ) : <input type={f.type === 'number' && !multi ? 'number' : 'text'} {...props} />}
                    </Field>
                  );
                })}
              </div>
            </div>
          )}
          {tab === 'custom' && (
            <div className="col" style={{ gap: 12 }}>
              <p className="muted" style={{ margin: 0 }}>Tags that don’t have their own field, like language notes, ratings from other apps or anything a tagger added. Written as TXXX frames in MP3, Vorbis comments in FLAC / Ogg and freeform atoms in M4A.</p>
              {Object.entries({ ...commonCustom, ...Object.fromEntries(Object.keys(custom).map((k) => [k, commonCustom[k] || {}])) }).map(([name, c]) => (
                <div key={name} className="row">
                  <input className="input mono" style={{ width: 240 }} value={name} readOnly />
                  <input className={cx('input', c.mixed && 'mixed')} value={custom[name] ?? c.value ?? ''} placeholder={c.mixed ? `(${c.mixed} different values)` : ''} onChange={(e) => setCustom({ ...custom, [name]: e.target.value })} />
                  <button className="btn icon ghost" onClick={() => setCustom({ ...custom, [name]: '' })} aria-label={`Remove ${name}`}><Trash2 /></button>
                </div>
              ))}
              <div className="row">
                <input className="input mono" style={{ width: 240 }} placeholder="NAME (e.g. LANGUAGE_NOTE)" value={newTag.name} onChange={(e) => setNewTag({ ...newTag, name: e.target.value.replace(/[^\w .:/-]/g, '') })} />
                <input className="input" placeholder="Value" value={newTag.value} onChange={(e) => setNewTag({ ...newTag, value: e.target.value })} />
                <button className="btn" disabled={!newTag.name} onClick={() => { setCustom({ ...custom, [newTag.name]: newTag.value }); setNewTag({ name: '', value: '' }); }}><Plus /> Add</button>
              </div>
              {!multi && detail?.comments?.length > 1 && (
                <Notice icon={Info}>This file has {detail.comments.length} comments in different languages: {detail.comments.map((c) => `${c.language || '?'}${c.descriptor ? ` (${c.descriptor})` : ''}`).join(', ')}.</Notice>
              )}
            </div>
          )}
          {tab === 'lyrics' && t && <LyricsEditor track={t} detail={detail} onSaved={() => { loadAll(); onSaved?.(); }} />}
          {tab === 'cover' && (
            <div className="col" style={{ gap: 14 }}>
              <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
                {!multi && t && (
                  <img src={`/api/p/${pid}/tracks/${t.id}/cover?v=${coverV}`} alt="" style={{ width: 260, height: 260, objectFit: 'cover', borderRadius: 12, background: 'var(--surface)' }} onError={(e) => (e.currentTarget.style.opacity = 0.2)} />
                )}
                <div className="col">
                  <button className="btn primary" onClick={() => setCoverOpen(true)}><Image /> {multi ? `New cover for ${plural(ids.length, 'song')}` : 'Change the cover'}</button>
                  {!multi && t?.cover && (
                    <button className="btn danger" onClick={async () => { await del(`p/${pid}/tracks/${t.id}/cover`).catch(fail); setCoverV((v) => v + 1); loadAll(); }}><Trash2 /> Remove the cover</button>
                  )}
                  {!multi && detail?.pictures?.length > 0 && <span className="faint" style={{ fontSize: 12.5 }}>{detail.pictures.length} picture{detail.pictures.length > 1 ? 's' : ''} in the file: {detail.pictures.map((p) => `${p.type || 'picture'} (${p.format}, ${fmtSize(p.size)})`).join(', ')}</span>}
                  {!multi && detail?.canvas && <span className="badge accent">Has an animated cover</span>}
                </div>
              </div>
              <Notice>Covers are stored inside the file, so every player sees them. Animated covers come from music videos (Add → upload a video) and play here and on share pages.</Notice>
            </div>
          )}
          {tab === 'sound' && t && <AudioEditor track={t} onSaved={() => { loadAll(); onSaved?.(); }} />}
          {tab === 'recognize' && t && <Recognize track={t} onApplied={() => { loadAll(); onSaved?.(); }} />}
          {tab === 'file' && t && detail && <FileTab track={t} detail={detail} onChanged={() => { loadAll(); onSaved?.(); }} />}
          {coverOpen && (
            <ImageEditor
              title="Cover"
              allowAnimated={false}
              initialUrl={!multi && t?.cover ? `/api/p/${pid}/tracks/${t.id}/cover` : undefined}
              onClose={() => setCoverOpen(false)}
              onSave={async (blob) => {
                await api(`p/${pid}/tracks/${ids[0]}/cover`, { method: 'PUT', body: blob, query: { ids: ids.join(',') }, headers: { 'Content-Type': blob.type } });
                toast(multi ? `Cover set on ${plural(ids.length, 'song')}` : 'Cover saved');
                setCoverOpen(false);
                setCoverV((v) => v + 1);
                loadAll();
                onSaved?.();
              }}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function Recognize({ track, onApplied }) {
  const { pid, fail, toast } = useApp();
  const p = usePlayer();
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState(null);
  useEffect(() => {
    get('recognize/providers').then(setProviders).catch(() => {});
  }, []);
  const run = async () => {
    setBusy(true);
    setRes(null);
    try {
      setRes(await post(`p/${pid}/tracks/${track.id}/recognize`, {}));
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const apply = async (c) => {
    try {
      await patch(`p/${pid}/tracks/${track.id}`, { tags: c.tags });
      toast('Applied the recognized details');
      onApplied();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <p className="muted" style={{ margin: 0 }}>Listens to the song itself and looks it up, for when the tags don’t match what you hear. Check the result with the links before applying it.</p>
      {providers && (
        <div className="chips">
          {Object.entries(providers).map(([k, v]) => (
            <span key={k} className={cx('badge', v.enabled ? 'ok' : '')} title={v.note}>{v.enabled ? '✓' : '–'} {v.label}</span>
          ))}
          <span className="faint" style={{ fontSize: 12 }}>Turn on more in Settings → Privacy &amp; online.</span>
        </div>
      )}
      <div className="row">
        <button className="btn primary" onClick={run} disabled={busy}>{busy ? <Spinner size={14} /> : <Fingerprint />} {busy ? 'Listening…' : 'Recognize this song'}</button>
        <button className="btn" onClick={() => p.playList([{ id: `l:${track.id}`, localId: track.id, title: track.title, artist: track.artist }], 0, pid)}>Listen</button>
      </div>
      {res?.errors?.map((e) => <Notice key={e.provider} kind="warn">{e.provider}: {e.error}</Notice>)}
      {res && !res.candidates.length && <Empty icon={Fingerprint} title="No match">The song wasn’t found. Short clips and live recordings are hard; try Shazam (unofficial) in the settings.</Empty>}
      {res?.candidates?.map((c, i) => (
        <div key={i} className="panel" style={{ padding: 14 }}>
          <div className="row">
            <span className={cx('badge', c.score >= 85 ? 'ok' : c.score >= 60 ? 'warn' : 'danger')} title={c.scoreNote}>{c.score}% match</span>
            <span className="badge">{c.provider === 'shazam' ? 'Shazam (unofficial)' : c.provider === 'audd' ? 'AudD' : 'AcoustID'}</span>
            <b className="grow ellipsis">{c.artist} – {c.title}</b>
            <button className="btn small primary" onClick={() => apply(c)}><Check /> Apply</button>
          </div>
          <div className="faint" style={{ fontSize: 13, marginTop: 6 }}>
            {[c.album, c.year, c.albumType, c.country, c.duration && fmtTime(c.duration), c.label, c.isrc].filter(Boolean).join(' · ')}
          </div>
          <div className="mono" style={{ fontSize: 12.5, marginTop: 8 }}>
            {['title', 'artist', 'album', 'year'].map((k) => {
              const cur = track[k] ?? '';
              const nv = c.tags?.[k] ?? '';
              if (!nv || String(cur) === String(nv)) return null;
              return <div key={k}><span className="faint">{k}: </span><span className="change-old">{String(cur) || '∅'}</span> → <span className="change-new">{String(nv)}</span></div>;
            })}
            {c.duration && track.duration && Math.abs(c.duration - track.duration) > 10 && <div style={{ color: 'var(--warn)' }}>length differs: {fmtTime(track.duration)} here vs {fmtTime(c.duration)}</div>}
          </div>
          <div className="links" style={{ marginTop: 10 }}>
            {Object.entries(c.links || {}).filter(([, u]) => u).map(([k, u]) => (
              <a key={k} className="link-chip" href={u} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> {{ spotify: 'Check on Spotify', ytmusic: 'Check on YouTube Music', youtube: 'YouTube', musicbrainz: 'MusicBrainz', shazam: 'Shazam', apple: 'Apple Music', audd: 'song.link' }[k] || k}</a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FileTab({ track, detail, onChanged }) {
  const { pid, fail, toast } = useApp();
  const confirm = useConfirm();
  const [label, setLabel] = useState('');
  const [name, setName] = useState(track.path);
  const [conflict, setConflict] = useState(null);
  useEffect(() => setName(track.path), [track.path]);
  const rename = async (onConflict) => {
    try {
      const r = await post(`p/${pid}/tracks/${track.id}/rename`, { path: name, onConflict: onConflict || 'ask' });
      toast(`Now ${r.path}`);
      setConflict(null);
      onChanged();
    } catch (e) {
      if (e.status === 409 && e.body?.conflict) setConflict(e.body.conflict);
      else fail(e);
    }
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <Field label="File name and folder" hint="Change anything: the name, or the folders (with /). The file moves on Save.">
        <div className="row">
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name !== track.path && rename()} />
          <button className="btn primary" disabled={!name || name === track.path} onClick={() => rename()}><Save /> Save</button>
        </div>
      </Field>
      {conflict && (
        <Notice kind="warn">
          <b>“{conflict.path}” already exists.</b>
          {conflict.track && <> It’s {conflict.track.artist} – {conflict.track.title} ({fmtTime(conflict.track.duration)}, {conflict.track.ext?.toUpperCase()} {conflict.track.bitrate ? `${conflict.track.bitrate}k` : ''}).{conflict.similarity && <> They look <b>{conflict.similarity.score}% alike</b>.</>}</>}
          <div className="row wrap" style={{ marginTop: 10 }}>
            {conflict.track && <button className="btn small primary" onClick={() => rename('merge')}>Merge (keep this one, take missing details from the other)</button>}
            <button className="btn small danger" onClick={() => rename('replace')}>Replace the other file</button>
            <button className="btn small" onClick={() => rename('keepBoth')}>Keep both (adds “(2)”)</button>
            <button className="btn small ghost" onClick={() => setConflict(null)}>Cancel</button>
          </div>
        </Notice>
      )}
      <div className="fields two">
        <Field label="Format">
          <input className="input" readOnly value={[detail.info.codec, detail.info.container, detail.info.lossless ? 'lossless' : 'lossy', detail.info.tagTypes?.join(' + ')].filter(Boolean).join(' · ')} />
        </Field>
      </div>
      <div className="row wrap">
        <a className="btn" href={`/api/p/${pid}/tracks/${track.id}/file?download=1`}><Download /> Download</a>
        <button className="btn" onClick={async () => { try { const t = await post(`p/${pid}/tracks/${track.id}/copy`); toast(`Copied to ${t.path}`); onChanged(); } catch (e) { fail(e); } }}><Copy /> Make a copy</button>
        {track.remoteId ? <span className="badge ok">On the server</span> : <span className="badge"><Link2Off size={11} /> Not matched with the server</span>}
      </div>
      <div>
        <div className="section-head"><h2 style={{ fontSize: 15 }}>Restore points</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>A copy of the file from before each change. Restoring makes a new restore point of the current version first, so nothing is lost.</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <input className="input" style={{ maxWidth: 320 }} placeholder="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn" onClick={async () => { await post(`p/${pid}/tracks/${track.id}/restore-points`, { label }).catch(fail); setLabel(''); onChanged(); toast('Saved a restore point'); }}><Save /> Save one now</button>
        </div>
        {!detail.restorePoints.length && <p className="faint">None yet.</p>}
        {detail.restorePoints.map((r) => (
          <div key={r.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="grow">{r.label} <span className="faint">· {ago(r.created_at)} · {fmtSize(r.size)}</span></span>
            <button className="btn small" onClick={async () => { if (await confirm({ title: 'Restore this version?', body: 'The file goes back to how it was then. The current version is kept as a restore point.', confirm: 'Restore' })) { await post(`p/${pid}/restore-points/${r.id}/restore`).catch(fail); toast('Restored'); onChanged(); } }}><RotateCcw /> Restore</button>
            <button className="btn small ghost" onClick={async () => { await del(`p/${pid}/restore-points/${r.id}`).catch(fail); onChanged(); }} aria-label="Delete"><Trash2 /></button>
          </div>
        ))}
      </div>
      <p className="faint" style={{ fontSize: 12.5 }}>Added {date(track.added)} · changed {date(track.modified)}</p>
    </div>
  );
}
