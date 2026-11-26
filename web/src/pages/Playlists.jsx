import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Plus, ListMusic, Share2, Trash2, Pencil, ImagePlus, Wand2, Shuffle, Download, Globe, Lock, Check } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, patch, del, api } from '../lib/api.js';
import { fmtLong, plural, ago } from '../lib/util.js';
import { Cover, Empty, Notice, Spinner, Modal, Field, Toggle, Segmented, useConfirm } from '../components/ui.jsx';
import { SongList, PlayAll, ShareDialog } from '../components/Songs.jsx';
import { ImageEditor } from '../components/ImageEditor.jsx';
import { useMenus } from '../components/menus.jsx';

/** Playlist pictures come at full size so animated covers keep moving. */
export const playlistCover = (pid, pl, v = 0) => `/api/p/${pid}/image/playlist/${encodeURIComponent(pl.id)}?cover=${encodeURIComponent(pl.coverArt || '')}&v=${v}`;

export function Playlists() {
  const { pid, caps, fail, toast } = useApp();
  const menus = useMenus();
  const nav = useNavigate();
  const { data, loading, error, reload } = useLoad(() => get(`p/${pid}/playlists`), [pid]);
  const [create, setCreate] = useState(null);
  const make = async () => {
    try {
      const pl = await post(`p/${pid}/playlists`, { name: create.name, local: create.local });
      toast('Playlist made');
      setCreate(null);
      nav(`/playlist/${encodeURIComponent(pl.id)}`);
    } catch (e) {
      fail(e);
    }
  };
  const normal = (data || []).filter((p) => !p.smart);
  const [view, setView] = useState(() => localStorage.getItem('mmm.plView') || 'grid');
  const setV = (v) => { setView(v); localStorage.setItem('mmm.plView', v); };
  const smart = (data || []).filter((p) => p.smart);
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Playlists</h1>
          {data && <p className="page-sub">{plural(data.length, 'playlist')}</p>}
        </div>
        {caps.smart && <Link className="btn" to="/smart"><Wand2 /> Smart playlist</Link>}
        <Segmented value={view} onChange={setV} options={[{ value: 'grid', label: 'Covers' }, { value: 'list', label: 'List' }]} />
        <button className="btn primary" onClick={() => setCreate({ name: '', local: !caps.service })}><Plus /> New playlist</button>
      </div>
      {caps.offline && <Notice kind="warn">The server is offline; only playlists kept in Master Music Manager show.</Notice>}
      {loading && !data && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {data && !data.length && <Empty icon={ListMusic} title="No playlists yet">Make one, or add songs to a new playlist from any song’s menu.</Empty>}
      {view === 'list' && (
        <div className="col" style={{ gap: 2 }}>
          {[...normal, ...(data || []).filter((p) => p.smart)].map((pl) => (
            <Link key={pl.id} to={`/playlist/${encodeURIComponent(pl.id)}`} className="trow" style={{ position: 'relative', gridTemplateColumns: '56px minmax(0, 1fr) 120px 140px', height: 64, textDecoration: 'none' }} onContextMenu={(e) => menus.playlist(e, pl, { onChanged: reload })}>
              <div><Cover src={playlistCover(pid, pl)} icon={pl.smart ? Wand2 : ListMusic} style={{ width: 48 }} /></div>
              <div className="c-title"><span className="tt"><b>{pl.name}</b><small>{pl.comment || (pl.smart ? 'Updates itself' : pl.local ? 'In this app' : pl.owner || '')}</small></span></div>
              <div>{plural(pl.songCount || 0, 'song')}</div>
              <div className="faint">{pl.changed ? `changed ${ago(pl.changed)}` : ''}</div>
            </Link>
          ))}
        </div>
      )}
      {view === 'grid' && <div className="grid">
        {normal.map((pl) => (
          <Link key={pl.id} className="tile" to={`/playlist/${encodeURIComponent(pl.id)}`} onContextMenu={(e) => menus.playlist(e, pl, { onChanged: reload })}>
            <Cover src={playlistCover(pid, pl)} icon={ListMusic} />
            <span className="t ellipsis">{pl.name}</span>
            <span className="s">{plural(pl.songCount || 0, 'song')}{pl.local ? ' · in this app' : pl.owner ? ` · ${pl.owner}` : ''}</span>
          </Link>
        ))}
      </div>}
      {view === 'grid' && smart.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Smart playlists</h2><Link className="more" to="/smart">Edit rules</Link></div>
          <div className="grid">
            {smart.map((pl) => (
              <Link key={pl.id} className="tile" to={`/playlist/${encodeURIComponent(pl.id)}`} onContextMenu={(e) => menus.playlist(e, pl, { onChanged: reload })}>
                <Cover src={playlistCover(pid, pl)} icon={Wand2} />
                <span className="t ellipsis">{pl.name}</span>
                <span className="s">{plural(pl.songCount || 0, 'song')} · updates itself</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {create && (
        <Modal title="New playlist" onClose={() => setCreate(null)} footer={<><button className="btn ghost" onClick={() => setCreate(null)}>Cancel</button><button className="btn primary" onClick={make} disabled={!create.name}>Create</button></>}>
          <Field label="Name"><input className="input" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} autoFocus onKeyDown={(e) => e.key === 'Enter' && create.name && make()} /></Field>
          {caps.service && <Toggle checked={create.local} onChange={(v) => setCreate({ ...create, local: v })} label="Keep it only in Master Music Manager" description={`Off: it’s made on ${caps.kindLabel} and shows in every app.`} />}
        </Modal>
      )}
    </>
  );
}

export function Playlist() {
  const { id } = useParams();
  const { pid, caps, fail, toast } = useApp();
  const nav = useNavigate();
  const p = usePlayer();
  const confirm = useConfirm();
  const { data: pl, loading, error, reload, setData } = useLoad(() => get(`p/${pid}/playlists/${encodeURIComponent(id)}`), [pid, id]);
  const [edit, setEditState] = useState(null);
  const [params, setParams] = useSearchParams();
  const setEdit = (v) => {
    setEditState(v);
    if (!v && params.has('edit')) setParams((x) => { x.delete('edit'); return x; }, { replace: true });
  };
  const [share, setShare] = useState(false);
  const [img, setImg] = useState(false);
  const [v, setV] = useState(0);
  // ?edit=1 (from a right-click menu) opens the editor once the playlist is there.
  useEffect(() => {
    if (pl && params.get('edit') === '1' && !edit && !pl.smart) setEditState({ name: pl.name, comment: pl.comment || '', public: Boolean(pl.public) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pl?.id]);
  if (loading && !pl) return <Spinner />;
  if (error) return <Notice kind="danger">{error.message}</Notice>;
  if (!pl) return null;
  const songs = pl.songs || [];
  const readonly = pl.readonly || pl.smart;
  const total = songs.reduce((a, s) => a + (s.duration || 0), 0);

  const reorder = async (from, to) => {
    const list = songs.slice();
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    setData({ ...pl, songs: list });
    try {
      await patch(`p/${pid}/playlists/${encodeURIComponent(pl.id)}`, { songIds: list.map((s) => s.id) });
    } catch (e) {
      fail(e);
      reload();
    }
  };
  const remove = async (indexes) => {
    try {
      await patch(`p/${pid}/playlists/${encodeURIComponent(pl.id)}`, { removeIndexes: indexes });
      toast(`Removed ${plural(indexes.length, 'song')}`);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const exportM3u = () => {
    const text = `#EXTM3U\n#PLAYLIST:${pl.name}\n${songs.map((s) => `#EXTINF:${Math.round(s.duration || -1)},${s.artist || ''} - ${s.title}\n${s.path || `${s.artist} - ${s.title}`}`).join('\n')}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'audio/x-mpegurl' }));
    a.download = `${pl.name}.m3u8`;
    a.click();
  };
  return (
    <>
      <header className="hero">
        <div className="hero-bg" style={{ backgroundImage: `url(${playlistCover(pid, pl, v)})` }} />
        <div style={{ position: 'relative' }}>
          <Cover src={playlistCover(pid, pl, v)} icon={ListMusic} style={{ width: 220 }} />
          <button className="btn icon small" style={{ position: 'absolute', right: 10, bottom: 10 }} onClick={() => setImg(true)} aria-label="Change the cover" title="Change the cover (GIFs stay animated)"><ImagePlus /></button>
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="kind">{pl.smart ? 'Smart playlist' : 'Playlist'}</div>
          <h1>{pl.name}</h1>
          {pl.comment && <p className="muted" style={{ margin: '0 0 6px' }}>{pl.comment}</p>}
          <div className="facts">
            {pl.owner && <b>{pl.owner}</b>}
            <span>{plural(songs.length, 'song')}, {fmtLong(total)}</span>
            {pl.changed && <span>· changed {ago(pl.changed)}</span>}
            {pl.public !== undefined && <span className="badge">{pl.public ? <><Globe size={11} /> Public</> : <><Lock size={11} /> Private</>}</span>}
            {pl.local && <span className="badge">In this app only</span>}
          </div>
          <div className="hero-actions">
            <PlayAll songs={songs} pid={pid} />
            <button className="btn icon" onClick={() => p.playList([...songs].sort(() => Math.random() - 0.5), 0, pid)} aria-label="Shuffle"><Shuffle /></button>
            <button className="btn icon" onClick={() => setShare(true)} aria-label="Share"><Share2 /></button>
            {!readonly && <button className="btn" onClick={() => setEdit({ name: pl.name, comment: pl.comment || '', public: Boolean(pl.public) })}><Pencil /> Edit</button>}
            <button className="btn icon" onClick={exportM3u} aria-label="Export as M3U8" title="Export as M3U8"><Download /></button>
            <span className="spacer" />
            {!pl.smart && (
              <button
                className="btn ghost danger"
                onClick={async () => {
                  if (!(await confirm({ title: `Delete “${pl.name}”?`, body: 'The songs stay in your library.', danger: true, confirm: 'Delete playlist' }))) return;
                  await del(`p/${pid}/playlists/${encodeURIComponent(pl.id)}`).then(() => nav('/playlists'), fail);
                }}
              >
                <Trash2 /> Delete
              </button>
            )}
          </div>
        </div>
      </header>
      {pl.smart && <div style={{ marginTop: 14 }}><Notice kind="accent" icon={Wand2}>This playlist fills itself from rules. <Link to="/smart">Change its rules</Link>.</Notice></div>}
      <section className="section" style={{ marginTop: 18 }}>
        {songs.length ? (
          <SongList songs={songs} pid={pid} numbered="index" onReorder={readonly ? undefined : reorder} onRemove={readonly ? undefined : remove} onEdit={caps.files ? (ids) => nav(`/library?ids=${ids.join(',')}&edit=all`) : undefined} />
        ) : (
          <Empty icon={ListMusic} title="Empty playlist">Add songs from any song’s menu (right click) → Add to a playlist.</Empty>
        )}
      </section>
      {edit && (
        <Modal
          title="Edit playlist"
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn primary" onClick={async () => { try { await patch(`p/${pid}/playlists/${encodeURIComponent(pl.id)}`, edit); setEdit(null); reload(); toast('Saved'); } catch (e) { fail(e); } }}><Check /> Save</button>
            </>
          }
        >
          <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Description"><textarea className="textarea" rows={3} value={edit.comment} onChange={(e) => setEdit({ ...edit, comment: e.target.value })} /></Field>
          {!pl.local && caps.kind !== 'jellyfin' && <Toggle checked={edit.public} onChange={(x) => setEdit({ ...edit, public: x })} label="Public" description="Other people on the server can see it." />}
        </Modal>
      )}
      {share && <ShareDialog kind="playlist" refData={{ id: pl.id }} title={pl.name} pid={pid} onClose={() => setShare(false)} />}
      {img && (
        <ImageEditor
          title={`Cover of ${pl.name}`}
          onClose={() => setImg(false)}
          onSave={async (blob) => {
            const r = await api(`p/${pid}/image/playlist/${encodeURIComponent(pl.id)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type } });
            toast(r.synced ? `Cover saved, also on ${caps.kindLabel}` : r.note || 'Cover saved');
            setImg(false);
            setV((x) => x + 1);
          }}
        />
      )}
    </>
  );
}

export { useEffect };
