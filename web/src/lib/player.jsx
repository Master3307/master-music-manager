import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { post } from './api.js';
import { coverUrl, dominantColor, store } from './util.js';
import { useApp } from './app.jsx';

const PlayerCtx = createContext(null);
export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  Loudness: [5, 4, 1, 0, -1, 0, 0, 1, 4, 5],
  Electronic: [5, 4, 1, 0, -2, 1, 1, 2, 4, 5],
  Acoustic: [3, 3, 2, 1, 1, 1, 2, 3, 2, 1],
  'Late night': [-1, 0, 1, 2, 2, 1, 0, -1, -3, -4],
};
const EXTRAS_DEFAULT = { rate: 1, keepPitch: true, loop: null, sleepAt: null, sleepAfterSong: false, trashBin: true, skipIntro: 0, skipOutro: 0, trueShuffle: true, crossfade: 0, eqOn: false, eq: EQ_PRESETS.Flat, leveller: false, mono: false, wheelVolume: true };
export const usePlayer = () => useContext(PlayerCtx);

/** The key the server streams by: our local id, or the service's id. */
export const streamKey = (s) => (s.localId && !String(s.id).startsWith('l:') ? `l:${s.localId}` : String(s.id));

export function toQueueItem(s, pid) {
  return {
    uid: Math.random().toString(36).slice(2),
    pid: s.pid || pid,
    id: s.id,
    localId: s.localId ?? (String(s.id).startsWith('l:') ? Number(String(s.id).slice(2)) : null),
    title: s.title || s.filename || 'Untitled',
    artist: s.artist,
    album: s.album,
    albumId: s.albumId,
    artistId: s.artistId || s.artists?.[0]?.id,
    duration: s.duration,
    radio: s.radio || null,
    coverArt: s.coverArt || (s.cover && s.localId ? `l:${s.localId}` : null) || (s.cover && String(s.id).startsWith('l:') ? s.id : null),
    starred: s.starred,
    rating: s.rating,
  };
}

export function PlayerProvider({ children }) {
  const { settings, toast } = useApp();
  const audio = useRef(null);
  const [queue, setQueue] = useState(() => store.get('queue', []));
  const [index, setIndex] = useState(() => store.get('queueIndex', 0));
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [volume, setVolumeState] = useState(() => store.get('volume', 0.8));
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(() => store.get('shuffle', false));
  const [repeat, setRepeat] = useState(() => store.get('repeat', 'off'));
  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);
  const scrobbled = useRef(new Set());
  const retries = useRef(new Map());
  const [skipIn, setSkipIn] = useState(null);
  // Player extras (the kind of things Spicetify extensions add), all optional.
  const [extras, setExtrasState] = useState(() => ({ ...EXTRAS_DEFAULT, ...store.get('extras', {}) }));
  const setExtras = useCallback((patch) => setExtrasState((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) })), []);
  useEffect(() => store.set('extras', { ...extras, loop: null, sleepAt: null }), [extras]);
  const [trash, setTrash] = useState(() => store.get('trash', { songs: [], artists: [] }));
  useEffect(() => store.set('trash', trash), [trash]);
  const [bookmarks, setBookmarks] = useState(() => store.get('bookmarks', []));
  useEffect(() => store.set('bookmarks', bookmarks.slice(0, 500)), [bookmarks]);
  const order = useRef([]); // true shuffle: a shuffled order, no repeats until everything played
  const eq = useRef([]);
  const comp = useRef(null);
  const splitter = useRef(null);
  const analyser = useRef(null);
  const ctxRef = useRef(null);
  const current = queue[index] || null;

  if (!audio.current && typeof Audio !== 'undefined') {
    audio.current = new Audio();
    // Only the length until you press play: no song downloads in the background while the page is open.
    audio.current.preload = 'metadata';
    audio.current.crossOrigin = 'use-credentials';
  }

  useEffect(() => store.set('queue', queue.slice(0, 2000)), [queue]);
  useEffect(() => store.set('queueIndex', index), [index]);
  useEffect(() => store.set('volume', volume), [volume]);
  useEffect(() => store.set('shuffle', shuffle), [shuffle]);
  useEffect(() => store.set('repeat', repeat), [repeat]);

  // Load the current song.
  const loadedUid = useRef(null);
  const wantPlay = useRef(false);
  const currentRef = useRef(null);
  currentRef.current = current;
  useEffect(() => {
    const a = audio.current;
    if (!a || !current) return;
    if (loadedUid.current === current.uid) return;
    const firstLoad = loadedUid.current === null;
    loadedUid.current = current.uid;
    setError(null);
    a.src = current.radio || `/api/p/${current.pid}/stream/${encodeURIComponent(streamKey(current))}`;
    setTime(0);
    setDuration(current.duration || 0);
    // After a reload: back to where you were in this song, ready to go on.
    const saved = firstLoad && !current.radio ? store.get('resume', null) : null;
    if (saved?.uid === current.uid && saved.t > 2) {
      const at = () => {
        if (!a.duration || saved.t < a.duration - 3) {
          a.currentTime = saved.t;
          setTime(saved.t);
        }
      };
      a.addEventListener('loadedmetadata', at, { once: true });
      setTime(saved.t);
      return;
    }
    if (wantPlay.current) a.play().catch(() => {});
    // Now playing on the service.
    if (!current.radio) post(`p/${current.pid}/scrobble`, { key: streamKey(current), submission: false, song: { title: current.title, artist: current.artist, album: current.album, duration: current.duration }, player: navigator.userAgentData?.platform ? `Master Music Manager · ${navigator.userAgentData.platform}` : 'Master Music Manager' }).catch(() => {});
  }, [current]);
  // Remember the position every few seconds and when the page goes away.
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    let last = 0;
    const save = () => {
      const c = currentRef.current;
      if (c && !c.radio && a.currentTime > 0) store.set('resume', { uid: c.uid, t: Math.floor(a.currentTime) });
    };
    const tick = () => {
      if (Date.now() - last > 3000) {
        last = Date.now();
        save();
      }
    };
    const hidden = () => document.visibilityState === 'hidden' && save();
    a.addEventListener('timeupdate', tick);
    a.addEventListener('pause', save);
    a.addEventListener('seeked', save);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      a.removeEventListener('timeupdate', tick);
      a.removeEventListener('pause', save);
      a.removeEventListener('seeked', save);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  // Ambient colour + Media Session.
  useEffect(() => {
    if (!current) return;
    const art = coverUrl(current.pid, current.coverArt, 300);
    if (settings?.appearance?.graphics !== false) dominantColor(art).then((c) => c && document.documentElement.style.setProperty('--ambient', c));
    if ('mediaSession' in navigator) {
      // Several sizes: phones, the Windows / macOS overlay and car displays each pick one.
      const artwork = current.coverArt ? [96, 192, 256, 512].map((n) => ({ src: new URL(coverUrl(current.pid, current.coverArt, n), location.href).href, sizes: `${n}x${n}` })) : [{ src: new URL('/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
      navigator.mediaSession.metadata = new MediaMetadata({ title: current.title || current.name || 'Unknown song', artist: current.artist || '', album: current.album || (current.radio ? 'Radio' : ''), artwork });
    }
    document.title = `${current.title}${current.artist ? ` · ${current.artist}` : ''}`;
  }, [current, settings?.appearance?.graphics]);

  const next = useCallback(
    (auto = false) => {
      if (!queue.length) return;
      if (auto && repeat === 'one') {
        audio.current.currentTime = 0;
        audio.current.play();
        return;
      }
      let n;
      const trashed = (i) => {
        const q = queue[i];
        if (!q || !extras.trashBin) return false;
        return trash.songs.includes(`${q.title}|${q.artist}`) || trash.artists.some((a) => (q.artist || '').toLowerCase().includes(a.toLowerCase()));
      };
      if (shuffle) {
        if (extras.trueShuffle) {
          if (!order.current.length || order.current.length !== queue.length) {
            order.current = queue.map((_, i) => i).filter((i) => i !== index);
            for (let i = order.current.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [order.current[i], order.current[j]] = [order.current[j], order.current[i]];
            }
          }
          n = order.current.shift() ?? 0;
        } else {
          n = Math.floor(Math.random() * queue.length);
          if (queue.length > 1 && n === index) n = (n + 1) % queue.length;
        }
      } else n = index + 1;
      for (let guard = 0; guard < queue.length && trashed(n) && n < queue.length; guard++) n = shuffle ? Math.floor(Math.random() * queue.length) : n + 1;
      if (n >= queue.length) {
        if (repeat === 'all' || !auto) n = 0;
        else {
          setPlaying(false);
          return;
        }
      }
      wantPlay.current = true;
      setIndex(n);
    },
    [queue, index, shuffle, repeat, extras.trueShuffle, extras.trashBin, trash],
  );
  const prev = useCallback(() => {
    if (audio.current.currentTime > 4) {
      audio.current.currentTime = 0;
      return;
    }
    wantPlay.current = true;
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // The countdown for songs that can't play.
  useEffect(() => {
    if (skipIn == null) return;
    if (skipIn <= 0) {
      setSkipIn(null);
      setError(null);
      next(true);
      return;
    }
    const t = setTimeout(() => {
      setSkipIn((x) => (x == null ? null : x - 1));
      setError(`This song can’t be played right now (the server or file isn’t available). Skipping in ${skipIn - 1} s.`);
    }, 1000);
    return () => clearTimeout(t);
  }, [skipIn, next]);
  useEffect(() => {
    setSkipIn(null);
  }, [current?.uid]);

  // Audio element events.
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const on = {
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      timeupdate: () => {
        setTime(a.currentTime);
        const ex = extrasRef.current;
        if (ex.loop && ex.loop.b > ex.loop.a && a.currentTime >= ex.loop.b) a.currentTime = ex.loop.a;
        const d0 = a.duration || 0;
        if (ex.skipOutro > 0 && d0 > ex.skipOutro + 20 && a.currentTime >= d0 - ex.skipOutro) next(true);
        // Crossfade: fade out the last seconds, fade the next song in (see 'play').
        if (ex.crossfade > 0 && d0 > ex.crossfade * 3) {
          const left = d0 - a.currentTime;
          a.volume = (mutedRef.current ? 0 : volRef.current ** 2) * (left < ex.crossfade ? Math.max(0, left / ex.crossfade) : Math.min(1, a.currentTime / Math.max(0.5, ex.crossfade / 2)));
        }
        if (ex.sleepAt && Date.now() >= ex.sleepAt) {
          a.pause();
          setExtrasState((x) => ({ ...x, sleepAt: null }));
        }
        const cur = queue[index];
        if (!cur || cur.radio || scrobbled.current.has(cur.uid)) return;
        const d = a.duration || cur.duration || 0;
        const at = (settings?.player?.scrobbleAt ?? 50) / 100;
        if (d > 30 && (a.currentTime >= d * at || a.currentTime >= 240)) {
          scrobbled.current.add(cur.uid);
          post(`p/${cur.pid}/scrobble`, { key: streamKey(cur), submission: true, time: Date.now() - a.currentTime * 1000, song: { title: cur.title, artist: cur.artist, album: cur.album, duration: d } }).catch(() => {});
        }
      },
      durationchange: () => Number.isFinite(a.duration) && setDuration(a.duration),
      waiting: () => setBuffering(true),
      playing: () => {
        setBuffering(false);
        setError(null);
      },
      canplay: () => setBuffering(false),
      ended: () => {
        if (extrasRef.current.sleepAfterSong) {
          setExtrasState((x) => ({ ...x, sleepAfterSong: false }));
          setPlaying(false);
          return;
        }
        next(true);
      },
      error: () => {
        setBuffering(false);
        // Try twice more (servers wake up, networks blip), then skip after 5 s.
        const cur = queue[index];
        const n = (retries.current.get(cur?.uid) || 0) + 1;
        retries.current.set(cur?.uid, n);
        if (cur && n <= 2) {
          setError(`Trying again… (${n} of 2)`);
          setTimeout(() => {
            if (queue[index]?.uid !== cur.uid) return;
            a.src = `${cur.radio || `/api/p/${cur.pid}/stream/${encodeURIComponent(streamKey(cur))}`}${cur.radio ? '' : `?retry=${n}`}`;
            if (wantPlay.current) a.play().catch(() => {});
          }, 1500 * n);
          return;
        }
        setSkipIn(5);
        setError('This song can’t be played right now (the server or file isn’t available). Skipping in 5 s.');
      },
      loadedmetadata: () => {
        setSource(null);
        const ex = extrasRef.current;
        if (ex.skipIntro > 0 && a.duration > ex.skipIntro + 20 && a.currentTime < 1) a.currentTime = ex.skipIntro;
        a.playbackRate = ex.rate || 1;
        a.preservesPitch = ex.keepPitch !== false;
      },
    };
    for (const [k, fn] of Object.entries(on)) a.addEventListener(k, fn);
    return () => {
      for (const [k, fn] of Object.entries(on)) a.removeEventListener(k, fn);
    };
  }, [queue, index, next, settings?.player?.scrobbleAt]);

  const extrasRef = useRef(extras);
  extrasRef.current = extras;
  const volRef = useRef(volume);
  volRef.current = volume;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  useEffect(() => {
    if (audio.current) audio.current.volume = muted ? 0 : volume ** 2;
  }, [volume, muted]);
  useEffect(() => {
    if (!audio.current) return;
    audio.current.playbackRate = extras.rate || 1;
    audio.current.preservesPitch = extras.keepPitch !== false;
  }, [extras.rate, extras.keepPitch]);

  const ensureAnalyser = useCallback(() => {
    if (analyser.current || !audio.current) return analyser.current;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaElementSource(audio.current);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.82;
      // source → 10-band EQ → leveller → (mono) → analyser → speakers
      eq.current = EQ_FREQS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        b.gain.value = 0;
        return b;
      });
      comp.current = ctx.createDynamicsCompressor();
      splitter.current = ctx.createGain();
      let node = src;
      for (const b of eq.current) {
        node.connect(b);
        node = b;
      }
      node.connect(comp.current);
      comp.current.connect(splitter.current);
      splitter.current.connect(an);
      an.connect(ctx.destination);
      ctxRef.current = ctx;
      analyser.current = an;
    } catch {}
    applyGraph();
    return analyser.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyGraph = useCallback(() => {
    const ex = extrasRef.current;
    eq.current.forEach((b, i) => (b.gain.value = ex.eqOn ? ex.eq?.[i] || 0 : 0));
    if (comp.current) {
      // "Off" = a compressor that does nothing.
      comp.current.threshold.value = ex.leveller ? -24 : 0;
      comp.current.ratio.value = ex.leveller ? 4 : 1;
      comp.current.knee.value = ex.leveller ? 20 : 0;
    }
    if (splitter.current) {
      splitter.current.channelCountMode = ex.mono ? 'explicit' : 'max';
      splitter.current.channelCount = ex.mono ? 1 : 2;
    }
  }, []);
  useEffect(() => {
    if (extras.eqOn || extras.leveller || extras.mono) ensureAnalyser();
    applyGraph();
  }, [extras.eqOn, extras.eq, extras.leveller, extras.mono, ensureAnalyser, applyGraph]);

  const play = useCallback(() => {
    wantPlay.current = true;
    ctxRef.current?.resume?.();
    audio.current?.play().catch((e) => e.name !== 'AbortError' && setError(e.message));
  }, []);
  const pause = useCallback(() => {
    wantPlay.current = false;
    audio.current?.pause();
  }, []);
  const toggle = useCallback(() => (audio.current?.paused ? play() : pause()), [play, pause]);
  const seek = useCallback((t) => {
    if (audio.current) audio.current.currentTime = t;
  }, []);

  /** Replace the queue and start at `start`. */
  const playList = useCallback(
    (songs, start = 0, pid) => {
      const items = songs.filter(Boolean).map((s) => toQueueItem(s, pid));
      if (!items.length) return;
      loadedUid.current = null;
      wantPlay.current = true;
      setQueue(items);
      setIndex(Math.min(start, items.length - 1));
      ctxRef.current?.resume?.();
    },
    [],
  );
  const addToQueue = useCallback(
    (songs, pid, { nextUp = false } = {}) => {
      const items = songs.map((s) => toQueueItem(s, pid));
      setQueue((q) => (nextUp ? [...q.slice(0, index + 1), ...items, ...q.slice(index + 1)] : [...q, ...items]));
      toast(`${items.length === 1 ? `“${items[0].title}”` : `${items.length} songs`} ${nextUp ? 'play next' : 'added to the queue'}`);
    },
    [index, toast],
  );
  const removeAt = useCallback(
    (i) => {
      setQueue((q) => q.filter((_, j) => j !== i));
      if (i < index) setIndex((x) => x - 1);
    },
    [index],
  );
  const move = useCallback(
    (from, to) => {
      setQueue((q) => {
        const c = q.slice();
        const [x] = c.splice(from, 1);
        c.splice(to, 0, x);
        return c;
      });
      setIndex((cur) => (cur === from ? to : from < cur && to >= cur ? cur - 1 : from > cur && to <= cur ? cur + 1 : cur));
    },
    [],
  );
  const clear = useCallback(() => {
    pause();
    setQueue((q) => q.slice(index, index + 1));
    setIndex(0);
  }, [index, pause]);
  const jump = useCallback((i) => {
    wantPlay.current = true;
    setIndex(i);
  }, []);

  // Media keys, headset buttons, the lock screen and the OS media overlay.
  const media = useRef({});
  media.current = { play, pause, next, prev, seek, time, duration, playing };
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const m = () => media.current;
    const handlers = {
      play: () => m().play(),
      pause: () => m().pause(),
      stop: () => {
        m().pause();
        m().seek(0);
      },
      nexttrack: () => m().next(),
      previoustrack: () => m().prev(),
      seekto: (e) => m().seek(Math.max(0, e.seekTime)),
      seekbackward: (e) => m().seek(Math.max(0, (audio.current?.currentTime || 0) - (e.seekOffset || 10))),
      seekforward: (e) => m().seek(Math.min(m().duration || Infinity, (audio.current?.currentTime || 0) + (e.seekOffset || 10))),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try {
        ms.setActionHandler(action, fn);
      } catch {} // not every browser knows every action
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          ms.setActionHandler(action, null);
        } catch {}
      }
    };
  }, []);
  // Tell the system whether we play, and where we are (its progress bar and scrubbing).
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = !current ? 'none' : playing ? 'playing' : 'paused';
  }, [current, playing]);
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms?.setPositionState) return;
    const a = audio.current;
    const sync = () => {
      try {
        if (current && Number.isFinite(a.duration) && a.duration > 0) ms.setPositionState({ duration: a.duration, position: Math.min(a.currentTime, a.duration), playbackRate: a.playbackRate || 1 });
        else ms.setPositionState();
      } catch {}
    };
    const evs = ['loadedmetadata', 'durationchange', 'seeked', 'ratechange', 'play', 'pause'];
    for (const ev of evs) a.addEventListener(ev, sync);
    sync();
    return () => {
      for (const ev of evs) a.removeEventListener(ev, sync);
    };
  }, [current]);
  // Media keys on keyboards in browsers without the Media Session API.
  useEffect(() => {
    if ('mediaSession' in navigator) return;
    const onKey = (e) => {
      const m = media.current;
      if (e.key === 'MediaPlayPause') m.playing ? m.pause() : m.play();
      else if (e.key === 'MediaTrackNext') m.next();
      else if (e.key === 'MediaTrackPrevious') m.prev();
      else if (e.key === 'MediaStop') m.pause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keyboard: space, ←/→ (seek), shift+←/→ (prev/next), m (mute).
  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowRight' && e.shiftKey) next();
      else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
      else if (e.key === 'ArrowRight' && (e.altKey || e.metaKey)) seek(Math.min(duration, time + 10));
      else if (e.key === 'ArrowLeft' && (e.altKey || e.metaKey)) seek(Math.max(0, time - 10));
      else if (e.key === 'm' && !e.ctrlKey) setMuted((m) => !m);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, next, prev, seek, time, duration]);

  const value = useMemo(
    () => ({
      audio: audio.current, queue, index, current, playing, time, duration, buffering, volume, muted, shuffle, repeat, source, error,
      play, pause, toggle, seek, next: () => next(), prev, playList, addToQueue, removeAt, move, clear, jump,
      setVolume: setVolumeState, setMuted, setShuffle, setRepeat, ensureAnalyser, analyser,
      extras, setExtras, trash, setTrash, bookmarks, setBookmarks, skipIn, cancelSkip: () => { setSkipIn(null); setError('Stopped skipping. Press next to move on.'); },
    }),
    [queue, index, current, playing, time, duration, buffering, volume, muted, shuffle, repeat, source, error, play, pause, toggle, seek, next, prev, playList, addToQueue, removeAt, move, clear, jump, ensureAnalyser, extras, setExtras, trash, bookmarks, skipIn],
  );
  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}
