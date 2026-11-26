import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Scissors, Plus, Trash2, Eye, Check, Copy, ChevronUp, ChevronDown } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post } from '../lib/api.js';
import { fmtTime } from '../lib/util.js';
import { Field, Notice, Spinner, Menu, MenuItem, JobDetails } from './ui.jsx';

const NICE = {
  start: 'Start (s)', end: 'End (s)', duration: 'Length (s)', db: 'dB', lufs: 'Target loudness (LUFS)', peak: 'Peak (dB)', factor: 'Factor', semitones: 'Semitones',
  gain: 'Gain (dB)', frequency: 'Frequency (Hz)', threshold: 'Threshold (dB)', ratio: 'Ratio', limit: 'Limit (dB)', amount: 'Amount', delay: 'Delay (ms)', decay: 'Decay',
  reverb: 'Reverb', pan: 'Left −1 … right 1', bits: 'Bits', rate: 'Sample rate (Hz)', curve: 'Curve',
};
const PRESETS = [
  ['Make it louder (normalize)', [{ type: 'normalize', params: { lufs: -14, peak: -1 } }]],
  ['Nightcore', [{ type: 'nightcore', params: { factor: 1.25 } }]],
  ['Slowed + reverb', [{ type: 'slowed', params: { factor: 0.85, reverb: 0.4 } }]],
  ['Remove silence at the ends', [{ type: 'silence', params: { threshold: -50 } }]],
  ['Smooth start and end', [{ type: 'fadeIn', params: { duration: 1.5 } }, { type: 'fadeOut', params: { duration: 3 } }]],
  ['Clean up a recording', [{ type: 'denoise', params: { amount: 12 } }, { type: 'compressor', params: { threshold: -18, ratio: 3 } }, { type: 'normalize', params: { lufs: -16, peak: -1 } }]],
];

function Wave({ peaks, duration, time, sel, onSel, onSeek, color }) {
  const ref = useRef(null);
  const box = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const dpr = devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const g = c.getContext('2d');
    const mid = c.height / 2;
    g.fillStyle = color || getComputedStyle(document.documentElement).getPropertyValue('--accent');
    const w = c.width / peaks.length;
    peaks.forEach(([lo, hi], i) => {
      const h1 = Math.max(1, -lo * mid * 0.95);
      const h2 = Math.max(1, hi * mid * 0.95);
      g.fillRect(i * w, mid - h2, Math.max(1, w - 0.5), h1 + h2);
    });
  }, [peaks, color]);
  const at = (e) => {
    const r = box.current.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration));
  };
  const down = (e) => {
    const a = at(e);
    let moved = false;
    const mv = (ev) => {
      moved = true;
      const b = at(ev);
      onSel({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      if (!moved) {
        onSel(null);
        onSeek(at(ev));
      }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="wave" ref={box} onPointerDown={down}>
      <canvas ref={ref} />
      {sel && duration > 0 && <div className="sel" style={{ left: `${(sel.start / duration) * 100}%`, width: `${((sel.end - sel.start) / duration) * 100}%` }} />}
      {duration > 0 && <div className="head" style={{ left: `${(time / duration) * 100}%` }} />}
    </div>
  );
}

export function AudioEditor({ track, onSaved }) {
  const { pid, fail, toast, afterJob } = useApp();
  const ops = useLoad(() => get('editor/ops'), []);
  const wave = useLoad(() => get(`p/${pid}/tracks/${track.id}/waveform`), [pid, track.id, track.modified]);
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(null);
  const [lastJob, setLastJob] = useState(null);
  const audio = useRef(null);
  const dur = wave.data?.duration || track.duration || 0;
  const src = preview ? preview.url : `/api/p/${pid}/tracks/${track.id}/file`;

  const add = (type, params) => setList((l) => [...l, { type, params: params || { ...ops.data[type].params } }]);
  const runPreview = async () => {
    setBusy(true);
    try {
      setPreview(await post(`p/${pid}/tracks/${track.id}/edit/preview`, { ops: list }));
      setTimeout(() => audio.current?.play(), 100);
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const apply = async (mode) => {
    setBusy(true);
    try {
      const r = await post(`p/${pid}/tracks/${track.id}/edit/apply`, { ops: list, mode });
      setLastJob(r.job);
      const j = await afterJob(r.job);
      if (j.status === 'done') {
        toast(mode === 'copy' ? 'Saved as a new version' : 'Applied (a restore point was made first)');
        setList([]);
        setPreview(null);
        onSaved?.();
        wave.reload();
      } else fail(j.error || 'Editing failed');
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const toggle = () => (audio.current.paused ? audio.current.play() : audio.current.pause());
  useEffect(() => setPreview(null), [JSON.stringify(list)]);

  return (
    <div className="col" style={{ gap: 14 }}>
      <audio ref={audio} src={src} preload="metadata" onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
      {wave.loading && !wave.data ? <div className="wave" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div> : (
        <Wave peaks={(preview?.waveform || wave.data)?.peaks} duration={preview?.waveform?.duration || dur} time={time} sel={preview ? null : sel} onSel={setSel} onSeek={(t) => { audio.current.currentTime = t; }} />
      )}
      <div className="row wrap">
        <button className="btn icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause /> : <Play />}</button>
        <span className="tabular faint">{fmtTime(time)} / {fmtTime(preview?.waveform?.duration || dur)}</span>
        {preview && <span className="badge accent">Hearing the preview</span>}
        <span className="grow" />
        {sel && !preview && (
          <>
            <span className="faint" style={{ fontSize: 12.5 }}>Selected {fmtTime(sel.start)}–{fmtTime(sel.end)}</span>
            <button className="btn small" onClick={() => { add('trim', { start: +sel.start.toFixed(2), end: +sel.end.toFixed(2) }); setSel(null); }}>Keep only this</button>
            <button className="btn small" onClick={() => { add('cut', { start: +sel.start.toFixed(2), end: +sel.end.toFixed(2) }); setSel(null); }}><Scissors /> Cut it out</button>
            <button className="btn small" onClick={() => { add('fadeIn', { duration: +(sel.end - sel.start).toFixed(2) }); setSel(null); }}>Fade in this long</button>
          </>
        )}
      </div>
      {!sel && !list.length && <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Drag across the waveform to pick a part; click to jump there.</p>}

      <div className="row wrap">
        <button className="btn" onClick={(e) => setMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })} disabled={!ops.data}><Plus /> Add an effect</button>
        {PRESETS.map(([name, o]) => (
          <button key={name} className="chip" onClick={() => setList((l) => [...l, ...o.map((x) => ({ ...x, params: { ...x.params } }))])}>{name}</button>
        ))}
      </div>

      {list.length > 0 && (
        <div className="oplist">
          {list.map((op, i) => (
            <div key={i} className="op">
              <div className="col" style={{ gap: 0 }}>
                <button className="btn icon small ghost" disabled={!i} onClick={() => setList((l) => { const c = l.slice(); [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; })} aria-label="Earlier"><ChevronUp /></button>
                <button className="btn icon small ghost" disabled={i === list.length - 1} onClick={() => setList((l) => { const c = l.slice(); [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; })} aria-label="Later"><ChevronDown /></button>
              </div>
              <div>
                <b>{ops.data?.[op.type]?.label || op.type}</b>
                <div className="row wrap" style={{ marginTop: 6 }}>
                  {Object.entries(op.params).map(([k, v]) =>
                    Array.isArray(v) ? (
                      <div key={k} className="row" style={{ gap: 4 }}>
                        {v.map((b, j) => (
                          <input key={j} type="range" min={-12} max={12} step={0.5} value={b} title={`${[31, 62, 125, 250, 500, '1k', '2k', '4k', '8k', '16k'][j]} Hz: ${b} dB`} onChange={(e) => setList((l) => l.map((x, n) => (n === i ? { ...x, params: { ...x.params, [k]: v.map((y, m) => (m === j ? Number(e.target.value) : y)) } } : x)))} style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 70, accentColor: 'var(--accent)' }} />
                        ))}
                      </div>
                    ) : (
                      <Field key={k} label={NICE[k] || k} style={{ width: 130 }}>
                        {k === 'curve' ? (
                          <select className="select" value={v} onChange={(e) => setList((l) => l.map((x, n) => (n === i ? { ...x, params: { ...x.params, [k]: e.target.value } } : x)))}>
                            {['tri', 'qsin', 'esin', 'log', 'exp'].map((c) => <option key={c}>{c}</option>)}
                          </select>
                        ) : (
                          <input className="input" type="number" step="any" value={v ?? ''} placeholder={k === 'end' ? 'end' : ''} onChange={(e) => setList((l) => l.map((x, n) => (n === i ? { ...x, params: { ...x.params, [k]: e.target.value === '' ? null : Number(e.target.value) } } : x)))} />
                        )}
                      </Field>
                    ),
                  )}
                </div>
              </div>
              <button className="btn icon ghost" onClick={() => setList((l) => l.filter((_, n) => n !== i))} aria-label="Remove"><Trash2 /></button>
            </div>
          ))}
        </div>
      )}
      {list.length > 0 && (
        <div className="row wrap">
          <button className="btn" onClick={runPreview} disabled={busy}>{busy ? <Spinner size={14} /> : <Eye />} Preview</button>
          <span className="grow" />
          <button className="btn" onClick={() => apply('copy')} disabled={busy}><Copy /> Save as a new version</button>
          <button className="btn primary" onClick={() => apply('replace')} disabled={busy}><Check /> Apply to this song</button>
        </div>
      )}
      {lastJob && <JobDetails jobId={lastJob} />}
      <Notice>Changes re-encode the audio in its own format at the same or higher quality. “Apply” keeps a restore point, so you can always go back (File tab).</Notice>
      {menu && ops.data && (
        <Menu at={menu} onClose={() => setMenu(null)}>
          {Object.entries(ops.data).map(([k, v]) => <MenuItem key={k} onClick={() => add(k)}>{v.label}</MenuItem>)}
        </Menu>
      )}
    </div>
  );
}
