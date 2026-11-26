import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Play, WifiOff, FolderPlus, ImageOff, Tags, Copy, Download, Library } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get } from '../lib/api.js';
import { Cover, Notice, Spinner, Empty } from '../components/ui.jsx';
import { plural, fmtLong } from '../lib/util.js';
import { useMenus } from '../components/menus.jsx';
import { usePins } from '../lib/pins.js';
import { resolvePin } from '../lib/quickplay.js';
import { useCtxMenu } from '../components/ui.jsx';
import { Shuffle, Clock, Heart, History, Tags as TagIcon, User, ListMusic, Disc3 as DiscIcon, Filter, X as XIcon } from 'lucide-react';

const PIN_ICON = { shuffle: Shuffle, recent: Clock, favorites: Heart, forgotten: History, genre: TagIcon, artist: User, playlist: ListMusic, album: DiscIcon, filter: Filter };

function QuickPlay() {
  const { pid, caps, fail } = useApp();
  const p = usePlayer();
  const pins = usePins();
  const open = useCtxMenu();
  const [busy, setBusy] = useState(null);
  const list = pins.list.filter((x) => x.type !== 'favorites' || caps.favorites || caps.files);
  const go = async (pin, i, mode) => {
    setBusy(i);
    try {
      const songs = await resolvePin(pin, pid, caps);
      if (!songs.length) throw new Error('Nothing to play there yet');
      if (mode === 'next') p.addToQueue(songs, pid, { nextUp: true });
      else if (mode === 'queue') p.addToQueue(songs, pid);
      else p.playList(songs, 0, pid);
    } catch (e) {
      fail(e);
    }
    setBusy(null);
  };
  return (
    <section className="section" style={{ marginTop: 6 }}>
      <div className="section-head"><h2>Quick play</h2><span className="faint" style={{ fontSize: 12.5 }}>Right-click an artist, album, playlist or genre → Pin to Quick play</span></div>
      <div className="quick">
        {list.map((pin, i) => {
          const I = PIN_ICON[pin.type] || Shuffle;
          return (
            <button
              key={`${pin.type}-${pin.id || pin.name}`}
              className="quick-btn"
              onClick={() => go(pin, i)}
              onContextMenu={(e) =>
                open(e, [
                  { heading: pin.name },
                  { label: 'Play', icon: Shuffle, onClick: () => go(pin, i) },
                  { label: 'Play next', icon: Clock, onClick: () => go(pin, i, 'next') },
                  { label: 'Add to the queue', icon: ListMusic, onClick: () => go(pin, i, 'queue') },
                  'sep',
                  i > 0 && { label: 'Move left', onClick: () => pins.move(i, i - 1) },
                  { label: 'Remove from Quick play', icon: XIcon, danger: true, onClick: () => pins.remove(i) },
                  { label: 'Reset Quick play', onClick: pins.reset },
                ])
              }
            >
              {pin.cover ? <img src={`/api/p/${pid}/cover/${encodeURIComponent(pin.cover)}?size=120`} alt="" /> : <span className="qi"><I /></span>}
              <span className="ellipsis">{pin.name}</span>
              {busy === i && <span className="spinner" style={{ marginLeft: 'auto' }} />}
            </button>
          );
        })}
      </div>
    </section>
  );
}


const GENRE_COLORS = ['#8b5cf6', '#22c55e', '#f97316', '#06b6d4', '#ec4899', '#eab308', '#3b82f6', '#ef4444', '#14b8a6', '#a855f7'];

export function AlbumTile({ a, pid }) {
  const p = usePlayer();
  const nav = useNavigate();
  const menus = useMenus();
  return (
    <div className="tile" onContextMenu={(e) => menus.album(e, a)} onClick={() => nav(`/album/${encodeURIComponent(a.id)}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/album/${encodeURIComponent(a.id)}`)}>
      <Cover pid={pid} id={a.coverArt} size={300} />
      <button
        className="play-fab"
        aria-label={`Play ${a.name}`}
        onClick={async (e) => {
          e.stopPropagation();
          const full = await get(`p/${pid}/albums/${encodeURIComponent(a.id)}`);
          p.playList(full.songs, 0, pid);
        }}
      >
        <Play size={20} fill="currentColor" />
      </button>
      <span className="t ellipsis">{a.name}</span>
      <span className="s ellipsis">{[a.artist, a.year].filter(Boolean).join(', ')}</span>
    </div>
  );
}

function Shelf({ title, items, pid, more }) {
  if (!items?.length) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {more && <Link className="more" to={more}>See all</Link>}
      </div>
      <div className="shelf">{items.map((a) => <AlbumTile key={a.id} a={a} pid={pid} />)}</div>
    </section>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night listening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const { pid, profile, caps, me, isAdmin } = useApp();
  const { data, loading, error } = useLoad(() => (pid ? get(`p/${pid}/home`) : null), [pid]);
  const stats = useLoad(() => (pid && caps.files ? get(`p/${pid}/stats`) : null), [pid, caps.files]);
  const nav = useNavigate();
  const p = usePlayer();
  if (!profile)
    return (
      <Empty icon={Library} title="No library yet" action={isAdmin && <Link className="btn primary" to="/settings/profiles?add=1">Add your music</Link>}>
        Connect a Navidrome, Jellyfin or OpenSubsonic server, or point to a folder with music.
      </Empty>
    );
  const s = stats.data;
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">{greeting()}{me?.user?.displayName ? `, ${me.user.displayName}` : ''}.</h1>
          <p className="page-sub">
            {s ? `${plural(s.tracks, 'song')} by ${plural(s.artists, 'artist')}, ${fmtLong(s.duration)} of music.` : profile.name}
          </p>
        </div>
        <button className="btn" onClick={async () => p.playList(await get(`p/${pid}/random`, { size: 100 }), 0, pid)}>
          <Play /> Shuffle everything
        </button>
      </div>
      <QuickPlay />
      {caps.offline && (
        <Notice kind="warn" icon={WifiOff}>
          <b>{profile.name} can’t be reached.</b> {caps.files ? 'You’re seeing your local files; they still play and can be edited.' : 'Link its music folder to keep working while it’s down.'} {profile.status?.error ? <span className="faint">({profile.status.error})</span> : null}
        </Notice>
      )}
      {caps.mode === 'service' && isAdmin && (
        <Notice kind="accent" icon={FolderPlus}>
          You can play and manage playlists here. To edit tags, covers and lyrics, move files and find duplicates, <Link to="/settings/profiles">link the music folder</Link> of {profile.name}.
        </Notice>
      )}
      {caps.files && s && (s.noCover > 0 || s.noGenre > 0) && (
        <section className="section">
          <div className="section-head"><h2>Could use some care</h2></div>
          <div className="chips">
            {s.noCover > 0 && <button className="chip" onClick={() => nav('/library?q=-has:cover')}><ImageOff /> {plural(s.noCover, 'song')} without a cover</button>}
            {s.noGenre > 0 && <button className="chip" onClick={() => nav('/library?q=missing:genre')}><Tags /> {plural(s.noGenre, 'song')} without a genre</button>}
            {s.noAlbum > 0 && <button className="chip" onClick={() => nav('/library?q=missing:album')}><Tags /> {plural(s.noAlbum, 'song')} without an album</button>}
            <button className="chip" onClick={() => nav('/duplicates')}><Copy /> Look for duplicates</button>
            <button className="chip" onClick={() => nav('/add')}><Download /> Get more music</button>
          </div>
        </section>
      )}
      {loading && !data && <div style={{ marginTop: 40 }}><Spinner /></div>}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {data && (
        <>
          <Shelf title="Recently played" items={data.recent} pid={pid} more="/albums?type=recent" />
          <Shelf title="New in your library" items={data.newest} pid={pid} more="/albums?type=newest" />
          <Shelf title="You play these a lot" items={data.frequent} pid={pid} more="/albums?type=frequent" />
          <Shelf title="Something different" items={data.random} pid={pid} more="/albums?type=random" />
          {data.genres?.length > 0 && (
            <section className="section">
              <div className="section-head"><h2>Genres</h2><Link className="more" to="/genres">See all</Link></div>
              <div className="genre-grid">
                {data.genres.slice(0, 12).map((g, i) => (
                  <Link key={g.name} className="genre" style={{ '--g': GENRE_COLORS[i % GENRE_COLORS.length] }} to={`/albums?genre=${encodeURIComponent(g.name)}`}>
                    <span className="ellipsis">{g.name}</span>
                    <small>{g.songCount}</small>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {!data.recent?.length && !data.newest?.length && !data.random?.length && (
            <Empty title="Nothing here yet" action={<Link className="btn primary" to="/add">Add music</Link>}>
              {caps.files ? 'Your folder is empty or still being read. Check Activity in the top bar.' : 'Your server has no music yet.'}
            </Empty>
          )}
        </>
      )}
    </>
  );
}

export { GENRE_COLORS };
