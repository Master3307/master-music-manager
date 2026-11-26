import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BarChart3, Sparkles, Flame, Clock, Disc3, Users, Music2, Upload } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get } from '../lib/api.js';
import { fmtLong, fmtTime, fmtSize, plural, date } from '../lib/util.js';
import { Empty, Notice, Spinner, Segmented } from '../components/ui.jsx';

export const PERIODS = [
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
  { value: 'quarter', label: '3 months' },
  { value: 'year', label: '12 months' },
  { value: 'thisyear', label: String(new Date().getFullYear()) },
  { value: 'all', label: 'All time' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Ranking({ items, render, max }) {
  const top = items[0]?.plays || 1;
  return (
    <div>
      {items.slice(0, max || 10).map((x, i) => (
        <div key={i} className="rank">
          <span className="p">{i + 1}</span>
          {render.cover ? render.cover(x) : <span />}
          <div style={{ minWidth: 0 }}>
            <div className="ellipsis"><b>{render.title(x)}</b>{render.sub && <span className="faint"> · {render.sub(x)}</span>}</div>
            <div className="bar"><i style={{ width: `${(x.plays / top) * 100}%` }} /></div>
          </div>
          <span className="faint tabular" style={{ fontSize: 12.5 }}>{x.plays} plays · {fmtLong(x.seconds)}</span>
        </div>
      ))}
    </div>
  );
}

function Timeline({ points }) {
  if (!points?.length) return null;
  const w = 800;
  const h = 120;
  const max = Math.max(...points.map((p) => p.plays), 1);
  const step = w / Math.max(1, points.length - 1);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - (p.plays / max) * (h - 8) - 4).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" preserveAspectRatio="none" role="img" aria-label="Listens per day">
      <defs>
        <linearGradient id="spark-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".35" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#spark-g)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Listening() {
  const { pid, settings } = useApp();
  const [period, setPeriod] = useState('year');
  const [user, setUser] = useState('');
  const users = useLoad(() => get('stats/users'), []);
  const { data: s, loading, error } = useLoad(() => get('stats/listening', { period, user, profile: pid }), [period, user, pid]);
  const nav = useNavigate();
  const heatMax = s ? Math.max(1, ...s.heatmap.flat()) : 1;
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Listening</h1>
          <p className="page-sub">From your listens: the Navidrome plugin, this app’s player and anything you imported.</p>
        </div>
        {(users.data || []).length > 1 && (
          <select className="select" style={{ width: 180 }} value={user} onChange={(e) => setUser(e.target.value)} aria-label="Whose listens">
            <option value="">Everyone</option>
            {users.data.filter((u) => u.username).map((u) => <option key={u.username} value={u.username}>{u.username}</option>)}
          </select>
        )}
        <Segmented value={period} onChange={setPeriod} options={PERIODS} />
      </div>
      {loading && !s && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {s && !s.plays && (
        <Empty icon={BarChart3} title="No listens in this time" action={<Link className="btn primary" to="/scrobbles"><Upload /> Import listens</Link>}>
          Install the Navidrome plugin (Settings → Navidrome plugin) to record every play, or import your history from Last.fm, ListenBrainz, Spotify or a file.
        </Empty>
      )}
      {s && s.plays > 0 && (
        <>
          <div className="kpis">
            <div className="kpi"><b>{s.plays.toLocaleString()}</b><span>listens{s.previousPlays ? ` · ${s.plays >= s.previousPlays ? '+' : ''}${Math.round(((s.plays - s.previousPlays) / s.previousPlays) * 100)}% vs. before` : ''}</span></div>
            <div className="kpi"><b>{fmtLong(s.seconds)}</b><span>of music</span></div>
            <div className="kpi"><b>{s.uniqueArtists.toLocaleString()}</b><span>artists</span></div>
            <div className="kpi"><b>{s.uniqueTracks.toLocaleString()}</b><span>different songs</span></div>
            <div className="kpi"><b>{s.streak.best} days</b><span>longest streak{s.streak.current ? ` · now ${s.streak.current}` : ''}</span></div>
            <div className="kpi"><b>{String(s.peakHour).padStart(2, '0')}:00</b><span>your favourite hour</span></div>
          </div>
          <section className="section">
            <div className="section-head"><h2>Every day</h2>{s.busiestDay && <span className="faint">busiest: {date(s.busiestDay.day)} with {s.busiestDay.plays}</span>}<Link className="more" to={`/wrapped?period=${period}`}><Sparkles size={14} /> Make a Wrapped card</Link></div>
            <div className="panel" style={{ padding: 10 }}><Timeline points={s.timeline} /></div>
          </section>
          <div className="fields two">
            <section className="section">
              <div className="section-head"><h2>Top artists</h2></div>
              <Ranking items={s.topArtists} render={{ title: (x) => <a href="#" onClick={(e) => { e.preventDefault(); nav(`/library?q=${encodeURIComponent(`artist:"${x.name}"`)}`); }}>{x.name}</a> }} />
            </section>
            <section className="section">
              <div className="section-head"><h2>Top songs</h2></div>
              <Ranking items={s.topTracks} render={{ title: (x) => x.title, sub: (x) => x.artist }} />
            </section>
            <section className="section">
              <div className="section-head"><h2>Top albums</h2></div>
              <Ranking items={s.topAlbums} render={{ title: (x) => x.name, sub: (x) => x.artist }} />
            </section>
            <section className="section">
              <div className="section-head"><h2>Top genres</h2></div>
              {s.topGenres.length ? <Ranking items={s.topGenres} render={{ title: (x) => x.name }} /> : <p className="faint">Genres come from your library’s tags; link a folder to see them.</p>}
            </section>
          </div>
          <section className="section">
            <div className="section-head"><h2>When you listen</h2></div>
            <div className="panel">
              <div className="heat">
                <span />
                {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ textAlign: 'center' }}>{h % 3 === 0 ? h : ''}</span>)}
                {s.heatmap.map((row, d) => [
                  <span key={`d${d}`}>{DAYS[d]}</span>,
                  ...row.map((v, h) => <i key={`${d}-${h}`} title={`${DAYS[d]} ${h}:00 · ${v} listens`} style={{ opacity: v ? 0.12 + (v / heatMax) * 0.88 : 0.05 }} />),
                ])}
              </div>
            </div>
          </section>
          {s.discovered.length > 0 && (
            <section className="section">
              <div className="section-head"><h2><Flame size={17} /> New to you</h2><span className="faint">artists you first played in this time</span></div>
              <div className="chips">{s.discovered.map((a) => <span key={a.name} className="chip">{a.name} · {a.plays}</span>)}</div>
            </section>
          )}
          <p className="faint" style={{ fontSize: 12.5, marginTop: 30 }}>
            Sources: {s.sources.map((x) => `${x.source} (${x.n})`).join(', ')}. Your first listen here: {s.firstListen ? `${s.firstListen.artist} – ${s.firstListen.title}, ${date(s.firstListen.ts)}` : '–'}.
          </p>
        </>
      )}
      {settings?.privacy?.fullLocal === false && null}
    </>
  );
}

export function LibraryStats() {
  const { pid, caps } = useApp();
  const { data: s, loading, error } = useLoad(() => (caps.files ? get(`stats/library/${pid}`) : null), [pid, caps.files]);
  if (!caps.files) return <Empty icon={Disc3} title="Needs the music folder">Library statistics are read from your files.</Empty>;
  const maxDec = s ? Math.max(1, ...s.decades.map((d) => d.tracks)) : 1;
  const maxAdd = s ? Math.max(1, ...s.addedPerMonth.map((d) => d.tracks)) : 1;
  return (
    <>
      <div className="page-head"><h1 className="page-title">Your library</h1></div>
      {loading && <Spinner />}
      {error && <Notice kind="danger">{error.message}</Notice>}
      {s && (
        <>
          <div className="kpis">
            <div className="kpi"><b>{s.tracks.toLocaleString()}</b><span>songs</span></div>
            <div className="kpi"><b>{s.artists.toLocaleString()}</b><span>artists</span></div>
            <div className="kpi"><b>{s.albums.toLocaleString()}</b><span>albums</span></div>
            <div className="kpi"><b>{fmtLong(s.duration)}</b><span>to listen through</span></div>
            <div className="kpi"><b>{fmtSize(s.size)}</b><span>on disk</span></div>
            <div className="kpi"><b>{Math.round((s.lossless / Math.max(1, s.tracks)) * 100)}%</b><span>lossless</span></div>
          </div>
          <div className="fields two">
            <section className="section">
              <div className="section-head"><h2><Users size={17} /> Most songs</h2></div>
              {s.artistsByTracks.slice(0, 15).map((a, i) => (
                <div key={a.name} className="rank">
                  <span className="p">{i + 1}</span><span />
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis"><Link to={`/library?q=${encodeURIComponent(`artist:"${a.name}"`)}`}><b>{a.name}</b></Link></div>
                    <div className="bar"><i style={{ width: `${(a.tracks / s.artistsByTracks[0].tracks) * 100}%` }} /></div>
                  </div>
                  <span className="faint" style={{ fontSize: 12.5 }}>{plural(a.tracks, 'song')} · {plural(a.albums, 'album')}</span>
                </div>
              ))}
            </section>
            <section className="section">
              <div className="section-head"><h2><Clock size={17} /> By decade</h2></div>
              {s.decades.map((d) => (
                <div key={d.decade} className="row" style={{ margin: '6px 0' }}>
                  <span className="tabular" style={{ width: 56 }}>{d.decade}s</span>
                  <div className="bar grow" style={{ marginTop: 0, height: 10 }}><i style={{ width: `${(d.tracks / maxDec) * 100}%` }} /></div>
                  <span className="faint tabular" style={{ width: 60, textAlign: 'right' }}>{d.tracks}</span>
                </div>
              ))}
              <div className="section-head" style={{ marginTop: 26 }}><h2><Music2 size={17} /> Formats</h2></div>
              <div className="chips">{Object.entries(s.formats).sort((a, b) => b[1] - a[1]).map(([k, n]) => <span key={k} className="chip">{k.toUpperCase()} · {n}</span>)}</div>
              <div className="chips" style={{ marginTop: 8 }}>{s.bitrates.filter((b) => b.count).map((b) => <span key={b.label} className="chip">{b.label} kbps · {b.count}</span>)}</div>
            </section>
          </div>
          <section className="section">
            <div className="section-head"><h2>Added over time</h2></div>
            <div className="panel" style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 140, padding: 12 }}>
              {s.addedPerMonth.map((m) => <div key={m.month} title={`${m.month}: ${m.tracks}`} style={{ flex: 1, minWidth: 3, height: `${(m.tracks / maxAdd) * 100}%`, background: 'var(--accent)', borderRadius: 3, opacity: 0.8 }} />)}
            </div>
          </section>
          <div className="fields two">
            {s.longest && <div className="kpi"><span>Longest song</span><b style={{ fontSize: 18 }}>{s.longest.title}</b><span>{s.longest.artist} · {fmtTime(s.longest.duration)}</span></div>}
            {s.shortest && <div className="kpi"><span>Shortest song</span><b style={{ fontSize: 18 }}>{s.shortest.title}</b><span>{s.shortest.artist} · {fmtTime(s.shortest.duration)}</span></div>}
          </div>
        </>
      )}
    </>
  );
}
