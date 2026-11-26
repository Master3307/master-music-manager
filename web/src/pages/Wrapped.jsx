import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Download, Copy, Share2, Sparkles } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get } from '../lib/api.js';
import { Empty, Field, Segmented, Spinner } from '../components/ui.jsx';
import { PERIODS } from './Stats.jsx';

const CARDS = [
  { id: 'overview', label: 'The year in one' },
  { id: 'artists', label: 'Top artists' },
  { id: 'songs', label: 'Top songs' },
  { id: 'minutes', label: 'Minutes' },
  { id: 'personality', label: 'Listening type' },
  { id: 'genres', label: 'Top genres' },
];
const STYLES = {
  aurora: ['#1b0f3b', '#5b21b6', '#c084fc', '#fff'],
  sunset: ['#2b0d1a', '#be185d', '#fb923c', '#fff'],
  ocean: ['#04172b', '#0e7490', '#5eead4', '#fff'],
  mono: ['#0e0e10', '#26262b', '#e7e7ea', '#fff'],
};

function personality(s) {
  const h = s.peakHour;
  if (h >= 22 || h < 4) return ['Night owl', 'Your music comes alive after dark.'];
  if (h < 9) return ['Early bird', 'You start the day with a soundtrack.'];
  if (s.uniqueArtists > s.plays * 0.4) return ['Explorer', 'Always looking for something new.'];
  if (s.topArtists[0] && s.topArtists[0].plays > s.plays * 0.15) return ['Superfan', `${s.topArtists[0].name} owns your heart.`];
  return ['All-rounder', 'A bit of everything, all day long.'];
}

function draw(c, s, card, style, size, label, name) {
  const [W, H] = size === 'story' ? [1080, 1920] : [1080, 1080];
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const [bg, mid, hi, ink] = STYLES[style];
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, bg);
  grad.addColorStop(0.55, mid);
  grad.addColorStop(1, hi);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Rings like a record, top right.
  g.save();
  g.globalAlpha = 0.14;
  g.strokeStyle = ink;
  for (let r = 120; r < 900; r += 46) {
    g.lineWidth = r % 92 ? 3 : 8;
    g.beginPath();
    g.arc(W * 0.92, H * 0.08, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
  const F = (w, px) => `${w} ${px}px "Onest Variable", system-ui, sans-serif`;
  const pad = 90;
  let y = size === 'story' ? 260 : 170;
  g.fillStyle = ink;
  g.globalAlpha = 0.75;
  g.font = F(600, 38);
  g.fillText(`${name ? `${name}’s ` : ''}${label}`, pad, y);
  g.globalAlpha = 1;
  y += 40;
  const big = (text, px = 150) => {
    g.font = F(800, px);
    let t = String(text);
    while (g.measureText(t).width > W - pad * 2 && px > 60) {
      px -= 6;
      g.font = F(800, px);
    }
    y += px;
    g.fillText(t, pad, y);
    y += 20;
  };
  const line = (text, px = 44, w = 500, alpha = 1) => {
    g.font = F(w, px);
    g.globalAlpha = alpha;
    let t = String(text);
    while (g.measureText(t).width > W - pad * 2 && t.length > 4) t = `${t.slice(0, -2)}…`;
    y += px * 1.35;
    g.fillText(t, pad, y);
    g.globalAlpha = 1;
  };
  const list = (items, fmt) => {
    items.slice(0, 5).forEach((x, i) => {
      g.font = F(800, 64);
      g.globalAlpha = 0.5;
      y += 110;
      g.fillText(String(i + 1), pad, y);
      g.globalAlpha = 1;
      g.font = F(700, 56);
      let t = fmt(x)[0];
      while (g.measureText(t).width > W - pad * 2 - 110 && t.length > 4) t = `${t.slice(0, -2)}…`;
      g.fillText(t, pad + 100, y);
      g.font = F(500, 34);
      g.globalAlpha = 0.7;
      g.fillText(fmt(x)[1], pad + 100, y + 46);
      g.globalAlpha = 1;
    });
  };
  const mins = Math.round(s.seconds / 60);
  if (card === 'overview') {
    line('You listened for', 46, 500, 0.85);
    big(`${mins.toLocaleString()} min`, 140);
    y += 30;
    line('Top artist', 36, 600, 0.7);
    line(s.topArtists[0]?.name || '–', 64, 800);
    y += 20;
    line('Top song', 36, 600, 0.7);
    line(s.topTracks[0] ? `${s.topTracks[0].title}` : '–', 58, 800);
    line(s.topTracks[0]?.artist || '', 40, 500, 0.8);
    y += 20;
    line(`${s.uniqueArtists.toLocaleString()} artists · ${s.uniqueTracks.toLocaleString()} songs · ${s.streak.best}-day streak`, 36, 600, 0.85);
  } else if (card === 'artists') {
    big('Top artists', 110);
    list(s.topArtists, (x) => [x.name, `${x.plays} plays`]);
  } else if (card === 'songs') {
    big('Top songs', 110);
    list(s.topTracks, (x) => [x.title, `${x.artist} · ${x.plays} plays`]);
  } else if (card === 'genres') {
    big('Top genres', 110);
    list(s.topGenres.length ? s.topGenres : [{ name: 'Link a folder for genres', plays: 0 }], (x) => [x.name, x.plays ? `${x.plays} plays` : '']);
  } else if (card === 'minutes') {
    line('Minutes listened', 46, 600, 0.85);
    big(mins.toLocaleString(), 220);
    line(`That’s ${(mins / 60 / 24).toFixed(1)} days of music.`, 46, 600);
    y += 30;
    line(`Busiest day: ${s.busiestDay ? new Date(s.busiestDay.day).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '–'}`, 40, 500, 0.85);
    line(`with ${s.busiestDay?.plays || 0} songs`, 40, 500, 0.85);
  } else if (card === 'personality') {
    const [type, text] = personality(s);
    line('Your listening type', 46, 600, 0.85);
    big(type, 150);
    line(text, 46, 500);
    y += 30;
    line(`Favourite hour: ${String(s.peakHour).padStart(2, '0')}:00`, 42, 600, 0.85);
    line(`${s.discovered.length} new artists found`, 42, 600, 0.85);
  }
  g.font = F(600, 30);
  g.globalAlpha = 0.65;
  g.fillText('Master Music Manager', pad, H - 80);
  g.globalAlpha = 1;
}

export default function Wrapped() {
  const [params] = useSearchParams();
  const { pid, me } = useApp();
  const [period, setPeriod] = useState(params.get('period') || 'thisyear');
  const [card, setCard] = useState('overview');
  const [style, setStyle] = useState('aurora');
  const [size, setSize] = useState('story');
  const [name, setName] = useState(me?.user?.displayName || '');
  const { data: s, loading } = useLoad(() => get('stats/listening', { period, profile: pid, limit: 10 }), [period, pid]);
  const ref = useRef(null);
  const label = PERIODS.find((p) => p.value === period)?.label;
  useEffect(() => {
    if (s && ref.current) document.fonts.ready.then(() => draw(ref.current, s, card, style, size, period === 'thisyear' ? `${label} Wrapped` : `${label} Wrapped`, name));
  }, [s, card, style, size, name, period, label]);
  const blob = () => new Promise((r) => ref.current.toBlob(r, 'image/png'));
  const fileName = `wrapped-${card}-${period}.png`;
  if (loading && !s) return <Spinner />;
  if (s && !s.plays) return <Empty icon={Sparkles} title="No listens yet">Wrapped cards are made from your listening history. Import it under Stats → Scrobbles.</Empty>;
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Wrapped</h1>
          <p className="page-sub">Cards to post or send, made from your own listening.</p>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', gap: 24 }}>
        <div className="col" style={{ gap: 14 }}>
          <Field label="Time"><select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
          <Field label="Card">
            <div className="chips">{CARDS.map((c) => <button key={c.id} className={`chip ${card === c.id ? 'active' : ''}`} onClick={() => setCard(c.id)}>{c.label}</button>)}</div>
          </Field>
          <Field label="Colours">
            <div className="swatches">
              {Object.entries(STYLES).map(([k, v]) => <button key={k} className={`swatch ${style === k ? 'active' : ''}`} style={{ background: `linear-gradient(135deg, ${v[0]}, ${v[1]}, ${v[2]})` }} onClick={() => setStyle(k)} aria-label={k} />)}
            </div>
          </Field>
          <Field label="Shape"><Segmented value={size} onChange={setSize} options={[{ value: 'story', label: 'Story 9:16' }, { value: 'square', label: 'Square' }]} /></Field>
          <Field label="Your name on it (optional)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="row wrap">
            <button className="btn primary" onClick={async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(await blob()); a.download = fileName; a.click(); }}><Download /> Save</button>
            <button className="btn" onClick={async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': await blob() })]); }}><Copy /> Copy</button>
            {navigator.canShare && <button className="btn" onClick={async () => { const f = new File([await blob()], fileName, { type: 'image/png' }); if (navigator.canShare({ files: [f] })) navigator.share({ files: [f], title: 'My Wrapped' }); }}><Share2 /> Share</button>}
          </div>
        </div>
        <div className="wrapped-preview"><canvas ref={ref} /></div>
      </div>
    </>
  );
}
