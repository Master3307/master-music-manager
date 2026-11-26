import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Shuffle, Share2, Pencil, Folder, Radio as RadioIcon, Plus, Trash2, Heart, Play, ExternalLink, Disc3, Music2 } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, del } from '../lib/api.js';
import { coverUrl, fmtLong, plural, cx } from '../lib/util.js';
import { Cover, Empty, Notice, Spinner, Stars, Modal, Field, Tabs, useConfirm } from '../components/ui.jsx';
import { SongList, PlayAll, ShareDialog } from '../components/Songs.jsx';
import { ExternalLinks } from './Artist.jsx';
import { AlbumTile, GENRE_COLORS } from './Home.jsx';
import { useMenus } from '../components/menus.jsx';

const SORTS = [
  ['alphabeticalByName', 'Name'],
  ['alphabeticalByArtist', 'Artist'],
  ['newest', 'Recently added'],
  ['recent', 'Recently played'],
  ['frequent', 'Most played'],
  ['byYear', 'Year'],
  ['starred', 'Favorites'],
  ['random', 'Random'],
];

export function Albums() {
  const { pid, caps } = useApp();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') || 'alphabeticalByName';
  const genre = params.get('genre') || '';
  const [items, setItems] = useState([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const load = async (reset) => {
    setLoading(true);
    try {
      const offset = reset ? 0 : items.length;
      const page = await get(`p/${pid}/albums`, { type, genre, size: 120, offset });
      setItems((x) => (reset ? page : [...x, ...page]));
      setDone(page.length < 120);
    } catch (e) {
      setError(e);
    }
    setLoading(false);
  };
  useEffect(() => {
    setItems([]);
    setDone(false);
    setError(null);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, type, genre]);
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">{genre || 'Albums'}</h1>
          {genre && <p className="page-sub"><Link to="/albums">All albums</Link></p>}
        </div>
        <select className="select" style={{ width: 200 }} value={type} onChange={(e) => setParams({ type: e.target.value, ...(genre ? { genre } : {}) })} aria-label="Sort">
          {SORTS.filter(([v]) => caps.service || !['recent', 'frequent', 'starred'].includes(v)).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>
      {error && <Notice kind="danger">{error.message}</Notice>}
      <div className="grid">{items.map((a) => <AlbumTile key={a.id} a={a} pid={pid} />)}</div>
      {!items.length && !loading && !error && <Empty icon={Disc3} title="No albums here" />}
      {loading && <div style={{ padding: 30 }}><Spinner /></div>}
      {!done && !loading && items.length > 0 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
          <button className="btn" onClick={() => load(false)}>Show more</button>
        </div>
      )}
    </>
  );
}

export function Album() {
  const { id } = useParams();
  const { pid, caps, fail, toast } = useApp();
  const nav = useNavigate();
  const p = usePlayer();
  const { data: a, loading, error } = useLoad(() => get(`p/${pid}/albums/${encodeURIComponent(id)}`), [pid, id]);
  const [share, setShare] = useState(false);
  const [rating, setRating] = useState(0);
  const [starred, setStarred] = useState(false);
  useEffect(() => {
    setRating(a?.rating || 0);
    setStarred(Boolean(a?.starred));
  }, [a]);
  if (loading && !a) return <Spinner />;
  if (error) return <Notice kind="danger">{error.message}</Notice>;
  if (!a) return null;
  const songs = a.songs || [];
  const total = songs.reduce((x, s) => x + (s.duration || 0), 0);
  const localIds = songs.map((s) => s.localId || (String(s.id).startsWith('l:') ? String(s.id).slice(2) : null)).filter(Boolean);
  return (
    <>
      <header className="hero">
        <div className="hero-bg" style={{ backgroundImage: a.coverArt ? `url(${coverUrl(pid, a.coverArt, 300)})` : undefined }} />
        <Cover pid={pid} id={a.coverArt} size={600} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="kind">{a.releaseTypes?.[0] || (songs.length < 4 ? 'Single' : 'Album')}</div>
          <h1>{a.name}</h1>
          <div className="facts">
            {a.artistId ? <Link to={`/artist/${encodeURIComponent(a.artistId)}`}>{a.artist}</Link> : <b>{a.artist}</b>}
            {a.year ? <span>{a.year}</span> : null}
            <span>{plural(songs.length, 'song')}, {fmtLong(total)}</span>
            {a.genres?.length ? <span>{a.genres.join(', ')}</span> : null}
            {a.recordLabels?.length ? <span>{a.recordLabels.join(', ')}</span> : null}
          </div>
          <div className="hero-actions">
            <PlayAll songs={songs} pid={pid} />
            <button className="btn icon" onClick={() => p.playList([...songs].sort(() => Math.random() - 0.5), 0, pid)} aria-label="Shuffle"><Shuffle /></button>
            <button className="btn icon" onClick={() => setShare(true)} aria-label="Share"><Share2 /></button>
            {caps.files && localIds.length > 0 && (
              <button className="btn" onClick={() => nav(`/library?q=${encodeURIComponent(`album:"${a.name}"`)}&edit=all`)}><Pencil /> Edit</button>
            )}
            <span className="spacer" />
            {caps.ratings && !String(a.id).startsWith('la:') && (
              <Stars value={rating} onChange={(v) => { setRating(v); post(`p/${pid}/rate`, { id: a.id, rating: v }).catch(fail); }} />
            )}
            {caps.favorites && !String(a.id).startsWith('la:') && (
              <button className={cx('btn icon ghost', starred && 'on')} onClick={() => { setStarred(!starred); post(`p/${pid}/star`, { ids: [a.id], type: 'album', on: !starred }).then(() => toast(starred ? 'Removed from favorites' : 'Added to favorites'), fail); }} aria-label="Favorite">
                <Heart fill={starred ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
        </div>
      </header>
      <section className="section" style={{ marginTop: 18 }}>
        <SongList songs={songs} pid={pid} showAlbum={false} showCover={false} onEdit={caps.files ? (ids) => nav(`/library?ids=${ids.join(',')}&edit=all`) : undefined} />
      </section>
      <section className="section">
        <ExternalLinks kind="album" name={a.name} artist={a.artist} mbid={a.musicBrainzId} />
      </section>
      {a.info?.notes && (
        <section className="section">
          <div className="section-head"><h2>About this album</h2></div>
          <div className="prose" dangerouslySetInnerHTML={{ __html: sanitize(a.info.notes) }} />
        </section>
      )}
      {share && <ShareDialog kind="album" refData={{ id: a.id }} title={a.name} pid={pid} onClose={() => setShare(false)} />}
    </>
  );
}

/** Service bios contain links; keep only plain text and <a href>. */
export function sanitize(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html || '');
  for (const el of d.querySelectorAll('*')) {
    if (el.tagName !== 'A') el.replaceWith(...el.childNodes);
    else {
      const href = el.getAttribute('href') || '';
      [...el.attributes].forEach((x) => el.removeAttribute(x.name));
      if (/^https?:/.test(href)) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
  return d.innerHTML;
}

export function Artists() {
  const { pid } = useApp();
  const menus = useMenus();
  const { data, loading, error } = useLoad(() => get(`p/${pid}/artists`), [pid]);
  const [filter, setFilter] = useState('');
  const list = useMemo(() => (data || []).filter((a) => !filter || a.name.toLowerCase().includes(filter.toLowerCase())), [data, filter]);
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Artists</h1>
          {data && <p className="page-sub">{plural(data.length, 'artist')}</p>}
        </div>
        <input className="input" style={{ width: 240 }} placeholder="Filter artists" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {loading && !data && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      <div className="grid">
        {list.slice(0, 600).map((a) => (
          <Link key={a.id} className="tile" to={`/artist/${encodeURIComponent(a.id)}`} style={{ alignItems: 'center', textAlign: 'center' }} onContextMenu={(e) => menus.artist(e, a)}>
            <Cover pid={pid} id={a.coverArt} round style={{ width: '100%' }} icon={Music2} />
            <span className="t ellipsis" style={{ maxWidth: '100%' }}>{a.name}</span>
            <span className="s">{[a.albumCount ? plural(a.albumCount, 'album') : '', a.songCount ? plural(a.songCount, 'song') : ''].filter(Boolean).join(', ')}</span>
          </Link>
        ))}
      </div>
      {list.length > 600 && <p className="faint" style={{ textAlign: 'center' }}>Showing 600 of {list.length}. Type to narrow it down.</p>}
    </>
  );
}

export function Genres() {
  const { pid } = useApp();
  const menus = useMenus();
  const { data, loading } = useLoad(() => get(`p/${pid}/genres`), [pid]);
  return (
    <>
      <div className="page-head"><h1 className="page-title">Genres</h1></div>
      {loading && !data && <Spinner />}
      <div className="genre-grid">
        {(data || []).map((g, i) => (
          <Link key={g.name} className="genre" style={{ '--g': GENRE_COLORS[i % GENRE_COLORS.length] }} to={`/albums?genre=${encodeURIComponent(g.name)}`} onContextMenu={(e) => menus.genre(e, g)}>
            <span className="ellipsis">{g.name}</span>
            <small>{g.songCount}</small>
          </Link>
        ))}
      </div>
    </>
  );
}

export function Folders() {
  const { pid } = useApp();
  const [stack, setStack] = useState([{ id: null, name: 'Library' }]);
  const cur = stack.at(-1);
  const { data, loading, error } = useLoad(() => get(`p/${pid}/directory`, { id: cur.id }), [pid, cur.id]);
  const dirs = (data?.children || []).filter((c) => c.isDir);
  const songs = (data?.children || []).filter((c) => !c.isDir);
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">{cur.name}</h1>
          <p className="page-sub">
            {stack.map((s, i) => (
              <span key={i}>
                {i > 0 && ' / '}
                <a href="#" onClick={(e) => { e.preventDefault(); setStack(stack.slice(0, i + 1)); }}>{s.name}</a>
              </span>
            ))}
          </p>
        </div>
        {songs.length > 0 && <PlayAll songs={songs} pid={pid} />}
      </div>
      {loading && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      <div className="genre-grid">
        {dirs.map((d) => (
          <button key={d.id} className="genre" style={{ cursor: 'pointer', textAlign: 'left', '--g': 'var(--text-3)' }} onClick={() => setStack([...stack, { id: d.id, name: d.title }])}>
            <Folder size={16} style={{ marginRight: 10 }} />
            <span className="ellipsis">{d.title}</span>
          </button>
        ))}
      </div>
      {songs.length > 0 && <div className="section"><SongList songs={songs} pid={pid} /></div>}
    </>
  );
}

export function Favorites() {
  const { pid } = useApp();
  const [tab, setTab] = useState('songs');
  const { data, loading, error } = useLoad(() => get(`p/${pid}/starred`), [pid]);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title grow">Favorites</h1>
        {data?.songs?.length > 0 && <PlayAll songs={data.songs} pid={pid} />}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'songs', label: 'Songs', count: data?.songs?.length }, { id: 'albums', label: 'Albums', count: data?.albums?.length }, { id: 'artists', label: 'Artists', count: data?.artists?.length }]} />
      {loading && !data && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {tab === 'songs' && data && (data.songs.length ? <SongList songs={data.songs} pid={pid} /> : <Empty icon={Heart} title="No favorite songs yet">Tap the heart in the player or a song’s menu.</Empty>)}
      {tab === 'albums' && data && <div className="grid">{data.albums.map((a) => <AlbumTile key={a.id} a={a} pid={pid} />)}</div>}
      {tab === 'artists' && data && (
        <div className="grid">
          {data.artists.map((a) => (
            <Link key={a.id} className="tile" to={`/artist/${encodeURIComponent(a.id)}`} style={{ alignItems: 'center' }}>
              <Cover pid={pid} id={a.coverArt} round style={{ width: '100%' }} />
              <span className="t">{a.name}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function Radio() {
  const { pid, fail, toast } = useApp();
  const p = usePlayer();
  const confirm = useConfirm();
  const { data: raw, loading, error, reload } = useLoad(() => get(`p/${pid}/radios`), [pid]);
  const data = raw?.stations;
  const [edit, setEdit] = useState(null);
  const { caps, profiles } = useApp();
  const copyFrom = async (direction) => {
    try {
      const r = await post(`p/${pid}/radios/copy`, { direction });
      toast(`${r.copied} stations copied`);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const [share, setShare] = useState(null);
  const save = async () => {
    try {
      await post(`p/${pid}/radios`, edit);
      toast(edit.id ? 'Station saved' : 'Station added');
      setEdit(null);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Radio</h1>
          <p className="page-sub">Internet radio. Stations are kept on your server{raw?.canSaveOnServer ? '' : ' or here in the app'}, and can be shared like anything else.</p>
        </div>
        {raw?.canSaveOnServer && <button className="btn" onClick={() => copyFrom('fromServer')}>Keep a copy here</button>}
        {raw?.canSaveOnServer && data?.some((x) => x.local) && <button className="btn" onClick={() => copyFrom('toServer')}>Put mine on the server</button>}
        <button className="btn primary" onClick={() => setEdit({ name: '', streamUrl: '', homepageUrl: '' })}><Plus /> Add a station</button>
      </div>
      {loading && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {raw?.error && <Notice kind="warn">The server’s stations can’t be loaded: {raw.error}</Notice>}
      {data && !data.length && <Empty icon={RadioIcon} title="No stations yet">Add one with its stream address (often ends in .mp3, .aac or .m3u8).</Empty>}
      <div className="col" style={{ gap: 6 }}>
        {(data || []).map((r) => (
          <div key={r.id} className="panel row" style={{ padding: '10px 14px' }}>
            <button className="btn icon" onClick={() => p.playList([{ id: `radio:${r.id}`, title: r.name, artist: 'Internet radio', radio: r.streamUrl }], 0, pid)} aria-label={`Play ${r.name}`}><Play fill="currentColor" /></button>
            <div className="grow" style={{ minWidth: 0 }}>
              <b>{r.name}</b> {r.local && <span className="badge">in this app</span>}
              <div className="faint mono ellipsis" style={{ fontSize: 12 }}>{r.streamUrl}</div>
            </div>
            {r.homepageUrl && <a className="btn icon ghost" href={r.homepageUrl} target="_blank" rel="noopener noreferrer" aria-label="Website"><ExternalLink /></a>}
            <button className="btn icon ghost" onClick={() => setShare(r)} aria-label="Share"><Share2 /></button>
            <button className="btn icon ghost" onClick={() => setEdit(r)} aria-label="Edit"><Pencil /></button>
            <button className="btn icon ghost danger" onClick={async () => { if (await confirm({ title: `Remove ${r.name}?`, danger: true, confirm: 'Remove' })) del(`p/${pid}/radios/${r.id}`).then(reload, fail); }} aria-label="Remove"><Trash2 /></button>
          </div>
        ))}
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit station' : 'Add a station'} onClose={() => setEdit(null)} footer={<><button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save} disabled={!edit.name || !edit.streamUrl}>Save</button></>}>
          <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field>
          <Field label="Stream address"><input className="input mono" value={edit.streamUrl} onChange={(e) => setEdit({ ...edit, streamUrl: e.target.value })} placeholder="https://…/stream.mp3" /></Field>
          <Field label="Website (optional)"><input className="input mono" value={edit.homepageUrl || ''} onChange={(e) => setEdit({ ...edit, homepageUrl: e.target.value })} /></Field>
        </Modal>
      )}
      {share && <ShareDialog kind="radio" refData={{ name: share.name, streamUrl: share.streamUrl, homepageUrl: share.homepageUrl }} title={share.name} pid={pid} onClose={() => setShare(null)} />}
    </>
  );
}
