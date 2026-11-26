import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Save, Play, Pause, Timer, Trash2, Wand2, Type, ListOrdered, Check } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { get, post, put, del } from '../lib/api.js';
import { fmtTime, cx } from '../lib/util.js';
import { Field, Notice, Spinner, Segmented, Toggle, useConfirm } from './ui.jsx';

const ts = (ms) => {
  const t = Math.max(0, Math.round(ms || 0));
  return `${String(Math.floor(t / 60000)).padStart(2, '0')}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}.${String(Math.floor((t % 1000) / 10)).padStart(2, '0')}`;
};
const parseTs = (s) => {
  const m = String(s).match(/(\d+):(\d+)(?:[.:](\d+))?/);
  return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 + (m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0) : null;
};

/** LRC / enhanced LRC text ↔ lines (same rules as the server). */
function parse(text) {
  const lines = [];
  let offset = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = raw.match(/^\[offset:([+-]?\d+)\]/i);
    if (off) offset = Number(off[1]);
    if (/^\[(ti|ar|al|au|by|offset|length|re|ve|lang|#):/i.test(raw)) continue;
    const stamps = [...raw.matchAll(/\[(\d+:\d+(?:[.:]\d+)?)\]/g)];
    const rest = raw.replace(/\[(\d+:\d+(?:[.:]\d+)?)\]/g, '');
    const words = [...rest.matchAll(/<(\d+:\d+(?:[.:]\d+)?)>([^<]*)/g)].map((m) => ({ start: parseTs(m[1]), text: m[2] }));
    const plain = rest.replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim();
    if (stamps.length) for (const s of stamps) lines.push({ start: parseTs(s[1]), text: plain, words: words.length ? words : undefined });
    else if (raw.trim()) lines.push({ start: null, text: raw.trim() });
  }
  return { lines, offset, synced: lines.some((l) => l.start != null) };
}
function format(lines, offset) {
  const head = offset ? [`[offset:${offset}]`] : [];
  if (!lines.some((l) => l.start != null)) return lines.map((l) => l.text).join('\n');
  return [...head, ...lines.map((l) => (l.words?.length ? `[${ts(l.start)}]${l.words.map((w) => `<${ts(w.start)}>${w.text}`).join('')}` : `[${ts(l.start ?? 0)}]${l.text}`))].join('\n');
}

export function LyricsEditor({ track, onSaved }) {
  const { pid, fail, toast } = useApp();
  const confirm = useConfirm();
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const [lang, setLang] = useState('eng');
  const [sources, setSources] = useState(null);
  const [mode, setMode] = useState('text');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [sidecar, setSidecar] = useState(true);
  const [busy, setBusy] = useState(false);
  const audio = useRef(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [wordMode, setWordMode] = useState(false);
  const [wordCursor, setWordCursor] = useState(0);

  useEffect(() => {
    get(`p/${pid}/tracks/${track.id}/lyrics`).then((list) => {
      setSources(list);
      const best = list.find((l) => l.synced) || list[0];
      if (best) {
        setText(best.raw || best.lines?.map((l) => l.text).join('\n') || '');
        setOffset(best.offset || 0);
        if (best.language) setLang(best.language);
      }
    }).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, pid]);

  const parsed = useMemo(() => parse(text), [text]);
  const lines = parsed.lines;
  const ms = time * 1000 + offset;
  const now = parsed.synced ? lines.findLastIndex((l) => l.start != null && l.start <= ms) : -1;

  const search = async () => {
    setSearching(true);
    try {
      setResults(await post('lyrics/search', { title: track.title, artist: track.artist, album: track.album, duration: track.duration }));
    } catch (e) {
      fail(e);
    }
    setSearching(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await put(`p/${pid}/tracks/${track.id}/lyrics`, { text: parsed.synced ? format(lines, offset) : text, offset, language: lang, sidecar });
      toast(r.synced ? `Saved ${r.lines} synced lines` : 'Lyrics saved');
      onSaved?.();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play();
    else a.pause();
  };
  // Tap to sync: Space / button stamps the current line (or word) and moves on.
  const stamp = () => {
    const t = Math.max(0, time * 1000 - 150); // people tap a little late
    const list = lines.map((l) => ({ ...l }));
    if (!list.length) return;
    if (wordMode) {
      const l = list[cursor];
      const words = l.words?.length ? l.words : l.text.split(/(?<=\s)/).map((w) => ({ start: null, text: w }));
      if (wordCursor === 0) l.start = t;
      words[wordCursor] = { ...words[wordCursor], start: t };
      l.words = words;
      if (wordCursor + 1 >= words.length) {
        setWordCursor(0);
        setCursor(Math.min(list.length - 1, cursor + 1));
      } else setWordCursor(wordCursor + 1);
    } else {
      list[cursor].start = t;
      delete list[cursor].words;
      setCursor(Math.min(list.length - 1, cursor + 1));
    }
    setText(format(list.map((l) => ({ ...l, start: l.start ?? 0 })), 0));
  };
  useEffect(() => {
    if (mode !== 'sync') return;
    const k = (e) => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
        e.preventDefault();
        stamp();
      } else if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1));
      else if (e.key === 'ArrowDown') setCursor((c) => Math.min(lines.length - 1, c + 1));
      else if (e.key === 'p') toggle();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'text', label: 'Edit text', icon: Type }, { value: 'lines', label: 'Line by line', icon: ListOrdered }, { value: 'sync', label: 'Tap to sync', icon: Timer }]} />
        <span className="grow" />
        <button className="btn" onClick={search} disabled={searching}>{searching ? <Spinner size={14} /> : <Search />} Look up</button>
        {(sources?.length || text) && <button className="btn ghost danger" onClick={async () => { if (await confirm({ title: 'Remove the lyrics?', body: 'From the file and the .lrc next to it.', danger: true, confirm: 'Remove' })) { await del(`p/${pid}/tracks/${track.id}/lyrics`).catch(fail); setText(''); onSaved?.(); } }}><Trash2 /></button>}
      </div>
      <audio ref={audio} src={`/api/p/${pid}/tracks/${track.id}/file`} preload="metadata" onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
      <div className="row">
        <button className="btn icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause /> : <Play />}</button>
        <input type="range" className="range" min={0} max={track.duration || 0} step="any" value={time} style={{ '--p': `${track.duration ? (time / track.duration) * 100 : 0}%` }} onChange={(e) => { audio.current.currentTime = Number(e.target.value); }} aria-label="Position" />
        <span className="tabular faint" style={{ fontSize: 12 }}>{fmtTime(time)}</span>
        <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>Delay</span>
        <input className="input tabular" type="number" step={50} style={{ width: 96 }} value={offset} onChange={(e) => setOffset(Number(e.target.value) || 0)} title="Milliseconds. Positive = lyrics show later." />
        <span className="faint" style={{ fontSize: 12 }}>ms</span>
      </div>

      {results && (
        <div className="panel" style={{ padding: 10, maxHeight: 280, overflow: 'auto' }}>
          {!results.length && <p className="faint" style={{ margin: 6 }}>Nothing found on the lyric sites.</p>}
          {results.map((r, i) =>
            r.error ? (
              <div key={i} className="faint" style={{ padding: 6, fontSize: 12.5 }}>{r.provider}: {r.error}</div>
            ) : (
              <div key={i} className="row" style={{ padding: '6px 4px', borderBottom: '1px solid var(--line)' }}>
                <span className={cx('badge', r.score >= 85 ? 'ok' : r.score >= 60 ? 'warn' : 'danger')}>{r.score}%</span>
                <span className="badge">{r.synced ? 'synced' : 'plain'}</span>
                <span className="grow ellipsis">{r.artist} – {r.title} <span className="faint">{[r.album, r.duration && fmtTime(r.duration), r.provider].filter(Boolean).join(' · ')}</span></span>
                <button className="btn small" onClick={() => { setText(r.text); setOffset(0); setResults(null); }}><Check /> Use</button>
              </div>
            ),
          )}
        </div>
      )}

      {mode === 'text' && (
        <Field hint="Plain lines, or LRC: [01:23.45]line. Word timing: [01:23.45]<01:23.45>Word <01:24.10>by <01:24.50>word.">
          <textarea className="textarea mono" rows={16} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="Paste or type the lyrics…" />
        </Field>
      )}
      {mode === 'lines' && (
        <div className="col" style={{ gap: 6, maxHeight: 420, overflow: 'auto' }}>
          {lines.map((l, i) => (
            <div key={i} className={cx('lyr-line', i === now && 'now')}>
              <input className="input mono" value={l.start == null ? '' : ts(l.start)} placeholder="--:--.--" onChange={(e) => { const list = lines.slice(); list[i] = { ...l, start: parseTs(e.target.value) }; setText(format(list, 0)); }} />
              <input className="input" value={l.text} onChange={(e) => { const list = lines.slice(); list[i] = { ...l, text: e.target.value, words: undefined }; setText(format(list, 0) || list.map((x) => x.text).join('\n')); }} />
              <button className="btn icon small ghost" onClick={() => audio.current && l.start != null && (audio.current.currentTime = l.start / 1000)} aria-label="Jump here"><Play /></button>
            </div>
          ))}
          {!lines.length && <p className="faint">Add some text first.</p>}
        </div>
      )}
      {mode === 'sync' && (
        <div className="col" style={{ gap: 10 }}>
          <Notice icon={Wand2}>Play the song and press <span className="kbd">Space</span> (or the big button) when each {wordMode ? 'word' : 'line'} starts. <span className="kbd">↑</span> <span className="kbd">↓</span> pick the line, <span className="kbd">P</span> plays and pauses.</Notice>
          <div className="row">
            <button className="btn primary" style={{ height: 48, padding: '0 26px' }} onClick={stamp}><Timer /> Now</button>
            <Toggle checked={wordMode} onChange={(v) => { setWordMode(v); setWordCursor(0); }} label="Word by word" description="For karaoke-style lyrics" />
          </div>
          <div style={{ maxHeight: 360, overflow: 'auto' }} className="deck-lyrics">
            {lines.map((l, i) => (
              <p key={i} className={cx(i === cursor ? 'now' : i < cursor ? 'past' : '')} onClick={() => setCursor(i)} style={{ fontSize: 16 }}>
                <span className="mono faint" style={{ fontSize: 11, marginRight: 8 }}>{l.start != null ? ts(l.start) : '--:--'}</span>
                {wordMode && i === cursor ? l.text.split(/(?<=\s)/).map((w, j) => <span key={j} style={{ color: j < wordCursor ? 'var(--accent)' : undefined }}>{w}</span>) : l.text}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="row wrap">
        <Field label="Language" hint="ISO 639-2, e.g. eng, deu, jpn, kor" style={{ width: 200 }}>
          <input className="input mono" value={lang} maxLength={3} onChange={(e) => setLang(e.target.value.toLowerCase())} />
        </Field>
        <div style={{ alignSelf: 'end' }}>
          <Toggle checked={sidecar} onChange={setSidecar} label="Also save as .lrc next to the file" description="Navidrome and most players read it." />
        </div>
        <span className="grow" />
        <span className="faint" style={{ alignSelf: 'end', fontSize: 12.5 }}>{parsed.synced ? `${lines.length} synced lines${lines.some((l) => l.words) ? ', word timing' : ''}` : `${lines.length} lines, not synced`}</span>
        <button className="btn primary" style={{ alignSelf: 'end' }} onClick={save} disabled={busy}><Save /> Save lyrics</button>
      </div>
      {sources?.length > 1 && <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Found in: {sources.map((s) => s.source).join(', ')}. Saving writes them all the same.</p>}
    </div>
  );
}
