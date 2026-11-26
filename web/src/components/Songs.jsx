import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Play, ListPlus, ListEnd, ListMusic, Share2, Pencil, Heart, Disc3, User, Download, Trash2, MoreHorizontal, Plus, Copy, Lock, Globe, EyeOff, Ban, Radio as RadioIcon } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, patch } from '../lib/api.js';
import { fmtTime, cx, copy } from '../lib/util.js';
import { Cover, Menu, MenuItem, MenuSep, Modal, Field, Toggle, Segmented, Notice, CopyField, Spinner, useConfirm } from './ui.jsx';

/** Actions for one or more songs (service or local shapes). */
export function SongMenu({ songs, menu, onClose, onEdit, pid: pidIn, extra }) {
  const { pid: cur, caps, fail, toast } = useApp();
  const pid = pidIn || cur;
  const p = usePlayer();
  const nav = useNavigate();
  const [dialog, setDialog] = useState(null);
  const s = songs[0];
  const many = songs.length > 1;
  const remoteIds = songs.map((x) => (String(x.id).startsWith('l:') ? x.remoteId : x.id)).filter(Boolean);
  const localIds = songs.map((x) => x.localId ?? (String(x.id).startsWith('l:') ? Number(String(x.id).slice(2)) : null)).filter(Boolean);
  return (
    <>
      {menu && (
        <Menu at={menu.at} align={menu.align} onClose={onClose}>
          <MenuItem icon={Play} onClick={() => p.playList(songs, 0, pid)}>Play{many ? ` ${songs.length} songs` : ''}</MenuItem>
          <MenuItem icon={ListPlus} onClick={() => p.addToQueue(songs, pid, { nextUp: true })}>Play next</MenuItem>
          <MenuItem icon={ListEnd} onClick={() => p.addToQueue(songs, pid)}>Add to the queue</MenuItem>
          <MenuItem icon={ListMusic} onClick={() => setDialog('playlist')}>Add to a playlist…</MenuItem>
          <MenuSep />
          {!many && s.albumId && <MenuItem icon={Disc3} onClick={() => nav(`/album/${encodeURIComponent(s.albumId)}`)}>Go to the album</MenuItem>}
          {!many && (s.artistId || s.artist) && <MenuItem icon={User} onClick={() => nav(s.artistId ? `/artist/${encodeURIComponent(s.artistId)}` : `/library?q=${encodeURIComponent(`artist:"${s.artist}"`)}`)}>Go to the artist</MenuItem>}
          {caps.favorites && remoteIds.length > 0 && (
            <MenuItem icon={Heart} onClick={() => post(`p/${pid}/star`, { ids: remoteIds, on: !s.starred }).then(() => toast(s.starred ? 'Removed from favorites' : 'Added to favorites'), fail)}>
              {s.starred ? 'Remove from favorites' : 'Add to favorites'}
            </MenuItem>
          )}
          <MenuItem icon={Share2} onClick={() => setDialog('share')}>Share…</MenuItem>
          {caps.files && localIds.length > 0 && onEdit && <MenuItem icon={Pencil} onClick={() => onEdit(localIds)}>Edit {many ? `${localIds.length} songs` : 'details'}</MenuItem>}
          {caps.files && !many && localIds[0] && (
            <MenuItem icon={Download} onClick={() => window.open(`/api/p/${pid}/tracks/${localIds[0]}/file?download=1`)}>Download the file</MenuItem>
          )}
          <MenuItem icon={Ban} onClick={() => { p.setTrash({ ...p.trash, songs: [...new Set([...p.trash.songs, ...songs.map((x) => `${x.title}|${x.artist}`)])] }); toast('The player will skip these from now on'); }}>
            Never play {many ? 'these' : 'this'} (trash bin)
          </MenuItem>
          {!many && <MenuItem icon={Copy} onClick={() => copy(`${s.artist || ''} - ${s.title}`).then(() => toast('Copied'))}>Copy “Artist - Title”</MenuItem>}
          {extra}
        </Menu>
      )}
      {dialog === 'playlist' && <AddToPlaylist songs={songs} pid={pid} onClose={() => setDialog(null)} />}
      {dialog === 'share' && <ShareDialog kind={many ? 'selection' : 'track'} refData={{ ids: songs.map((x) => x.id) }} title={many ? `${songs.length} songs` : s.title} pid={pid} onClose={() => setDialog(null)} />}
    </>
  );
}

export function AddToPlaylist({ songs, pid, onClose }) {
  const { toast, fail } = useApp();
  const { data, loading } = useLoad(() => get(`p/${pid}/playlists`), [pid]);
  const [name, setName] = useState('');
  const add = async (pl) => {
    try {
      await patch(`p/${pid}/playlists/${encodeURIComponent(pl.id)}`, { add: songs.map((s) => s.id) });
      toast(`Added to “${pl.name}”`);
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  const create = async () => {
    try {
      const pl = await post(`p/${pid}/playlists`, { name, songIds: songs.map((s) => s.id) });
      toast(`Made “${pl.name || name}”`);
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal title={`Add ${songs.length === 1 ? `“${songs[0].title}”` : `${songs.length} songs`} to a playlist`} onClose={onClose}>
      <div className="row">
        <input className="input" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && create()} />
        <button className="btn primary" disabled={!name} onClick={create}><Plus /> Create</button>
      </div>
      {loading && <Spinner />}
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {(data || []).filter((x) => !x.readonly && !x.smart).map((pl) => (
          <button key={pl.id} className="menu-item" onClick={() => add(pl)}>
            <ListMusic /> <span className="grow ellipsis">{pl.name}</span> <small>{pl.songCount} songs{pl.local ? ' · here only' : ''}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** Create a share (ours, optionally also on Navidrome). */
export function ShareDialog({ kind, refData, title, pid, onClose }) {
  const { settings, caps, fail } = useApp();
  const d = settings?.shares || {};
  const [f, setF] = useState({ name: '', description: '', visibility: d.defaultVisibility || 'public', allowDownload: Boolean(d.defaultDownload), expires: d.defaultExpiryDays ? String(d.defaultExpiryDays) : '', key: '', alsoOnService: false });
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post('shares', {
        profileId: pid,
        kind,
        ref: refData,
        name: f.name,
        description: f.description,
        visibility: f.visibility,
        key: f.key,
        allowDownload: f.allowDownload,
        expiresAt: f.expires ? Date.now() + Number(f.expires) * 86400e3 : null,
        alsoOnService: f.alsoOnService,
      });
      setMade(r);
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  if (made)
    return (
      <Modal title="Share link ready" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <CopyField value={made.url} />
        {made.key && (
          <Field label="Key" hint="People need this key to open the share. It is shown only now.">
            <CopyField value={made.key} />
          </Field>
        )}
        {made.remoteUrl && <Field label="On the music server too"><CopyField value={made.remoteUrl} /></Field>}
        {made.serviceError && <Notice kind="warn">Not created on the server: {made.serviceError}</Notice>}
        {!settings?.public?.url && <Notice kind="warn">Set this app’s public address in Settings → General, or the link only works where you are now.</Notice>}
      </Modal>
    );
  return (
    <Modal
      title={`Share ${title ? `“${title}”` : ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}><Share2 /> Create link</button>
        </>
      }
    >
      <Field label="Name (optional)" hint="Shown on the share page and in link previews.">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={title} />
      </Field>
      <Field label="Description (optional)">
        <textarea className="textarea" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <Field label="Who can open it">
        <Segmented
          value={f.visibility}
          onChange={(v) => setF({ ...f, visibility: v })}
          options={[
            { value: 'public', label: 'Anyone with the link', icon: Globe },
            { value: 'key', label: 'Needs a key', icon: Lock },
            { value: 'private', label: 'Only me', icon: EyeOff },
          ]}
        />
      </Field>
      {f.visibility === 'key' && (
        <Field label="Key" hint="Leave empty and one is made for you.">
          <input className="input mono" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
        </Field>
      )}
      {f.visibility !== 'public' && <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Link previews (Discord, WhatsApp …) only show the title and cover for public shares.</p>}
      <div className="fields two">
        <Field label="Expires after">
          <select className="select" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })}>
            <option value="">Never</option>
            <option value="1">1 day</option>
            <option value="7">1 week</option>
            <option value="30">30 days</option>
            <option value="365">1 year</option>
          </select>
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <Toggle checked={f.allowDownload} onChange={(v) => setF({ ...f, allowDownload: v })} label="Allow downloads" />
        </div>
      </div>
      {caps.serviceShares && ['track', 'album', 'playlist', 'selection'].includes(kind) && (
        <Toggle checked={f.alsoOnService} onChange={(v) => setF({ ...f, alsoOnService: v })} label={`Also create it on ${caps.kindLabel}`} description="Then it shows in the server’s own share list too." />
      )}
    </Modal>
  );
}

/** A plain song list (album, playlist, search results). */
export function SongList({ songs, pid: pidIn, showCover = true, showAlbum = true, numbered = 'track', onReorder, onRemove, onEdit }) {
  const { pid: cur } = useApp();
  const pid = pidIn || cur;
  const p = usePlayer();
  const [menu, setMenu] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [drag, setDrag] = useState(null);
  const playingId = p.current?.id;
  const cols = `44px minmax(0, 2.2fr) ${showAlbum ? 'minmax(0, 1.2fr) ' : ''}64px 40px`;
  return (
    <div>
      <div className="thead" style={{ gridTemplateColumns: cols, position: 'static' }}>
        <div style={{ justifyContent: 'flex-end' }}>#</div>
        <div>Title</div>
        {showAlbum && <div>Album</div>}
        <div style={{ justifyContent: 'flex-end' }}>Length</div>
        <div />
      </div>
      {songs.map((s, i) => (
        <div
          key={`${s.id}-${i}`}
          className={cx('trow', sel.has(i) && 'sel', playingId === s.id && 'playing')}
          style={{ gridTemplateColumns: cols, position: 'relative' }}
          onDoubleClick={() => p.playList(songs, i, pid)}
          onClick={(e) => {
            const n = new Set(e.ctrlKey || e.metaKey ? sel : []);
            if (e.shiftKey && sel.size) {
              const last = Math.max(...sel);
              for (let k = Math.min(last, i); k <= Math.max(last, i); k++) n.add(k);
            } else if (n.has(i)) n.delete(i);
            else n.add(i);
            setSel(n);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const chosen = sel.has(i) ? [...sel].map((k) => songs[k]) : [s];
            setMenu({ at: { x: e.clientX, y: e.clientY }, songs: chosen, index: i });
          }}
          draggable={Boolean(onReorder)}
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => onReorder && e.preventDefault()}
          onDrop={() => {
            if (onReorder && drag != null && drag !== i) onReorder(drag, i);
            setDrag(null);
          }}
        >
          <div className="c-num">
            <span className="n">{numbered === 'track' ? s.track || i + 1 : i + 1}</span>
            <button className="btn icon small ghost play-i" onClick={(e) => { e.stopPropagation(); p.playList(songs, i, pid); }} aria-label={`Play ${s.title}`}><Play size={14} fill="currentColor" /></button>
          </div>
          <div className="c-title">
            {showCover && <Cover pid={pid} id={s.coverArt} size={80} />}
            <span className="tt">
              <b>{s.title}</b>
              <small>{s.artist}</small>
            </span>
          </div>
          {showAlbum && <div>{s.album}</div>}
          <div className="tabular" style={{ textAlign: 'right' }}>{fmtTime(s.duration)}</div>
          <div>
            <button className="btn icon small ghost" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ at: { x: r.right, y: r.bottom }, align: 'right', songs: [s], index: i }); }} aria-label="More">
              <MoreHorizontal />
            </button>
          </div>
        </div>
      ))}
      {menu && (
        <SongMenu
          songs={menu.songs}
          menu={menu}
          pid={pid}
          onEdit={onEdit}
          onClose={() => setMenu(null)}
          extra={onRemove && <><MenuSep /><MenuItem icon={Trash2} danger onClick={() => onRemove(menu.songs.length > 1 ? [...sel] : [menu.index])}>Remove from this playlist</MenuItem></>}
        />
      )}
    </div>
  );
}

export function PlayAll({ songs, pid, label = 'Play' }) {
  const p = usePlayer();
  return (
    <button className="btn round-play" onClick={() => p.playList(songs, 0, pid)} aria-label={label} disabled={!songs?.length}>
      <Play fill="currentColor" />
    </button>
  );
}

export { RadioIcon, useConfirm };
