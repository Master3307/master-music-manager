import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import {
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, Volume1, VolumeX, Heart, Maximize2, Minimize2, SlidersHorizontal, X, Trash2, GripVertical,
  Wifi, HardDrive, Network, Moon, Bookmark, Gauge, Ban, Timer, Music2, ListMusic,
} from 'lucide-react';
import { usePlayer, EQ_FREQS, EQ_PRESETS } from '../lib/player.jsx';
import { useApp } from '../lib/app.jsx';
import { get, post } from '../lib/api.js';
import { fmtTime, cx, coverUrl } from '../lib/util.js';
import { CanvasCover, Cover, Range, Modal, Toggle, Segmented, Field, Empty } from './ui.jsx';
import { useMenus } from './menus.jsx';

function VolumeIcon({ v, muted }) {
  if (muted || v === 0) return <VolumeX />;
  return v < 0.5 ? <Volume1 /> : <Volume2 />;
}

export function Transport({ compact }) {
  const p = usePlayer();
  const [drag, setDrag] = useState(null);
  const d = p.duration || p.current?.duration || 0;
  return (
    <div className="transport">
      {!compact && (
        <div className="seek">
          <span>{fmtTime(drag ?? p.time)}</span>
          <Range value={drag ?? p.time} max={d} onChange={setDrag} onCommit={(v) => { p.seek(v); setDrag(null); }} label="Position" />
          <span>{fmtTime(d)}</span>
        </div>
      )}
      <div className="ctl">
        <button className={cx('btn icon', p.shuffle && 'on')} onClick={() => p.setShuffle(!p.shuffle)} aria-label="Shuffle" title={p.extras.trueShuffle ? 'True shuffle' : 'Shuffle'}>
          <Shuffle />
        </button>
        <button className="btn icon" onClick={p.prev} aria-label="Previous">
          <SkipBack fill="currentColor" />
        </button>
        <button className="btn icon play" onClick={p.toggle} aria-label={p.playing ? 'Pause' : 'Play'} disabled={!p.current}>
          {p.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <button className="btn icon" onClick={p.next} aria-label="Next">
          <SkipForward fill="currentColor" />
        </button>
        <button className={cx('btn icon', p.repeat !== 'off' && 'on')} onClick={() => p.setRepeat(p.repeat === 'off' ? 'all' : p.repeat === 'all' ? 'one' : 'off')} aria-label={`Repeat: ${p.repeat}`}>
          {p.repeat === 'one' ? <Repeat1 /> : <Repeat />}
        </button>
      </div>
    </div>
  );
}

function Volume() {
  const p = usePlayer();
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !p.extras.wheelVolume) return;
    const w = (e) => {
      e.preventDefault();
      p.setVolume(Math.min(1, Math.max(0, p.volume - Math.sign(e.deltaY) * 0.05)));
    };
    el.addEventListener('wheel', w, { passive: false });
    return () => el.removeEventListener('wheel', w);
  }, [p]);
  return (
    <div className="vol-row" ref={ref} title={`Volume ${Math.round(p.volume * 100)}%`}>
      <button className="btn icon small ghost" onClick={() => p.setMuted(!p.muted)} aria-label={p.muted ? 'Unmute' : 'Mute'}>
        <VolumeIcon v={p.volume} muted={p.muted} />
      </button>
      <Range value={p.muted ? 0 : p.volume} max={1} onChange={(v) => { p.setVolume(v); if (p.muted) p.setMuted(false); }} label="Volume" />
      <span className="faint tabular" style={{ fontSize: 11.5, width: 30, textAlign: 'right' }}>{Math.round((p.muted ? 0 : p.volume) * 100)}</span>
    </div>
  );
}

function SourceLine() {
  const p = usePlayer();
  const { profiles } = useApp();
  const prof = profiles.find((x) => x.id === p.current?.pid);
  const [src, setSrc] = useState(null);
  useEffect(() => {
    // Ask which copy actually plays (service, local file, another instance).
    if (!p.audio || !p.current) return;
    const check = () => setSrc(prof?.features?.service && prof?.status?.online ? 'service' : 'local');
    check();
  }, [p.current, prof, p.audio]);
  if (!p.current) return null;
  const I = src === 'service' ? Wifi : src === 'node' ? Network : HardDrive;
  return (
    <div className="deck-src">
      <I /> {src === 'service' ? `Streaming from ${prof?.name}` : `Playing the local file${prof ? ` · ${prof.name}` : ''}`}
      {p.extras.rate !== 1 && <span className="badge">{p.extras.rate}×</span>}
      {p.extras.sleepAt && <span className="badge"><Moon size={11} /> {Math.max(1, Math.round((p.extras.sleepAt - Date.now()) / 60000))} min</span>}
    </div>
  );
}

function HeartButton() {
  const p = usePlayer();
  const { profiles, fail } = useApp();
  const cur = p.current;
  const prof = profiles.find((x) => x.id === cur?.pid);
  const [on, setOn] = useState(Boolean(cur?.starred));
  useEffect(() => setOn(Boolean(cur?.starred)), [cur]);
  if (!cur || !prof?.features?.favorites) return null;
  const remote = String(cur.id).startsWith('l:') ? null : cur.id;
  if (!remote) return null;
  return (
    <button
      className={cx('btn icon ghost', on && 'on')}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={async () => {
        setOn(!on);
        try {
          await post(`p/${cur.pid}/star`, { ids: [remote], on: !on });
        } catch (e) {
          setOn(on);
          fail(e);
        }
      }}
    >
      <Heart fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

// ---- lyrics ----
export function useLyrics(cur) {
  const [lyr, setLyr] = useState(null);
  useEffect(() => {
    setLyr(null);
    if (!cur) return;
    const key = cur.localId ? `l:${cur.localId}` : cur.id;
    get(`p/${cur.pid}/lyrics/${encodeURIComponent(key)}`)
      .then((list) => setLyr(list.find((l) => l.synced) || list[0] || { lines: [] }))
      .catch(() => setLyr({ lines: [] }));
  }, [cur]);
  return lyr;
}

export function LyricsView({ big }) {
  const p = usePlayer();
  const lyr = useLyrics(p.current);
  const [offset, setOffset] = useState(0);
  const box = useRef(null);
  const ms = p.time * 1000 + offset + (lyr?.offset || 0);
  const synced = lyr?.synced;
  const lines = lyr?.lines || [];
  const nowIdx = synced ? lines.findLastIndex((l) => (l.start ?? 0) <= ms) : -1;
  useEffect(() => {
    const el = box.current?.querySelector('p.now');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [nowIdx]);
  if (!p.current) return <Empty icon={Music2}>Play a song to see its lyrics here.</Empty>;
  if (!lyr) return <div className="deck-idle"><span className="spinner" /></div>;
  if (!lines.length) return <Empty icon={Music2} title="No lyrics yet">Add them in the song’s editor (Lyrics tab), or look them up there with one click.</Empty>;
  return (
    <div className={cx(big ? 'lyrics-view' : 'deck-lyrics', !synced && 'plain')} ref={box}>
      {synced && (
        <div className="row" style={{ position: 'sticky', top: 0, justifyContent: 'flex-end', marginBottom: 8 }}>
          <span className="faint" style={{ fontSize: 12 }}>Delay</span>
          <button className="btn small ghost" onClick={() => setOffset((o) => o - 250)} aria-label="Earlier">−</button>
          <span className="tabular faint" style={{ fontSize: 12, width: 52, textAlign: 'center' }}>{offset > 0 ? '+' : ''}{(offset / 1000).toFixed(2)} s</span>
          <button className="btn small ghost" onClick={() => setOffset((o) => o + 250)} aria-label="Later">+</button>
        </div>
      )}
      {lines.map((l, i) => (
        <p key={i} className={cx(synced && (i === nowIdx ? 'now' : i < nowIdx ? 'past' : ''))} onClick={() => synced && l.start != null && p.seek(l.start / 1000)}>
          {l.words?.length && i === nowIdx
            ? l.words.map((w, j) => (
                <span key={j} className={cx('w', w.start <= ms && 'sung')}>
                  {w.text}
                </span>
              ))
            : l.text || '♪'}
        </p>
      ))}
    </div>
  );
}

// ---- visualizer ----
export function Visualizer({ style: kind = 'bars' }) {
  const p = usePlayer();
  const canvas = useRef(null);
  const { settings } = useApp();
  useEffect(() => {
    if (settings?.player?.visualizer === false) return;
    const an = p.ensureAnalyser();
    if (!an || !canvas.current) return;
    const c = canvas.current;
    const g = c.getContext('2d');
    const freq = new Uint8Array(an.frequencyBinCount);
    const wave = new Uint8Array(an.fftSize);
    let raf;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = devicePixelRatio || 1;
      const w = (c.width = c.clientWidth * dpr);
      const h = (c.height = c.clientHeight * dpr);
      g.clearRect(0, 0, w, h);
      if (kind === 'wave') {
        an.getByteTimeDomainData(wave);
        g.lineWidth = 2 * dpr;
        g.strokeStyle = accent;
        g.beginPath();
        for (let i = 0; i < wave.length; i += 4) {
          const x = (i / wave.length) * w;
          const y = (wave[i] / 255) * h;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
        return;
      }
      an.getByteFrequencyData(freq);
      const bars = 48;
      const bw = w / bars;
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, `${accent}33`);
      g.fillStyle = grad;
      for (let i = 0; i < bars; i++) {
        // Log spacing so the bass doesn't fill the whole width.
        const idx = Math.floor((Math.exp((i / bars) * Math.log(freq.length * 0.7)) - 1));
        const v = freq[Math.min(freq.length - 1, idx)] / 255;
        const bh = Math.max(2 * dpr, v ** 1.4 * h * 0.92);
        g.beginPath();
        g.roundRect(i * bw + bw * 0.18, h - bh, bw * 0.64, bh, 3 * dpr);
        g.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [p, kind, settings?.player?.visualizer]);
  if (settings?.player?.visualizer === false) return <Empty>The visualizer is off (Settings → Player).</Empty>;
  return (
    <div className="viz">
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  );
}

// ---- up next ----
function UpNext() {
  const p = usePlayer();
  const menus = useMenus();
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }, [p.index]);
  if (!p.queue.length) return <Empty icon={ListMusic} title="Nothing queued">Play an album, a playlist or any song and it lands here.</Empty>;
  return (
    <div ref={ref}>
      <div className="row" style={{ padding: '8px 12px 4px' }}>
        <span className="faint grow" style={{ fontSize: 12.5 }}>{p.queue.length} songs</span>
        <button className="btn small ghost" onClick={p.clear}>Clear</button>
      </div>
      {p.queue.map((q, i) => (
        <div
          key={q.uid}
          className={cx('qitem', i === p.index && 'current', drag === i && 'dragging', over === i && 'over')}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(i);
          }}
          onDragEnd={() => {
            if (drag != null && over != null && drag !== over) p.move(drag, over);
            setDrag(null);
            setOver(null);
          }}
          onDoubleClick={() => p.jump(i)}
          onContextMenu={(e) => menus.queueItem(e, q, i)}
          onClick={(e) => e.detail === 1 && window.matchMedia('(pointer: coarse)').matches && p.jump(i)}
        >
          <span className="n">{i === p.index && p.playing ? '▶' : i + 1}</span>
          <Cover pid={q.pid} id={q.coverArt} size={80} />
          <div className="ellipsis">
            <b>{q.title}</b>
            <small>{q.artist}</small>
          </div>
          <button className="btn icon small ghost" onClick={(e) => { e.stopPropagation(); p.removeAt(i); }} aria-label="Remove from the queue">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- extras (Spicetify-style) ----
export function ExtrasSheet({ onClose }) {
  const p = usePlayer();
  const e = p.extras;
  const set = p.setExtras;
  const [sleep, setSleep] = useState(30);
  return (
    <Modal title="Player extras" onClose={onClose} size="wide" icon={<SlidersHorizontal />}>
      <div className="fields two">
        <div className="panel">
          <h3>Speed</h3>
          <div className="row" style={{ marginTop: 10 }}>
            <Gauge size={18} className="faint" />
            <Range value={e.rate} max={2} step={0.05} onChange={(v) => set({ rate: Math.max(0.5, Math.round(v * 20) / 20) })} label="Speed" />
            <b className="tabular" style={{ width: 44 }}>{e.rate.toFixed(2)}×</b>
          </div>
          <div className="chips" style={{ marginTop: 10 }}>
            {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((r) => (
              <button key={r} className={cx('chip', e.rate === r && 'active')} onClick={() => set({ rate: r })}>{r}×</button>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <Toggle checked={e.keepPitch} onChange={(v) => set({ keepPitch: v })} label="Keep the pitch" description="Off gives the “nightcore / slowed” tape effect." />
          </div>
        </div>
        <div className="panel">
          <h3>Sleep timer</h3>
          <p className="muted" style={{ margin: '4px 0 10px' }}>{e.sleepAt ? `Stops in ${Math.max(1, Math.round((e.sleepAt - Date.now()) / 60000))} minutes.` : e.sleepAfterSong ? 'Stops after this song.' : 'Off'}</p>
          <div className="row wrap">
            {[15, 30, 45, 60, 90].map((m) => (
              <button key={m} className={cx('chip', sleep === m && 'active')} onClick={() => setSleep(m)}>{m} min</button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small primary" onClick={() => set({ sleepAt: Date.now() + sleep * 60000, sleepAfterSong: false })}><Timer /> Start</button>
            <button className="btn small" onClick={() => set({ sleepAfterSong: true, sleepAt: null })}><Moon /> After this song</button>
            {(e.sleepAt || e.sleepAfterSong) && <button className="btn small ghost" onClick={() => set({ sleepAt: null, sleepAfterSong: false })}>Cancel</button>}
          </div>
        </div>
        <div className="panel">
          <h3>A–B loop</h3>
          <p className="muted" style={{ margin: '4px 0 10px' }}>Repeat a part of the song, e.g. to learn it.</p>
          <div className="row wrap">
            <button className="btn small" onClick={() => set({ loop: { a: p.time, b: e.loop?.b > p.time ? e.loop.b : p.time + 10 } })}>Set A ({fmtTime(e.loop?.a ?? p.time)})</button>
            <button className="btn small" onClick={() => set({ loop: { a: e.loop?.a ?? 0, b: p.time } })}>Set B ({fmtTime(e.loop?.b ?? p.time)})</button>
            {e.loop && <button className="btn small ghost" onClick={() => set({ loop: null })}>Stop looping</button>}
          </div>
        </div>
        <div className="panel">
          <h3>Skipping</h3>
          <div className="fields two" style={{ marginTop: 10 }}>
            <Field label="Skip the first" hint="seconds of every song">
              <input className="input" type="number" min={0} max={120} value={e.skipIntro} onChange={(x) => set({ skipIntro: Number(x.target.value) || 0 })} />
            </Field>
            <Field label="Skip the last" hint="seconds of every song">
              <input className="input" type="number" min={0} max={120} value={e.skipOutro} onChange={(x) => set({ skipOutro: Number(x.target.value) || 0 })} />
            </Field>
          </div>
          <Toggle checked={e.trueShuffle} onChange={(v) => set({ trueShuffle: v })} label="True shuffle" description="Every song once before anything repeats." />
          <Toggle checked={e.trashBin} onChange={(v) => set({ trashBin: v })} label="Skip songs and artists in the trash bin" description={`${p.trash.songs.length} songs, ${p.trash.artists.length} artists. Add them from the deck’s menu.`} />
        </div>
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="row">
            <h3 className="grow">Equalizer</h3>
            <Toggle checked={e.eqOn} onChange={(v) => set({ eqOn: v })} label="" />
          </div>
          <div className="chips" style={{ margin: '8px 0 14px' }}>
            {Object.entries(EQ_PRESETS).map(([name, bands]) => (
              <button key={name} className={cx('chip', JSON.stringify(bands) === JSON.stringify(e.eq) && 'active')} onClick={() => set({ eq: bands, eqOn: true })}>{name}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 6, opacity: e.eqOn ? 1 : 0.45 }}>
            {EQ_FREQS.map((f, i) => (
              <div key={f} className="col" style={{ alignItems: 'center', gap: 4 }}>
                <input type="range" min={-12} max={12} step={0.5} value={e.eq[i]} onChange={(x) => set({ eq: e.eq.map((v, j) => (j === i ? Number(x.target.value) : v)), eqOn: true })} style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 110, accentColor: 'var(--accent)' }} aria-label={`${f} Hz`} />
                <span className="faint tabular" style={{ fontSize: 11 }}>{f >= 1000 ? `${f / 1000}k` : f}</span>
              </div>
            ))}
          </div>
          <div className="fields two" style={{ marginTop: 12 }}>
            <Toggle checked={e.leveller} onChange={(v) => set({ leveller: v })} label="Even out loudness" description="Quiet and loud songs end up closer together." />
            <Toggle checked={e.mono} onChange={(v) => set({ mono: v })} label="Mono" description="For one earbud, or speakers far apart." />
          </div>
        </div>
        <div className="panel">
          <h3>Crossfade</h3>
          <div className="row" style={{ marginTop: 10 }}>
            <Range value={e.crossfade} max={12} step={1} onChange={(v) => set({ crossfade: Math.round(v) })} label="Crossfade" />
            <b className="tabular" style={{ width: 40 }}>{e.crossfade ? `${e.crossfade} s` : 'Off'}</b>
          </div>
        </div>
        <div className="panel">
          <h3>Controls</h3>
          <Toggle checked={e.wheelVolume} onChange={(v) => set({ wheelVolume: v })} label="Scroll to change the volume" />
          <p className="faint" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
            Keys: <span className="kbd">Space</span> play/pause · <span className="kbd">Shift ←/→</span> previous/next · <span className="kbd">Alt ←/→</span> 10 s · <span className="kbd">M</span> mute · <span className="kbd">Ctrl K</span> search
          </p>
        </div>
      </div>
    </Modal>
  );
}

function Bookmarks() {
  const p = usePlayer();
  const mine = p.bookmarks.filter((b) => !p.current || b.title === p.current.title);
  return (
    <div style={{ padding: 12 }}>
      <button
        className="btn small"
        disabled={!p.current}
        onClick={() => p.setBookmarks([{ id: Date.now(), at: p.time, title: p.current.title, artist: p.current.artist, item: p.current }, ...p.bookmarks])}
      >
        <Bookmark /> Bookmark {fmtTime(p.time)}
      </button>
      {!mine.length && <p className="faint" style={{ fontSize: 13 }}>Save a moment of a song to jump back to it later.</p>}
      {mine.map((b) => (
        <div key={b.id} className="qitem" style={{ gridTemplateColumns: '50px minmax(0,1fr) auto' }} onClick={() => (p.current?.title === b.title ? p.seek(b.at) : (p.playList([b.item], 0, b.item.pid), setTimeout(() => p.seek(b.at), 800)))}>
          <span className="badge">{fmtTime(b.at)}</span>
          <div className="ellipsis">
            <b>{b.title}</b>
            <small>{b.artist}</small>
          </div>
          <button className="btn icon small ghost" onClick={(e) => { e.stopPropagation(); p.setBookmarks(p.bookmarks.filter((x) => x.id !== b.id)); }} aria-label="Remove bookmark">
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Deck({ onClose }) {
  const p = usePlayer();
  const menus = useMenus();
  const [tab, setTab] = useState('next');
  const [extras, setExtras] = useState(false);
  const [full, setFull] = useState(false);
  const cur = p.current;
  return (
    <aside className="deck" aria-label="Player">
      <div className="deck-top">
        <div className="deck-art" onClick={() => cur && setFull(true)} onContextMenu={(e) => menus.nowPlaying(e, { onFull: () => setFull(true), onHide: onClose })}>
          {cur ? <CanvasCover pid={cur.pid} localId={cur.localId} coverArt={cur.coverArt} /> : <div className="cover" style={{ width: '100%', height: '100%' }}><div className="ph"><Music2 /></div></div>}
          <div className="deck-tools">
            <button className="btn icon small" onClick={(e) => { e.stopPropagation(); setFull(true); }} aria-label="Full screen"><Maximize2 /></button>
            <button className="btn icon small" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Hide the player"><X /></button>
          </div>
        </div>
        <div className="deck-meta">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="t ellipsis" title={cur?.title}>{cur?.title || 'Nothing playing'}</div>
            <div className="a ellipsis">
              {cur?.artistId ? <Link to={`/artist/${encodeURIComponent(cur.artistId)}`}>{cur.artist}</Link> : <span className="muted">{cur?.artist || 'Pick something to play'}</span>}
            </div>
            <SourceLine />
          </div>
          <HeartButton />
        </div>
        {p.error && (
          <div className="notice danger" style={{ fontSize: 12.5, padding: '8px 10px' }}>
            <span className="grow">{p.error}</span>
            {p.skipIn != null && <button className="btn small" onClick={p.cancelSkip}>Stay</button>}
          </div>
        )}
        <Transport />
        <div className="row">
          <div className="grow"><Volume /></div>
          <button className="btn icon small ghost" onClick={() => setExtras(true)} aria-label="Player extras" title="Speed, EQ, sleep timer and more">
            <SlidersHorizontal />
          </button>
          {cur && (
            <button
              className="btn icon small ghost"
              title="Never play this song again (trash bin)"
              aria-label="Put this song in the trash bin"
              onClick={() => {
                p.setTrash({ ...p.trash, songs: [...new Set([...p.trash.songs, `${cur.title}|${cur.artist}`])] });
                p.next();
              }}
            >
              <Ban />
            </button>
          )}
        </div>
      </div>
      <div className="deck-tabs" role="tablist">
        {[['next', 'Up next'], ['lyrics', 'Lyrics'], ['viz', 'Visualizer'], ['marks', 'Bookmarks']].map(([id, label]) => (
          <button key={id} className={cx(tab === id && 'active')} onClick={() => setTab(id)} role="tab" aria-selected={tab === id}>
            {label}
          </button>
        ))}
      </div>
      <div className="deck-body">
        {tab === 'next' && <UpNext />}
        {tab === 'lyrics' && <LyricsView />}
        {tab === 'viz' && <Visualizer />}
        {tab === 'marks' && <Bookmarks />}
      </div>
      {extras && <ExtrasSheet onClose={() => setExtras(false)} />}
      {full && <FullPlayer onClose={() => setFull(false)} />}
    </aside>
  );
}

export function Capsule({ onOpen }) {
  const p = usePlayer();
  const menus = useMenus();
  const cur = p.current;
  if (!cur) return null;
  const d = p.duration || cur.duration || 0;
  return (
    <div className="capsule" role="region" aria-label="Now playing" onContextMenu={(e) => menus.nowPlaying(e, { onFull: onOpen })}>
      <Cover pid={cur.pid} id={cur.coverArt} size={100} round onClick={onOpen} />
      <div className="meta" onClick={onOpen}>
        <b>{cur.title}</b>
        <small>{cur.artist}</small>
      </div>
      <button className="btn icon" onClick={p.prev} aria-label="Previous"><SkipBack fill="currentColor" /></button>
      <button className="btn icon play" onClick={p.toggle} aria-label={p.playing ? 'Pause' : 'Play'}>{p.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>
      <button className="btn icon" onClick={p.next} aria-label="Next"><SkipForward fill="currentColor" /></button>
      <div className="prog"><i style={{ width: `${d ? (p.time / d) * 100 : 0}%` }} /></div>
    </div>
  );
}

export function FullPlayer({ onClose }) {
  const p = usePlayer();
  const cur = p.current;
  const [side, setSide] = useState('lyrics');
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!cur) return null;
  // A portal: the deck has a backdrop blur, which would trap position: fixed inside it.
  return createPortal(
    <div className="fullplayer" role="dialog" aria-label="Now playing">
      <div className="bgfx" style={{ backgroundImage: `url(${coverUrl(cur.pid, cur.coverArt, 300)})` }} />
      <button className="btn icon ghost" style={{ position: 'absolute', top: 18, right: 18 }} onClick={onClose} aria-label="Close"><Minimize2 /></button>
      <div className="col" style={{ justifyContent: 'center', gap: 22, minHeight: 0 }}>
        <div className="bigcover"><CanvasCover pid={cur.pid} localId={cur.localId} coverArt={cur.coverArt} /></div>
        <div style={{ width: 'min(560px, 100%)', alignSelf: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 30, letterSpacing: '-0.02em' }}>{cur.title}</h1>
          <p className="muted" style={{ margin: '2px 0 14px', fontSize: 17 }}>{cur.artist}{cur.album ? ` — ${cur.album}` : ''}</p>
          <Transport />
        </div>
      </div>
      <div className="col" style={{ minHeight: 0 }}>
        <Segmented value={side} onChange={setSide} options={[{ value: 'lyrics', label: 'Lyrics' }, { value: 'viz', label: 'Visualizer' }]} />
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>{side === 'lyrics' ? <LyricsView big /> : <div className="viz-big"><Visualizer /></div>}</div>
      </div>
    </div>,
    document.body,
  );
}

export { Trash2, GripVertical };
