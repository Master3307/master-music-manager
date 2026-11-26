import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Play, ListPlus, ListMusic, Pencil, Terminal, X, Columns3, ArrowUp, ArrowDown, ImageOff, Tags, Sparkles, FileAudio, Clock, Image, Download, Share2, Trash2, RefreshCw, HelpCircle,
  ArrowRightLeft, FolderPlus, Search, CircleAlert,
} from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, api } from '../lib/api.js';
import { fmtTime, fmtSize, date, cx, store, plural, debounce } from '../lib/util.js';
import { Cover, Empty, Menu, MenuItem, MenuSep, Modal, Notice, Spinner, Toggle, useConfirm } from '../components/ui.jsx';
import { SongMenu, AddToPlaylist, ShareDialog } from '../components/Songs.jsx';
import { TrackEditor } from '../components/TrackEditor.jsx';
import { ImageEditor } from '../components/ImageEditor.jsx';
import { TransferDialog, RemoveDialog } from '../components/Transfer.jsx';
import { MergeDialog, FillMissing } from '../components/Fixers.jsx';
import { Merge, Wand2 } from 'lucide-react';

export const COLUMNS = {
  num: { label: '#', w: 52, align: 'right', get: (t, i) => i + 1, fixed: true },
  title: { label: 'Title', w: 320, sort: 'title' },
  artist: { label: 'Artist', w: 200, sort: 'artist' },
  album: { label: 'Album', w: 220, sort: 'album' },
  albumartist: { label: 'Album artist', w: 180, sort: 'albumartist' },
  year: { label: 'Year', w: 70, sort: 'year', align: 'right' },
  track: { label: 'Track', w: 64, sort: 'track', align: 'right' },
  disc: { label: 'Disc', w: 56, sort: 'disc', align: 'right' },
  genre: { label: 'Genre', w: 150, sort: 'genre', get: (t) => (t.genre || []).join(', ') },
  duration: { label: 'Length', w: 76, sort: 'duration', align: 'right', get: (t) => fmtTime(t.duration) },
  bitrate: { label: 'Bitrate', w: 86, sort: 'bitrate', align: 'right', get: (t) => (t.bitrate ? `${t.bitrate} kbps` : '') },
  samplerate: { label: 'Sample rate', w: 96, sort: 'samplerate', align: 'right', get: (t) => (t.samplerate ? `${(t.samplerate / 1000).toFixed(1)} kHz` : '') },
  ext: { label: 'Format', w: 74, sort: 'ext', get: (t) => (t.ext || '').toUpperCase() },
  size: { label: 'Size', w: 84, sort: 'size', align: 'right', get: (t) => fmtSize(t.size) },
  added: { label: 'Added', w: 110, sort: 'added', get: (t) => date(t.added) },
  modified: { label: 'Changed', w: 110, sort: 'modified', get: (t) => date(t.modified) },
  bpm: { label: 'BPM', w: 64, sort: 'bpm', align: 'right' },
  key: { label: 'Key', w: 60, sort: 'key' },
  mood: { label: 'Mood', w: 110, sort: 'mood' },
  composer: { label: 'Composer', w: 160, sort: 'composer', get: (t) => (t.composer || []).join(', ') },
  label: { label: 'Label', w: 150, sort: 'label', get: (t) => (t.label || []).join(', ') },
  language: { label: 'Language', w: 90, sort: 'language' },
  comment: { label: 'Comment', w: 200, sort: 'comment' },
  isrc: { label: 'ISRC', w: 130, sort: 'isrc', get: (t) => (t.isrc || []).join(', ') },
  path: { label: 'Path', w: 360, sort: 'path' },
  filename: { label: 'File name', w: 260, sort: 'filename' },
  cover: { label: 'Cover', w: 64, sort: 'cover', get: (t) => (t.cover ? '✓' : '–') },
  haslyrics: { label: 'Lyrics', w: 64, sort: 'haslyrics', get: (t) => (t.haslyrics ? '✓' : '–') },
  remoteId: { label: 'On server', w: 84, sort: 'online', get: (t) => (t.remoteId ? '✓' : '–') },
};
const DEFAULT_COLS = ['num', 'title', 'album', 'year', 'genre', 'duration', 'ext', 'added'];

const QUICK = [
  { label: 'No cover', q: '-has:cover', icon: ImageOff },
  { label: 'No genre', q: 'missing:genre', icon: Tags },
  { label: 'No album', q: 'missing:album', icon: Tags },
  { label: 'Added this week', q: 'added:7d', icon: Clock },
  { label: 'Lossless', q: 'is:lossless', icon: FileAudio },
  { label: 'Low quality', q: 'bitrate<192 is:lossy', icon: CircleAlert },
  { label: 'Over 8 minutes', q: 'duration>8:00', icon: Clock },
  { label: 'Not on the server', q: '-has:online', icon: Sparkles, needsService: true },
];

const FILTER_HELP = [
  ['daft punk', 'words anywhere: title, artist, album, file name'],
  ['artist:"daft punk"', 'a field contains'],
  ['genre=house', 'exactly (no case)'],
  ['filename:*remix*', 'wildcards: * anything, ? one character'],
  ['title~/^intro$/i', 'regular expression'],
  ['year>=2010  year:2000..2009', 'compare and ranges'],
  ['duration:3:00..5:00  size>10MB', 'lengths and sizes'],
  ['added:30d', 'added in the last 30 days'],
  ['-genre:rock  NOT has:cover', 'leave out'],
  ['a OR b  (x OR y) z', 'or, and groups'],
  ['missing:album  is:lossless', 'empty fields, flags'],
  ['tag.MOOD:chill  #LANGUAGE=jpn', 'any custom tag'],
  ['sort:-year,album', 'sorting in the filter'],
];

export default function Library() {
  const { pid, caps, profile, fields, fail, toast, afterJob, isAdmin } = useApp();
  const p = usePlayer();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [query, setQuery] = useState(params.get('q') || '');
  const [sort, setSort] = useState(() => store.get('lib.sort', [{ key: 'albumartist' }, { key: 'album' }, { key: 'disc' }, { key: 'track' }]));
  const [cols, setCols] = useState(() => store.get('lib.cols', DEFAULT_COLS));
  const [widths, setWidths] = useState(() => store.get('lib.widths', {}));
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [anchor, setAnchor] = useState(null);
  const [menu, setMenu] = useState(null);
  const [colMenu, setColMenu] = useState(null);
  const [cmd, setCmd] = useState(params.get('cmd') || '');
  const [cmdOpen, setCmdOpen] = useState(Boolean(params.get('cmd')));
  const [preview, setPreview] = useState(null);
  const [editor, setEditor] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [help, setHelp] = useState(false);
  const scroller = useRef(null);
  const sortStr = sort.map((s) => `${s.desc ? '-' : ''}${s.key}`).join(',');

  useEffect(() => store.set('lib.sort', sort), [sort]);
  useEffect(() => store.set('lib.cols', cols), [cols]);
  useEffect(() => store.set('lib.widths', widths), [widths]);

  const load = useCallback(async () => {
    if (!pid || !caps.files) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await get(`p/${pid}/tracks`, { q: query, sort: sortStr, limit: 5000, columns: cols.join(',') });
      setRows(r.tracks);
      setTotal(r.total);
    } catch (e) {
      setErr(e.message);
    }
    setLoading(false);
  }, [pid, query, sortStr, caps.files, cols]);
  useEffect(() => {
    load();
  }, [load]);

  // Open the editor straight away for ?ids=…&edit=all (from album / playlist pages).
  useEffect(() => {
    const ids = params.get('ids');
    if (ids) {
      setEditor(ids.split(',').map(Number));
      setParams((x) => {
        x.delete('ids');
        x.delete('edit');
        return x;
      });
    } else if (params.get('edit') === 'all' && rows.length) {
      setEditor(rows.map((r) => r.id));
      setParams((x) => {
        x.delete('edit');
        return x;
      });
    }
  }, [params, rows, setParams]);

  // Refresh when jobs that change files finish.
  const { jobs } = useApp();
  const doneCount = Object.values(jobs).filter((j) => j.status === 'done' && ['bulk', 'scan', 'import', 'organize', 'edit', 'transfer', 'duplicates'].includes(j.kind)).length;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount]);

  const applyQuery = useMemo(
    () =>
      debounce((v) => {
        setQuery(v);
        setParams((x) => {
          if (v) x.set('q', v);
          else x.delete('q');
          return x;
        }, { replace: true });
      }, 250),
    [setParams],
  );

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => (document.documentElement.dataset.density === 'compact' ? 40 : 52), overscan: 12 });
  const grid = cols.map((c) => `${widths[c] || COLUMNS[c].w}px`).join(' ');
  const selected = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel]);

  const toggleSort = (key, e) => {
    if (!key) return;
    setSort((s) => {
      const i = s.findIndex((x) => x.key === key);
      if (e.shiftKey) {
        if (i >= 0) return s.map((x, j) => (j === i ? { ...x, desc: !x.desc } : x));
        return [...s, { key }];
      }
      if (i === 0) return [{ key, desc: !s[0].desc }];
      return [{ key }];
    });
  };

  const clickRow = (e, t, i) => {
    const n = new Set(e.ctrlKey || e.metaKey ? sel : []);
    if (e.shiftKey && anchor != null) {
      const a = rows.findIndex((r) => r.id === anchor);
      for (let k = Math.min(a, i); k <= Math.max(a, i); k++) n.add(rows[k].id);
    } else if ((e.ctrlKey || e.metaKey) && n.has(t.id)) n.delete(t.id);
    else n.add(t.id);
    setSel(n);
    if (!e.shiftKey) setAnchor(t.id);
  };

  useEffect(() => {
    const k = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSel(new Set(rows.map((r) => r.id)));
      } else if (e.key === 'Escape') setSel(new Set());
      else if (e.key === 'Enter' && sel.size) setEditor([...sel]);
      else if (e.key === '>' || (e.key === '.' && e.shiftKey)) {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [rows, sel]);

  const songs = (list) => list.map((t) => ({ id: `l:${t.id}`, localId: t.id, remoteId: t.remoteId, title: t.title || t.filename, artist: t.artist, album: t.album, duration: t.duration, coverArt: t.cover ? `l:${t.id}` : null }));

  const runCommand = async (apply) => {
    try {
      const body = { command: cmd, ids: sel.size ? [...sel] : undefined, query: sel.size ? undefined : query, sort: sortStr };
      if (!apply) {
        const r = await post(`p/${pid}/bulk`, { ...body, preview: true });
        if (r.help) return setHelp(true);
        setPreview({ ...r, body });
      } else {
        const r = await post(`p/${pid}/bulk`, { ...preview.body, apply: true, restorePoints: preview.restore ?? preview.total <= 500 });
        setPreview(null);
        if (r.job) {
          toast(`Working on ${plural(r.total, 'song')}… (Activity shows the details)`);
          afterJob(r.job).then((j) => (j.status === 'done' ? toast(`Done: ${j.result?.changed ?? r.total} changed${j.result?.failed ? `, ${j.result.failed} failed` : ''}`) : fail(j.error || 'The command failed')));
        } else toast('Nothing needed to change');
      }
    } catch (e) {
      fail(e);
    }
  };

  if (!caps.files) {
    return (
      <Empty icon={FolderPlus} title={caps.mode === 'none' ? 'No library yet' : `${profile?.name} has no linked folder`} action={isAdmin && <Link className="btn primary" to="/settings/profiles">Link the music folder</Link>}>
        The track table edits your files, so it needs the folder the server plays from. Once it’s linked, you get tags, covers, lyrics, renaming and moving, duplicates and the command line.
      </Empty>
    );
  }

  return (
    <div className="col" style={{ gap: 12, height: '100%' }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="searchbar" style={{ maxWidth: 'none' }}>
          <Search />
          <input
            className="input mono"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              applyQuery(e.target.value);
            }}
            placeholder='Filter: artist:"daft punk" year>2000 -has:cover   (? for help)'
            aria-label="Filter"
            spellCheck={false}
            onKeyDown={(e) => e.key === '?' && !q && (e.preventDefault(), setHelp(true))}
          />
        </div>
        <button className="btn icon" onClick={() => setHelp(true)} aria-label="How filtering works" title="How filtering works"><HelpCircle /></button>
        <button className={cx('btn', cmdOpen && 'on')} onClick={() => setCmdOpen(!cmdOpen)} title="Command line (>)"><Terminal /> Command</button>
        <button className="btn icon" onClick={(e) => setColMenu({ x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom + 4 })} aria-label="Columns" title="Columns"><Columns3 /></button>
        <button className="btn icon" onClick={async () => { const r = await post(`p/${pid}/scan`, {}); toast('Reading new and changed files…'); afterJob(r.job).then(load); }} aria-label="Rescan the folder" title="Rescan the folder"><RefreshCw /></button>
      </div>
      <div className="chips">
        <button className="chip" style={{ borderColor: 'var(--accent-line)', color: 'var(--accent)' }} onClick={() => setDialog('fill')}><Wand2 /> Fill in missing details</button>
        {QUICK.filter((c) => !c.needsService || caps.service).map((c) => (
          <button key={c.label} className={cx('chip', query.includes(c.q) && 'active')} onClick={() => { const v = query.includes(c.q) ? query.replace(c.q, '').trim() : `${query} ${c.q}`.trim(); setQ(v); applyQuery(v); }}>
            <c.icon /> {c.label}
          </button>
        ))}
      </div>
      {cmdOpen && (
        <form className="cmdline" onSubmit={(e) => { e.preventDefault(); cmd.trim() && runCommand(false); }}>
          <span className="prompt">&gt;</span>
          <input autoFocus value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={`replace artist " & " " / "   ·   set genre = Phonk   ·   help      (runs on ${sel.size ? `${sel.size} selected` : `all ${total} shown`})`} spellCheck={false} aria-label="Command" />
          <button className="btn small" disabled={!cmd.trim()}>Preview</button>
          <button type="button" className="btn small ghost" onClick={() => setHelp('cmd')}>Help</button>
        </form>
      )}
      <div className="row wrap" style={{ fontSize: 12.5, rowGap: 2 }}>
        <span className="faint grow">
          {loading ? 'Loading…' : `${total.toLocaleString()} songs${total > rows.length ? ` (first ${rows.length.toLocaleString()} shown; narrow the filter)` : ''}`}
          {sel.size > 0 && ` · ${sel.size} selected`}
        </span>
        {sort.length > 0 && <span className="faint">Sorted by {sort.map((s) => `${COLUMNS[s.key]?.label || s.key}${s.desc ? ' ↓' : ''}`).join(', ')} <span className="hide-touch"> · shift-click adds a column</span></span>}
      </div>
      {err && <Notice kind="danger">{err}</Notice>}

      <div ref={scroller} className="ttable" style={{ flex: 1, minHeight: 300, overflow: 'auto', margin: '0 -10px', padding: '0 10px' }}>
        <div style={{ minWidth: 'max-content' }}>
          <div className="thead" style={{ gridTemplateColumns: grid }}>
            {cols.map((c) => {
              const col = COLUMNS[c];
              const s = sort.find((x) => x.key === col.sort);
              return (
                <div key={c} style={{ justifyContent: col.align === 'right' ? 'flex-end' : undefined, position: 'relative' }} onClick={(e) => toggleSort(col.sort, e)}>
                  {col.label}
                  {s && (s.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
                  <span
                    className="resize"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const start = e.clientX;
                      const w0 = widths[c] || col.w;
                      const mv = (ev) => setWidths((w) => ({ ...w, [c]: Math.max(44, w0 + ev.clientX - start) }));
                      const up = () => {
                        window.removeEventListener('pointermove', mv);
                        window.removeEventListener('pointerup', up);
                      };
                      window.addEventListener('pointermove', mv);
                      window.addEventListener('pointerup', up);
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((v) => {
              const t = rows[v.index];
              const playing = p.current?.localId === t.id;
              return (
                <div
                  key={t.id}
                  className={cx('trow', sel.has(t.id) && 'sel', playing && 'playing')}
                  style={{ gridTemplateColumns: grid, transform: `translateY(${v.start}px)`, height: v.size }}
                  onClick={(e) => clickRow(e, t, v.index)}
                  onDoubleClick={() => p.playList(songs(rows), v.index, pid)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const list = sel.has(t.id) ? selected : [t];
                    if (!sel.has(t.id)) setSel(new Set([t.id]));
                    setMenu({ at: { x: e.clientX, y: e.clientY }, list });
                  }}
                >
                  {cols.map((c) => {
                    if (c === 'num')
                      return (
                        <div key={c} className="c-num">
                          <span className="n">{v.index + 1}</span>
                          <button className="btn icon small ghost play-i" onClick={(e) => { e.stopPropagation(); p.playList(songs(rows), v.index, pid); }} aria-label="Play"><Play size={14} fill="currentColor" /></button>
                        </div>
                      );
                    if (c === 'title')
                      return (
                        <div key={c} className="c-title">
                          <Cover pid={pid} id={t.cover ? `l:${t.id}` : null} size={80} />
                          <span className="tt">
                            <b>{t.title || <span className="faint">{t.filename}</span>}</b>
                            <small>{t.artist || <span className="faint">Unknown artist</span>}</small>
                          </span>
                        </div>
                      );
                    const col = COLUMNS[c];
                    const val = col.get ? col.get(t, v.index) : t[c];
                    return (
                      <div key={c} style={{ textAlign: col.align }} className={col.align === 'right' ? 'tabular' : undefined} title={typeof val === 'string' ? val : undefined}>
                        {Array.isArray(val) ? val.join(', ') : val}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {!loading && !rows.length && (
            <Empty icon={Search} title={query ? 'Nothing matches this filter' : 'No songs in this folder yet'} action={!query && <Link className="btn primary" to="/add">Add music</Link>}>
              {query ? 'Try fewer conditions. The ? button explains the filter.' : 'Add music, or rescan the folder if you just copied files in.'}
            </Empty>
          )}
          {loading && !rows.length && <div style={{ padding: 40 }}><Spinner /></div>}
        </div>
      </div>

      {sel.size > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Selected songs">
          <b style={{ marginRight: 6 }}>{plural(sel.size, 'song')}</b>
          <button className="btn small primary" onClick={() => setEditor([...sel])}><Pencil /> Edit</button>
          <button className="btn small ghost" onClick={() => p.playList(songs(selected), 0, pid)}><Play /> Play</button>
          <button className="btn small ghost" onClick={() => p.addToQueue(songs(selected), pid)}><ListPlus /> Queue</button>
          <button className="btn small ghost" onClick={() => setDialog('playlist')}><ListMusic /> Playlist</button>
          <button className="btn small ghost" onClick={() => setDialog('cover')}><Image /> Cover</button>
          <button className="btn small ghost" onClick={() => { setCmdOpen(true); }}><Terminal /> Command</button>
          <button className="btn small ghost" onClick={() => setDialog('transfer')}><ArrowRightLeft /> Move / copy</button>
          {sel.size > 1 && sel.size <= 12 && <button className="btn small ghost" onClick={() => setDialog('merge')}><Merge /> Merge</button>}
          <button className="btn small ghost danger" onClick={() => setDialog('remove')}><Trash2 /> Remove</button>
          <button className="btn icon small ghost" onClick={() => setSel(new Set())} aria-label="Clear the selection"><X /></button>
        </div>
      )}

      {menu && (
        <SongMenu
          songs={songs(menu.list).map((s, i) => ({ ...s, albumId: undefined }))}
          menu={menu}
          pid={pid}
          onClose={() => setMenu(null)}
          onEdit={(ids) => setEditor(ids)}
          extra={
            <>
              <MenuSep />
              <MenuItem icon={Image} onClick={() => setDialog('cover')}>Set a cover…</MenuItem>
              <MenuItem icon={ArrowRightLeft} onClick={() => setDialog('transfer')}>Move or copy to…</MenuItem>
              {menu.list.length > 1 && menu.list.length <= 12 && <MenuItem icon={Merge} onClick={() => setDialog('merge')}>Merge into one…</MenuItem>}
              {menu.list.length === 1 && <MenuItem icon={Wand2} onClick={() => setEditor([menu.list[0].id])}>Find the right details…</MenuItem>}
              {menu.list.length === 1 && <MenuItem icon={Download} onClick={() => window.open(`/api/p/${pid}/tracks/${menu.list[0].id}/file?download=1`)}>Download</MenuItem>}
              <MenuItem icon={Trash2} danger onClick={() => setDialog('remove')}>Remove…</MenuItem>
            </>
          }
        />
      )}
      {colMenu && (
        <Menu at={colMenu} align="right" onClose={() => setColMenu(null)}>
          <div className="menu-label">Columns</div>
          {Object.entries(COLUMNS).filter(([, c]) => !c.fixed).map(([k, c]) => (
            <MenuItem key={k} onClick={() => setCols((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]))} hint={cols.includes(k) ? '✓' : ''}>
              <span data-keep>{c.label}</span>
            </MenuItem>
          ))}
          <MenuSep />
          <MenuItem onClick={() => { setCols(DEFAULT_COLS); setWidths({}); }}>Reset</MenuItem>
        </Menu>
      )}
      {preview && <CommandPreview preview={preview} setPreview={setPreview} onApply={() => runCommand(true)} />}
      {help && <FilterHelp kind={help} commands={fields?.commands} onClose={() => setHelp(false)} />}
      {editor && <TrackEditor ids={editor} onClose={() => setEditor(null)} onSaved={load} />}
      {dialog === 'playlist' && <AddToPlaylist songs={songs(selected)} pid={pid} onClose={() => setDialog(null)} />}
      {dialog === 'merge' && <MergeDialog tracks={selected} onClose={() => setDialog(null)} onDone={() => { setSel(new Set()); load(); }} />}
      {dialog === 'fill' && <FillMissing query={sel.size ? `${[...sel].map((id) => `id=${id}`).join(' OR ')}` : undefined} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === 'transfer' && <TransferDialog ids={[...sel]} onClose={() => setDialog(null)} />}
      {dialog === 'remove' && <RemoveDialog ids={[...sel]} onClose={() => setDialog(null)} onDone={() => { setSel(new Set()); load(); }} />}
      {dialog === 'cover' && (
        <ImageEditor
          title={`Cover for ${plural(sel.size, 'song')}`}
          allowAnimated={false}
          onClose={() => setDialog(null)}
          onSave={async (blob) => {
            const ids = [...sel];
            await api(`p/${pid}/tracks/${ids[0]}/cover`, { method: 'PUT', body: blob, query: { ids: ids.join(',') }, headers: { 'Content-Type': blob.type } });
            toast(`Cover set on ${plural(ids.length, 'song')}`);
            setDialog(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CommandPreview({ preview, setPreview, onApply }) {
  const restore = preview.restore ?? preview.total <= 500;
  return (
    <Modal
      title={`${plural(preview.total, 'song')} would change`}
      size="wide"
      onClose={() => setPreview(null)}
      footer={
        <>
          <span className="grow"><Toggle checked={restore} onChange={(v) => setPreview({ ...preview, restore: v })} label="Make restore points" description="Copies each file first so you can undo. Uses disk space." /></span>
          <button className="btn ghost" onClick={() => setPreview(null)}>Cancel</button>
          <button className="btn primary" onClick={onApply} disabled={!preview.total}>Apply to {plural(preview.total, 'song')}</button>
        </>
      }
    >
      <p className="faint mono" style={{ margin: 0, fontSize: 12.5 }}>&gt; {preview.body.command} · checked {preview.scanned}</p>
      {!preview.total && <Notice>Nothing would change. The values are already like that, or the find text isn’t there.</Notice>}
      <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
        {preview.preview.map((it) => (
          <div key={it.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="ellipsis"><b>{it.title || it.path}</b> <span className="faint">{it.artist}</span></div>
            {Object.entries(it.changes).map(([f, [a, b]]) => (
              <div key={f} className="mono" style={{ fontSize: 12.5 }}>
                <span className="faint">{f}: </span><span className="change-old">{String(a) || '∅'}</span> → <span className="change-new">{String(b) || '∅'}</span>
              </div>
            ))}
            {Object.entries(it.custom || {}).map(([f, [a, b]]) => (
              <div key={f} className="mono" style={{ fontSize: 12.5 }}><span className="faint">{f}: </span><span className="change-old">{a || '∅'}</span> → <span className="change-new">{b || '∅'}</span></div>
            ))}
            {it.move && <div className="mono" style={{ fontSize: 12.5 }}><span className="faint">file: </span><span className="change-old">{it.path}</span> → <span className="change-new">{it.move}</span></div>}
            {it.delete && <div className="mono" style={{ fontSize: 12.5, color: 'var(--danger)' }}>goes to the trash</div>}
            {it.noSplit !== undefined && <div className="mono" style={{ fontSize: 12.5 }}>keep artists together: {it.noSplit ? 'on' : 'off'}</div>}
          </div>
        ))}
        {preview.total > preview.preview.length && <p className="faint">… and {preview.total - preview.preview.length} more.</p>}
      </div>
    </Modal>
  );
}

function FilterHelp({ kind, commands, onClose }) {
  return (
    <Modal title={kind === 'cmd' ? 'Commands' : 'Filtering'} size="wide" onClose={onClose}>
      {kind === 'cmd' ? (
        <>
          <p className="muted" style={{ margin: 0 }}>Commands run on the selected songs, or on everything the filter shows. You always see what would change first.</p>
          <div className="col" style={{ gap: 2 }}>
            {(commands || []).map((c) => (
              <div key={c.cmd} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <div><code className="mono">{c.example}</code></div>
                <div className="muted" style={{ fontSize: 13 }}>{c.text}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>Combine as many as you like. Every field of the editor works, plus file fields like <span className="mono">bitrate</span>, <span className="mono">ext</span>, <span className="mono">path</span>, <span className="mono">added</span>.</p>
          <div className="col" style={{ gap: 2 }}>
            {FILTER_HELP.map(([ex, d]) => (
              <div key={ex} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <code className="mono">{ex}</code>
                <span className="muted" style={{ fontSize: 13 }}>{d}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

export { useConfirm, ShareDialog };
