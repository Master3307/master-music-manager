import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { Sparkles } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { store } from '../lib/util.js';
import { Modal } from './ui.jsx';

const STEPS = [
  { sel: '.rail a[href="/"]', title: 'Listen', text: 'Your music: albums, artists, playlists, favorites and radio. Right-click anything for more (play next, add to a playlist, share …).' },
  { sel: '.rail a[href="/library"]', title: 'Library', text: 'Every song as a table. Select songs and edit them all at once, fix covers and tags, find duplicates. Hidden in the simple player.', full: true },
  { sel: '.rail a[href="/add"]', title: 'Add', text: 'Drop files, folders or zips, or paste links from Spotify, YouTube and more. New songs wait for a quick check before they go into your library.' },
  { sel: '.topbar .searchbar', title: 'Search and commands', text: 'Type to search. Filters like artist:nujabes or year>2010 work too, and > runs a command on your library (try > help). Ctrl K jumps here.' },
  { sel: '.deck, .capsule', title: 'The player', text: 'What’s playing, what’s next, synced lyrics and a visualizer. The sliders button has speed, equalizer, sleep timer and more. P hides it.' },
  { sel: '.profile-pill', title: 'Your libraries', text: 'Switch between your music servers and folders here, or add another one.' },
  { sel: '.rail a[href="/settings"]', title: 'Settings', text: 'Themes and colours, accounts, linking other computers, the Navidrome plugin and backups. This tour lives in Settings → General.' },
];

export function TourOffer() {
  const { search } = useLocation();
  const nav = useNavigate();
  const [ask, setAsk] = useState(false);
  const [run, setRun] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(search).get('tour');
    if (q === '1') setRun(true);
    else if (q === 'ask' && !store.get('tourAsked', false)) setAsk(true);
    if (q) nav({ search: '' }, { replace: true });
  }, [search, nav]);
  if (run) return <Tour onDone={() => setRun(false)} />;
  if (!ask) return null;
  const close = (yes) => {
    store.set('tourAsked', true);
    setAsk(false);
    if (yes) setRun(true);
  };
  return (
    <Modal
      title="Want a quick look around?"
      icon={<Sparkles />}
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn ghost" onClick={() => close(false)}>No thanks</button>
          <button className="btn primary" onClick={() => close(true)}>Show me (1 minute)</button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>Seven short stops that show where everything is. You can start it again any time in Settings → General.</p>
    </Modal>
  );
}

export function Tour({ onDone }) {
  const { settings } = useApp();
  const steps = STEPS.filter((s) => !(s.full && settings?.appearance?.simple)).filter((s) => document.querySelector(s.sel));
  const [i, setI] = useState(0);
  const [box, setBox] = useState(null);
  const step = steps[i];
  useLayoutEffect(() => {
    const el = step && document.querySelector(step.sel);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBox({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 });
  }, [step]);
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onDone();
      if (e.key === 'ArrowRight' || e.key === 'Enter') i + 1 < steps.length ? setI(i + 1) : onDone();
      if (e.key === 'ArrowLeft') setI(Math.max(0, i - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [i, steps.length, onDone]);
  if (!step || !box) return null;
  // Card next to the spotlight, kept on screen.
  const right = box.x + box.w + 340 < innerWidth;
  const left = right ? box.x + box.w + 14 : Math.max(12, Math.min(innerWidth - 332, box.x));
  const top = right ? Math.min(innerHeight - 220, Math.max(12, box.y)) : Math.min(innerHeight - 220, box.y + box.h + 14);
  return createPortal(
    <div className="tour" role="dialog" aria-label="Tour">
      <div className="tour-spot" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
      <div className="tour-card" style={{ left, top }}>
        <div className="faint" style={{ fontSize: 12 }}>{i + 1} of {steps.length}</div>
        <h3 style={{ margin: '2px 0 6px' }}>{step.title}</h3>
        <p className="muted" style={{ margin: 0 }}>{step.text}</p>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn small ghost" onClick={onDone}>End the tour</button>
          <span className="grow" />
          {i > 0 && <button className="btn small" onClick={() => setI(i - 1)}>Back</button>}
          <button className="btn small primary" onClick={() => (i + 1 < steps.length ? setI(i + 1) : onDone())}>{i + 1 < steps.length ? 'Next' : 'Done'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
