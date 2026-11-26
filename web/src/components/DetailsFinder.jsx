import { useMemo, useRef, useState } from 'react';
import { Wand2, Upload, FileAudio, Check, CircleAlert, ChevronDown, Sparkles } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { api, post, put, patch, uploadFile } from '../lib/api.js';
import { cx, plural } from '../lib/util.js';
import { Modal, Spinner, Notice } from './ui.jsx';

const GROUPS = [
  ['The song', ['title', 'artist', 'artists', 'album', 'albumartist', 'genre', 'year', 'date', 'track', 'tracktotal', 'disc', 'disctotal']],
  ['People', ['composer', 'lyricist', 'writer', 'producer', 'engineer', 'mixer', 'remixer', 'arranger', 'conductor', 'djmixer', 'work']],
  ['Release', ['label', 'catalognumber', 'barcode', 'isrc', 'originaldate', 'originalyear', 'releasetype', 'releasestatus', 'releasecountry', 'media', 'language', 'script']],
  ['Sound', ['bpm', 'key']],
  ['Sorting & ids', ['artistsort', 'albumartistsort', 'musicbrainz_trackid', 'musicbrainz_releasetrackid', 'musicbrainz_albumid', 'musicbrainz_releasegroupid', 'musicbrainz_artistid', 'musicbrainz_albumartistid', 'musicbrainz_workid']],
];
const LABELS = {
  title: 'Title', artist: 'Artist', artists: 'Every artist', album: 'Album', albumartist: 'Album artist', genre: 'Genre', year: 'Year', date: 'Release date', track: 'Track', tracktotal: 'Tracks on the album', disc: 'Disc', disctotal: 'Discs',
  composer: 'Composer', lyricist: 'Lyricist', writer: 'Writer', producer: 'Producer', engineer: 'Engineer', mixer: 'Mixer', remixer: 'Remixer', arranger: 'Arranger', conductor: 'Conductor', djmixer: 'DJ mixer', work: 'Work',
  label: 'Label', catalognumber: 'Catalog number', barcode: 'Barcode', isrc: 'ISRC', originaldate: 'First released', originalyear: 'First year', releasetype: 'Release type', releasestatus: 'Release status', releasecountry: 'Country', media: 'Media', language: 'Language', script: 'Script',
  bpm: 'BPM', key: 'Key', artistsort: 'Artist (for sorting)', albumartistsort: 'Album artist (for sorting)',
  musicbrainz_trackid: 'MusicBrainz recording', musicbrainz_releasetrackid: 'MusicBrainz track', musicbrainz_albumid: 'MusicBrainz release', musicbrainz_releasegroupid: 'MusicBrainz release group', musicbrainz_artistid: 'MusicBrainz artist', musicbrainz_albumartistid: 'MusicBrainz album artist', musicbrainz_workid: 'MusicBrainz work',
};
const show = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
const same = (a, b) => show(a).toLowerCase().trim() === show(b).toLowerCase().trim();
const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const STATUS = { new: 'new', changed: 'changes', adds: 'adds', same: 'same' };
// Lists (labels, ISRCs, people, genres …) are added to, never cut down.
const LISTS = new Set(['genre', 'artists', 'composer', 'lyricist', 'writer', 'producer', 'engineer', 'mixer', 'remixer', 'arranger', 'conductor', 'djmixer', 'label', 'isrc', 'releasetype', 'musicbrainz_artistid', 'musicbrainz_albumartistid']);
const asList = (v) => (Array.isArray(v) ? v : empty(v) ? [] : String(v).split(/\s*;\s*/));
function withCurrent(k, found, now) {
  if (!LISTS.has(k) || empty(now)) return found;
  const out = [...asList(now)];
  for (const v of asList(found)) if (!out.some((x) => same(x, v))) out.push(v);
  return out;
}

/**
 * Fill in a song's details from links and/or a file, plus whatever we can
 * find by ourselves (MusicBrainz, Deezer, Apple Music, BPM and key from the
 * sound, lyrics). Nothing is saved until you press Use.
 */
export function DetailsFinder({ track, pid, onClose, onSaved }) {
  const { fail, toast } = useApp();
  const [links, setLinks] = useState('');
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(null);
  const [res, setRes] = useState(null);
  const [pick, setPick] = useState({}); // field -> chosen value
  const [on, setOn] = useState({}); // field -> use it
  const [cover, setCover] = useState(null);
  const [useLyrics, setUseLyrics] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);
  const [more, setMore] = useState(false);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const input = useRef(null);

  const look = async () => {
    try {
      let uploadId;
      if (file) {
        setBusy('Reading your file…');
        uploadId = await uploadFile(file);
      }
      setBusy('Looking everywhere… (MusicBrainz, Deezer, Apple Music, the sound itself)');
      const r = await post('details-from', { urls: links.split(/\s+/).filter(Boolean), uploadId, track: { pid, id: track.id } });
      setRes(r);
      const fields = Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, withCurrent(k, v, r.current?.[k])]));
      setPick(fields);
      // Ticked: what's new or different. Untouched: what already matches.
      setOn(Object.fromEntries(Object.keys(fields).map((k) => [k, !same(fields[k], r.current?.[k])])));
      setCover(track.cover ? null : r.covers?.[0]?.url || null);
      setUseLyrics(false);
    } catch (e) {
      fail(e);
    }
    setBusy(null);
  };

  const conflicts = useMemo(() => Object.fromEntries((res?.conflicts || []).map((c) => [c.field, c.options])), [res]);
  // How each found value compares with what the song has now.
  const status = (k) => (empty(res?.current?.[k]) ? 'new' : same(res.current[k], pick[k]) ? 'same' : LISTS.has(k) ? 'adds' : 'changed');
  const counts = { new: 0, changed: 0, adds: 0, same: 0 };
  for (const k of Object.keys(res?.fields || {})) counts[status(k)]++;
  const count = Object.values(on).filter(Boolean).length + (cover ? 1 : 0) + (useLyrics ? 1 : 0);

  const apply = async () => {
    setBusy('Saving…');
    try {
      const tags = Object.fromEntries(Object.entries(pick).filter(([k]) => on[k]).map(([k, v]) => [k, v]));
      const custom = res.custom && Object.keys(res.custom).length && on.__performers !== false ? res.custom : undefined;
      if (Object.keys(tags).length || custom) await patch(`p/${pid}/tracks/${track.id}`, { tags, custom });
      if (cover) {
        if (cover.startsWith('data:')) {
          const blob = await (await fetch(cover)).blob();
          await api(`p/${pid}/tracks/${track.id}/cover`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type } });
        } else await api(`p/${pid}/tracks/${track.id}/cover`, { method: 'PUT', query: { url: cover } });
      }
      if (useLyrics && res.lyrics) await put(`p/${pid}/tracks/${track.id}/lyrics`, { text: res.lyrics.text });
      toast(`Filled in ${plural(count, 'detail')}`, { kind: 'ok' });
      onSaved?.();
      onClose();
    } catch (e) {
      fail(e);
    }
    setBusy(null);
  };

  return (
    <Modal
      size="wide"
      icon={<Sparkles />}
      title={`Fill in “${track.title || track.filename}”`}
      onClose={busy ? undefined : onClose}
      footer={
        res ? (
          <>
            <button className="btn ghost" onClick={() => setRes(null)} disabled={Boolean(busy)}>Back</button>
            <span className="grow" />
            <button className="btn primary" onClick={apply} disabled={!count || Boolean(busy)}>{busy ? <Spinner size={14} /> : <Check />} Use {count ? plural(count, 'detail') : 'them'}</button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
            <button className="btn primary" onClick={look} disabled={Boolean(busy)}>{busy ? <Spinner size={14} /> : <Wand2 />} {links.trim() || file ? 'Look these up' : 'Find everything'}</button>
          </>
        )
      }
    >
      {!res && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Paste links to the song if you have them (Spotify, YouTube, Deezer, Apple Music, MusicBrainz, Bandcamp, SoundCloud …), or drop a file that has good tags. Or leave it empty: it searches by itself. Nothing is saved until you choose.
          </p>
          <textarea className="textarea mono" rows={3} value={links} onChange={(e) => setLinks(e.target.value)} placeholder={'https://open.spotify.com/track/…\nhttps://www.youtube.com/watch?v=…'} spellCheck={false} />
          <div
            className={cx('drop-zone', drag && 'over', file && 'has')}
            style={{ minHeight: 64 }}
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
            role="button"
            tabIndex={0}
          >
            {file ? <FileAudio /> : <Upload />}
            <span>{file ? <><b>{file.name}</b> (only its details are used)</> : <>Take the details from a file: drop it here or <u>pick one</u></>}</span>
            <input ref={input} type="file" accept="audio/*,video/*" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </div>
          {busy && <Notice>{busy}</Notice>}
        </>
      )}
      {res && (
        <>
          <div className="chips">
            {res.sources.map((s) => <span key={s.label} className="chip" title={s.url || ''}><Check /> {s.label}{s.auto ? ' · found' : ''}</span>)}
          </div>
          {res.errors?.map((e) => <div key={e.url} className="faint row" style={{ fontSize: 12.5, gap: 6 }}><CircleAlert size={14} /> {e.url}: {e.message}</div>)}
          {!Object.keys(res.fields).length && <Notice kind="warn">Nothing was found. Try a link to the song, or check its title and artist.</Notice>}
          {Object.keys(res.fields).length > 0 && (
            <div className="compare-summary">
              <span><b className="st st-new">{counts.new}</b> new</span>
              <span><b className="st st-changed">{counts.changed}</b> different from now</span>
              {counts.adds > 0 && <span><b className="st st-adds">{counts.adds}</b> add to a list</span>}
              <span><b className="st st-same">{counts.same}</b> already the same</span>
              <span className="grow" />
              <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} /> Only show what changes</label>
            </div>
          )}
          {res.covers?.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <b style={{ fontSize: 13 }}>Cover{track.cover ? '' : ' (it has none yet)'}</b>
              <div className="row wrap" style={{ gap: 8 }}>
                {track.cover && (
                  <button className={cx('cover-pick', 'now', !cover && 'on')} onClick={() => setCover(null)} title="Keep the cover it has">
                    <img src={`/api/p/${pid}/tracks/${track.id}/cover?size=200`} alt="" />
                    <small>Now (keep)</small>
                  </button>
                )}
                {res.covers.map((c) => (
                  <button key={c.url} className={cx('cover-pick', cover === c.url && 'on')} onClick={() => setCover(cover === c.url ? null : c.url)} title={c.from}>
                    <img src={c.url.startsWith('data:') ? c.url : `/api/fetch-image?url=${encodeURIComponent(c.url)}`} alt="" onError={(e) => (e.currentTarget.parentElement.style.display = 'none')} />
                    <small>{c.from}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {GROUPS.map(([name, keys], gi) => {
            const here = keys.filter((k) => k in res.fields && (!onlyChanges || status(k) !== 'same'));
            if (!here.length || (gi === 4 && !more)) return gi === 4 && here.length ? <button key={name} className="btn small ghost" onClick={() => setMore(true)}><ChevronDown /> {name} ({here.length})</button> : null;
            return (
              <div key={name} className="detail-group">
                <div className="detail-group-head"><span /><span>{name}</span><span>Now</span><span>New</span><span /></div>
                {here.map((k) => (
                  <label key={k} className={cx('detail-row', !on[k] && 'off')}>
                    <input type="checkbox" checked={Boolean(on[k])} onChange={(e) => setOn({ ...on, [k]: e.target.checked })} />
                    <span className="detail-name">{LABELS[k] || k}</span>
                    <span className={cx('detail-now', empty(res.current?.[k]) && 'none', k.startsWith('musicbrainz') && 'mono')}>{empty(res.current?.[k]) ? 'empty' : show(res.current[k])}</span>
                    <span className="detail-value">
                      {conflicts[k] ? (
                        <span className="row wrap" style={{ gap: 4 }}>
                          {conflicts[k].map((o) => (
                            <button key={show(o.value)} type="button" className={cx('chip', same(pick[k], o.value) && 'active')} onClick={(e) => { e.preventDefault(); setPick({ ...pick, [k]: o.value }); setOn({ ...on, [k]: true }); }} title={o.from.join(', ')}>{show(o.value)}</button>
                          ))}
                        </span>
                      ) : (
                        <span className={k.startsWith('musicbrainz') ? 'mono' : ''}>{show(pick[k])}</span>
                      )}
                    </span>
                    <span className="detail-status"><span className={`st st-${status(k)}`}>{STATUS[status(k)]}</span><small className="faint">{(res.from?.[k] || []).join(', ')}</small></span>
                  </label>
                ))}
              </div>
            );
          })}
          {onlyChanges && Object.keys(res.fields).length > 0 && counts.new + counts.changed + counts.adds === 0 && <Notice>Everything found is already the same as now. Untick “Only show what changes” to see it all.</Notice>}
          {res.custom?.PERFORMER && <div className="faint" style={{ fontSize: 12.5 }}>Performers: {res.custom.PERFORMER} (saved too)</div>}
          {res.lyrics && (
            <div className="panel col" style={{ gap: 8 }}>
              <div className="row">
                <label className="row grow" style={{ gap: 8 }}><input type="checkbox" checked={useLyrics} onChange={(e) => setUseLyrics(e.target.checked)} /> <b>Lyrics</b> <span className="faint" style={{ fontSize: 12.5 }}>{res.lyrics.synced ? 'synced' : 'plain'} · {res.lyrics.provider} · {res.lyrics.score}% match · now: {track.haslyrics ? 'it has lyrics, these would replace them' : 'none'}</span></label>
                <button className="btn small ghost" onClick={() => setShowLyrics(!showLyrics)}>{showLyrics ? 'Hide' : 'Read them first'}</button>
              </div>
              {showLyrics && <pre className="lyrics-preview">{res.lyrics.text}</pre>}
            </div>
          )}
          {busy && <Notice>{busy}</Notice>}
        </>
      )}
    </Modal>
  );
}
