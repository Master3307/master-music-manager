import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, get, events } from './api.js';
import { applyAppearance, setThemes } from './theme.js';
import { store } from './util.js';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

/**
 * What the current library can do, so every page shows what makes sense:
 *  local   – a folder only: files, tags, organizing, no favorites / radio
 *  service – a server only: playing, playlists, favorites; editing needs a folder
 *  linked  – both: everything
 */
export function capsOf(profile) {
  if (!profile) return { mode: 'none' };
  const f = profile.features || {};
  const hasFolder = Boolean(profile.localPath);
  const hasService = Boolean(f.service);
  const online = hasService ? profile.status?.online !== false : null;
  return {
    mode: hasFolder && hasService ? 'linked' : hasFolder ? 'local' : 'service',
    files: hasFolder,
    service: hasService,
    online,
    offline: hasService && profile.status?.online === false,
    playlists: true,
    favorites: hasService && f.favorites,
    ratings: hasService && f.ratings,
    radio: hasService && f.radio,
    shares: true,
    serviceShares: hasService && f.shares,
    smart: hasFolder && (f.smart || !hasService),
    podcasts: hasService && f.podcasts,
    scan: hasService && f.scan,
    fullScan: hasService && f.fullScan,
    plugin: Boolean(f.plugin),
    kind: profile.kind,
    kindLabel: profile.kindLabel,
  };
}

export function AppProvider({ children }) {
  const [me, setMe] = useState(null);
  const [settings, setSettings] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [pid, setPidState] = useState(() => store.get('profile', null));
  const [toasts, setToasts] = useState([]);
  const [jobs, setJobs] = useState({});
  const [logs, setLogs] = useState({});
  const [themes, setThemeList] = useState([]);
  const [fields, setFields] = useState(null);
  const [ready, setReady] = useState(false);
  const [update, setUpdate] = useState(null);
  const jobWaiters = useRef(new Map());

  const toast = useCallback((msg, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    const t = { id, msg, kind: opts.kind || 'ok', action: opts.action };
    setToasts((x) => [...x.slice(-3), t]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), opts.ms || (t.kind === 'error' ? 7000 : 3800));
  }, []);
  const fail = useCallback((e) => toast(e?.message || String(e), { kind: 'error' }), [toast]);

  const loadMe = useCallback(async () => {
    const m = await get('auth/me');
    setMe(m);
    return m;
  }, []);
  // Look settings are personal: the admin's choice is the default, and anyone
  // (also people who aren't logged in) can override it for themselves.
  const loadSettings = useCallback(async () => {
    const s = await get('settings');
    const mine = { ...store.get('myLook', {}), ...(me?.user?.prefs?.look || {}) };
    const merged = { ...s, appearance: { ...s.appearance, ...mine }, serverAppearance: s.appearance };
    setSettings(merged);
    applyAppearance(merged.appearance);
    return merged;
  }, [me]);
  const loadProfiles = useCallback(async () => {
    const list = await get('profiles');
    setProfiles(list);
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const m = await loadMe();
        const t = await get('themes').catch(() => []);
        setThemes(t);
        setThemeList(t);
        if (m.user || m.guest) {
          await loadSettings();
          await loadProfiles();
          get('library/fields').then(setFields).catch(() => {});
          get('update').then(setUpdate).catch(() => {});
        }
      } catch (e) {
        console.error(e);
      } finally {
        setReady(true);
      }
    })();
    // Runs once on start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the system's light / dark switch.
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => settings && applyAppearance(settings.appearance);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [settings]);

  // Live jobs.
  useEffect(() => {
    if (!me || (!me.user && !me.guest)) return;
    get('jobs', { limit: 50 })
      .then((list) => setJobs(Object.fromEntries(list.map((j) => [j.id, j]))))
      .catch(() => {});
    // A job reading 2000 files sends thousands of log lines and progress
    // updates; every state change redraws the whole app, so they are
    // collected and applied at most four times a second.
    const batch = { jobs: {}, logs: {}, timer: null };
    const flush = () => {
      batch.timer = null;
      const jobsNow = batch.jobs;
      const logsNow = batch.logs;
      batch.jobs = {};
      batch.logs = {};
      if (Object.keys(jobsNow).length) setJobs((x) => ({ ...x, ...jobsNow }));
      if (Object.keys(logsNow).length)
        setLogs((x) => {
          const next = { ...x };
          for (const [id, text] of Object.entries(logsNow)) next[id] = ((next[id] || '') + text).slice(-200_000);
          return next;
        });
    };
    const later = () => {
      if (!batch.timer) batch.timer = setTimeout(flush, 250);
    };
    const stop = events({
      job: (e) => {
        batch.jobs[e.job.id] = e.job;
        const w = jobWaiters.current.get(e.job.id);
        if (w && !['queued', 'running'].includes(e.job.status)) {
          jobWaiters.current.delete(e.job.id);
          flush(); // finished: show it right away
          w(e.job);
        } else later();
      },
      log: (e) => {
        batch.logs[e.id] = (batch.logs[e.id] || '') + e.text;
        later();
      },
      cleared: () => setJobs((x) => Object.fromEntries(Object.entries(x).filter(([, j]) => ['queued', 'running'].includes(j.status)))),
    });
    return () => {
      clearTimeout(batch.timer);
      stop?.();
    };
  }, [me]);

  /** Resolve when a job ends (for "do X, then refresh"). */
  // A job fetched on its own (when live updates didn't bring it).
  const putJob = useCallback((j) => j?.id && setJobs((x) => (x[j.id]?.status === j.status && x[j.id]?.progress === j.progress && x[j.id]?.detail === j.detail ? x : { ...x, [j.id]: j })), []);
  // Jobs started from the interface: the dock at the bottom shows their progress.
  const [watched, setWatched] = useState([]);
  const unwatch = useCallback((id) => setWatched((w) => w.filter((x) => x !== id)), []);
  const afterJob = useCallback((id) => new Promise((resolve) => {
    setWatched((w) => (w.includes(id) ? w : [...w, id].slice(-8)));
    jobWaiters.current.set(id, resolve);
    get(`jobs/${id}`).then((j) => {
      if (!['queued', 'running'].includes(j.status)) {
        jobWaiters.current.delete(id);
        resolve(j);
      }
    }).catch(() => {});
  }), []);

  const setPid = useCallback((id) => {
    setPidState(id);
    store.set('profile', id);
  }, []);
  const profile = useMemo(() => profiles.find((p) => p.id === pid) || profiles[0] || null, [profiles, pid]);
  const caps = useMemo(() => capsOf(profile), [profile]);

  const saveSetting = useCallback(
    async (key, value, { forEveryone } = {}) => {
      if (key === 'appearance' && !(forEveryone && me?.perms?.includes('manage'))) {
        const mine = { ...store.get('myLook', {}), ...value };
        store.set('myLook', mine);
        if (me?.user) api('account/prefs', { method: 'PUT', body: { look: mine } }).catch(() => {});
        setSettings((s) => {
          const appearance = { ...s.appearance, ...value };
          applyAppearance(appearance);
          return { ...s, appearance };
        });
        return value;
      }
      const v = await api(`settings/${key}`, { method: 'PUT', body: value });
      setSettings((s) => {
        const n = { ...s, [key]: v };
        if (key === 'appearance') {
          n.serverAppearance = v;
          n.appearance = { ...v, ...store.get('myLook', {}) };
          applyAppearance(n.appearance);
        }
        return n;
      });
      return v;
    },
    [me],
  );
  const resetMyLook = useCallback(() => {
    store.set('myLook', {});
    if (me?.user) api('account/prefs', { method: 'PUT', body: { look: {} } }).catch(() => {});
    setSettings((s) => {
      applyAppearance(s.serverAppearance);
      return { ...s, appearance: s.serverAppearance };
    });
  }, [me]);

  const value = {
    ready, me, loadMe, settings, setSettings, loadSettings, saveSetting, resetMyLook, profiles, loadProfiles, profile, pid: profile?.id, setPid, caps,
    toast, fail, toasts, jobs, logs, afterJob, watched, unwatch, putJob, themes, fields, update, setUpdate,
    isAdmin: me?.perms?.includes('manage') || false,
    can: (perm) => Boolean(me?.perms?.includes(perm)),
    listenOnly: Boolean(me?.listenOnly),
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Load data with loading / error state; re-runs when deps change. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const counter = useRef(0);
  const reload = useCallback(() => {
    const n = ++counter.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    return Promise.resolve()
      .then(fn)
      .then((data) => n === counter.current && setState({ data, loading: false, error: null }))
      .catch((error) => n === counter.current && setState((s) => ({ data: s.data, loading: false, error })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

/**
 * One job, always up to date: from the live updates when they come, else
 * asked for every 2 s until it's finished (old jobs after a reload, or a
 * connection that doesn't pass live updates).
 */
export function useJob(id) {
  const { jobs, putJob } = useApp();
  const j = id ? jobs[id] : null;
  const live = !j || ['queued', 'running'].includes(j.status);
  const seen = useRef({ at: 0, key: '' });
  const key = j ? `${j.status}:${j.progress}:${j.detail}` : '';
  if (key !== seen.current.key) seen.current = { at: Date.now(), key };
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!id || !live) return;
    const tick = async () => {
      if (j && Date.now() - seen.current.at < 2500) return; // live updates are arriving
      try {
        putJob(await get(`jobs/${id}`, { tail: 1 }));
      } catch (e) {
        if (/404|not found/i.test(e.message)) setGone(true);
      }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, live]);
  return gone ? { id, status: 'gone', title: '', detail: '' } : j;
}
