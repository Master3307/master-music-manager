import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Shuffle, Share2, Pencil, Heart, Radio as RadioIcon, ListMusic, ImagePlus, Check } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, put, api } from '../lib/api.js';
import { coverUrl, plural, cx } from '../lib/util.js';
import { Cover, Notice, Spinner, Stars, Modal, Field, Empty } from '../components/ui.jsx';
import { SongList, PlayAll, ShareDialog } from '../components/Songs.jsx';
import { ImageEditor } from '../components/ImageEditor.jsx';
import { AlbumTile } from './Home.jsx';
import { sanitize } from './Browse.jsx';

const LINK_STYLE = {
  lastfm: ['#d51007', 'fm'], musicbrainz: ['#ba478f', 'MB'], listenbrainz: ['#353070', 'LB'], spotify: ['#1db954', 'S'], ytmusic: ['#ff0033', '▶'], youtube: ['#ff0033', '▶'],
  discogs: ['#333', 'D'], genius: ['#e8c400', 'G'], wikipedia: ['#636466', 'W'], wikidata: ['#990000', 'Wd'], bandcamp: ['#1da0c3', 'bc'], soundcloud: ['#ff5500', 'sc'],
  apple: ['#fa2d48', ''], deezer: ['#a238ff', 'dz'], tidal: ['#000', 'T'], instagram: ['#c13584', 'ig'], x: ['#000', 'X'], allmusic: ['#0d6ad1', 'am'], rym: ['#2b6bd6', 'RYM'],
};

/** External links, found automatically (exact pages when MusicBrainz knows them, otherwise searches). */
export function ExternalLinks({ kind, name, artist, title, mbid, extra = [] }) {
  const { data } = useLoad(() => (name || title ? get(`links/${kind}`, { name, artist, title, mbid }) : null), [kind, name, artist, title, mbid]);
  const links = [...extra, ...(data?.links || [])].filter((l, i, a) => a.findIndex((x) => x.url === l.url) === i);
  if (!links.length) return null;
  return (
    <div>
      <div className="section-head"><h2 style={{ fontSize: 15 }}>Elsewhere</h2></div>
      <div className="links">
        {links.map((l) => {
          const [bg, txt] = LINK_STYLE[l.id] || ['var(--surface-2)', (l.label || '?')[0]];
          return (
            <a key={l.url} className={cx('link-chip', l.search && 'search')} href={l.url} target="_blank" rel="noopener noreferrer" title={l.search ? `Search on ${l.label}` : l.label}>
              <span className="lg" style={{ background: bg }}>{txt}</span>
              {l.label}
            </a>
          );
        })}
      </div>
      {data?.about?.tags?.length > 0 && (
        <div className="chips" style={{ marginTop: 10 }}>
          {data.about.tags.map((t) => <span key={t} className="badge">{t}</span>)}
        </div>
      )}
    </div>
  );
}

export default function Artist() {
  const { id } = useParams();
  const { pid, caps, fail, toast } = useApp();
  const nav = useNavigate();
  const p = usePlayer();
  const { data: a, loading, error, reload } = useLoad(() => get(`p/${pid}/artists/${encodeURIComponent(id)}`), [pid, id]);
  const info = useLoad(() => (a?.name ? get(`p/${pid}/artist-info`, { name: a.name }) : null), [pid, a?.name]);
  const [edit, setEdit] = useState(false);
  const [share, setShare] = useState(false);
  const [img, setImg] = useState(false);
  const [imgVersion, setImgVersion] = useState(0);
  const [rating, setRating] = useState(0);
  const [starred, setStarred] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setRating(a?.rating || 0);
    setStarred(Boolean(a?.starred));
  }, [a]);
  if (loading && !a) return <Spinner />;
  if (error) return <Notice kind="danger">{error.message}</Notice>;
  if (!a) return null;
  const isLocal = String(a.id).startsWith('lr:');
  const songCount = (a.albums || []).reduce((x, al) => x + (al.songCount || 0), 0) || info.data?.localTracks;
  const picture = `/api/p/${pid}/image/artist/${encodeURIComponent(a.id)}?cover=${encodeURIComponent(a.coverArt || '')}&v=${imgVersion}`;
  const about = info.data?.about || a.info?.biography;
  const startRadio = async () => {
    try {
      const songs = isLocal ? a.top : await get(`p/${pid}/similar/${encodeURIComponent(a.top?.[0]?.id || a.albums?.[0]?.songs?.[0]?.id || a.id)}`);
      p.playList(songs.length ? songs : a.top, 0, pid);
    } catch (e) {
      fail(e);
    }
  };
  const playAll = async () => {
    if (isLocal) return a.top || [];
    const all = [];
    for (const al of a.albums || []) {
      const full = await get(`p/${pid}/albums/${encodeURIComponent(al.id)}`).catch(() => null);
      if (full) all.push(...full.songs);
    }
    return all;
  };
  return (
    <>
      <header className="hero">
        <div className="hero-bg" style={{ backgroundImage: `url(${picture})` }} />
        <div style={{ position: 'relative' }}>
          <Cover src={picture} round style={{ width: 220 }} />
          <button className="btn icon small" style={{ position: 'absolute', right: 10, bottom: 10 }} onClick={() => setImg(true)} aria-label="Change the picture" title="Change the picture (GIFs stay animated)">
            <ImagePlus />
          </button>
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="kind">{a.roles?.includes('albumartist') || a.albums?.length ? 'Album artist' : 'Artist'}</div>
          <h1>{a.name}</h1>
          <div className="facts">
            {a.albums?.length ? <span>{plural(a.albums.length, 'album')}</span> : null}
            {(a.songCount || songCount) ? <span>· {plural(a.songCount || songCount, 'song')}</span> : null}
            {info.data?.localTracks && caps.service ? <span className="faint">· {info.data.localTracks} files in your folder</span> : null}
          </div>
          <div className="hero-actions">
            <button className="btn round-play" onClick={async () => p.playList(await playAll(), 0, pid)} aria-label="Play everything"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor" /></svg></button>
            <button className="btn icon" onClick={async () => p.playList((await playAll()).sort(() => Math.random() - 0.5), 0, pid)} aria-label="Shuffle"><Shuffle /></button>
            <button className="btn icon" onClick={startRadio} aria-label="Artist radio" title="Artist radio: similar songs"><RadioIcon /></button>
            <button className="btn icon" onClick={() => setShare(true)} aria-label="Share"><Share2 /></button>
            <button className="btn" onClick={() => setEdit(true)}><Pencil /> Edit</button>
            <span className="spacer" />
            {caps.ratings && !isLocal && <Stars value={rating} onChange={(v) => { setRating(v); post(`p/${pid}/rate`, { id: a.id, rating: v }).catch(fail); }} />}
            {caps.favorites && !isLocal && (
              <button className={cx('btn icon ghost', starred && 'on')} onClick={() => { setStarred(!starred); post(`p/${pid}/star`, { ids: [a.id], type: 'artist', on: !starred }).then(() => toast(starred ? 'Removed from favorites' : 'Added to favorites'), fail); }} aria-label="Favorite">
                <Heart fill={starred ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="row wrap" style={{ gap: 4, marginTop: 14 }}>
        <Link className="btn ghost small" to={`/library?q=${encodeURIComponent(`artist:"${a.name}" OR albumartist:"${a.name}"`)}`}><ListMusic /> All songs in the library</Link>
        <button className="btn ghost small" onClick={startRadio}><RadioIcon /> Artist radio</button>
      </div>

      <section className="section" style={{ marginTop: 22 }}>
        <ExternalLinks kind="artist" name={a.name} mbid={info.data?.mbid || info.data?.mbidFromTags || a.musicBrainzId} extra={(info.data?.links || []).map((l) => ({ id: 'own', label: l.label || 'Link', url: l.url }))} />
      </section>

      {(about || caps.files) && (
        <section className="section">
          <div className="section-head">
            <h2>About {a.name}</h2>
            <button className="more btn small ghost" onClick={() => setEdit(true)}><Pencil /> {about ? 'Edit' : 'Write something'}</button>
          </div>
          {about ? <div className="prose" dangerouslySetInnerHTML={{ __html: sanitize(about) }} /> : <p className="faint">Nothing written yet.</p>}
        </section>
      )}

      {a.top?.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{isLocal ? 'Songs' : 'Popular'}</h2>
            {isLocal && a.top.length > 10 && <span className="faint">{a.top.length} in total, most played first</span>}
          </div>
          <SongList songs={showAll ? a.top : a.top.slice(0, 10)} pid={pid} numbered="index" />
          {a.top.length > 10 && <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${a.top.length}`}</button>}
        </section>
      )}

      <section className="section">
        <div className="section-head"><h2>Discography</h2></div>
        {a.albums?.length ? <div className="grid">{a.albums.map((al) => <AlbumTile key={al.id} a={al} pid={pid} />)}</div> : <Empty>No albums.</Empty>}
      </section>

      {a.appearsOn?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Appears on</h2><span className="faint">albums by others with {a.name} on them</span></div>
          <div className="grid">{a.appearsOn.map((al) => <AlbumTile key={al.id} a={al} pid={pid} />)}</div>
        </section>
      )}

      {a.info?.similarArtist?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Similar artists</h2></div>
          <div className="shelf">
            {a.info.similarArtist.map((s) => (
              <Link key={s.id} className="tile" to={`/artist/${encodeURIComponent(s.id)}`} style={{ alignItems: 'center' }}>
                <Cover pid={pid} id={s.coverArt || `ar-${s.id}`} round style={{ width: '100%' }} />
                <span className="t ellipsis">{s.name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {edit && <ArtistEditor artist={a} info={info.data} onClose={() => setEdit(false)} onSaved={() => { info.reload(); reload(); }} />}
      {share && <ShareDialog kind="artist" refData={{ id: a.id }} title={a.name} pid={pid} onClose={() => setShare(false)} />}
      {img && (
        <ImageEditor
          title={`Picture of ${a.name}`}
          allowAnimated
          onClose={() => setImg(false)}
          onSave={async (blob) => {
            const r = await api(`p/${pid}/image/artist/${encodeURIComponent(a.id)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type } });
            toast(r.synced ? 'Picture saved, also on the server' : r.note || 'Picture saved');
            setImg(false);
            setImgVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}

function ArtistEditor({ artist, info, onClose, onSaved }) {
  const { pid, caps, fail, toast, afterJob } = useApp();
  const [f, setF] = useState({ name: artist.name, about: info?.about || '', sortName: info?.sortName || '', mbid: info?.mbid || info?.mbidFromTags || '', links: info?.links || [] });
  const [rename, setRename] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(`p/${pid}/artist-info`, { name: artist.name, about: f.about, sortName: f.sortName, mbid: f.mbid, links: f.links });
      if (f.name !== artist.name && caps.files) {
        const r = await post(`p/${pid}/artist-rename`, { from: artist.name, to: f.name });
        toast(`Renaming in ${r.job ? 'every file' : 'the library'}…`);
        afterJob(r.job).then(onSaved);
      } else toast('Saved');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const preview = async (name) => {
    if (name === artist.name || !caps.files) return setRename(null);
    setRename(await post(`p/${pid}/artist-rename`, { from: artist.name, to: name, preview: true }).catch(() => null));
  };
  return (
    <Modal title={`Edit ${artist.name}`} size="wide" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Check /> Save</button></>}>
      <div className="fields two">
        <Field label="Name" hint={caps.files ? 'Changing it renames the artist in every file (and moves them if the folder layout uses the artist).' : 'Renaming needs the linked music folder.'}>
          <input className="input" value={f.name} disabled={!caps.files} onChange={(e) => setF({ ...f, name: e.target.value })} onBlur={(e) => preview(e.target.value)} />
        </Field>
        <Field label="Sort as" hint="e.g. “Beatles, The”">
          <input className="input" value={f.sortName} onChange={(e) => setF({ ...f, sortName: e.target.value })} />
        </Field>
      </div>
      {rename && <Notice kind="warn">This changes {plural(rename.count, 'file')}.</Notice>}
      <Field label="About" hint={caps.plugin ? 'With the Navidrome plugin installed, Navidrome shows this text too.' : 'Shown here and on share pages.'}>
        <textarea className="textarea" rows={8} value={f.about} onChange={(e) => setF({ ...f, about: e.target.value })} placeholder="Who they are, where they’re from, what to listen to first…" />
      </Field>
      <Field label="MusicBrainz artist ID" hint="Makes the links exact. Found in the artist’s MusicBrainz address.">
        <input className="input mono" value={f.mbid} onChange={(e) => setF({ ...f, mbid: e.target.value.trim() })} placeholder="e.g. 056e4f3e-d505-4dad-8ec1-d04f521cbb56" />
      </Field>
      <div className="field">
        <span className="label">Your own links</span>
        {f.links.map((l, i) => (
          <div key={i} className="row">
            <input className="input" style={{ width: 160 }} value={l.label} placeholder="Label" onChange={(e) => setF({ ...f, links: f.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <input className="input mono" value={l.url} placeholder="https://" onChange={(e) => setF({ ...f, links: f.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
            <button className="btn icon ghost" onClick={() => setF({ ...f, links: f.links.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
          </div>
        ))}
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, links: [...f.links, { label: '', url: '' }] })}>Add a link</button>
      </div>
    </Modal>
  );
}

export { coverUrl };
