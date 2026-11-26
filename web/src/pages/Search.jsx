import { Link, useSearchParams } from 'react-router';
import { Search as SearchIcon } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get } from '../lib/api.js';
import { SongList } from '../components/Songs.jsx';
import { AlbumTile } from './Home.jsx';
import { Cover, Empty, Spinner } from '../components/ui.jsx';

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const { pid } = useApp();
  const { data, loading, error } = useLoad(() => (q ? get(`p/${pid}/search`, { q }) : null), [pid, q]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">“{q}”</h1>
          <p className="page-sub">
            Looking for something specific? <Link to={`/library?q=${encodeURIComponent(q)}`}>Filter the whole library</Link> with fields like <span className="mono">artist:</span> or <span className="mono">year&gt;2010</span>.
          </p>
        </div>
      </div>
      {loading && <Spinner />}
      {error && <Empty icon={SearchIcon} title="Search didn’t work">{error.message}</Empty>}
      {data && !data.songs.length && !data.albums.length && !data.artists.length && <Empty icon={SearchIcon} title="Nothing found">Try fewer words, or check the spelling.</Empty>}
      {data?.artists?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Artists</h2></div>
          <div className="shelf">
            {data.artists.map((a) => (
              <Link key={a.id} className="tile" to={`/artist/${encodeURIComponent(a.id)}`}>
                <Cover pid={pid} id={a.coverArt || a.id} round />
                <span className="t ellipsis" style={{ textAlign: 'center' }}>{a.name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      {data?.albums?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Albums</h2></div>
          <div className="shelf">{data.albums.map((a) => <AlbumTile key={a.id} a={a} pid={pid} />)}</div>
        </section>
      )}
      {data?.songs?.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Songs</h2></div>
          <SongList songs={data.songs} />
        </section>
      )}
    </>
  );
}
