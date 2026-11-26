// Adding music runs in the background for the whole app: uploads keep going
// while you browse, and the Add page only shows this shared queue.
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { post, uploadFile } from './api.js';
import { store } from './util.js';

const Ctx = createContext(null);
export const useAdding = () => useContext(Ctx);

export function AddingProvider({ children }) {
  const [uploads, setUploads] = useState([]);
  const [jobIds, setJobIds] = useState(() => store.get('addJobs', []));
  const [draft, setDraftState] = useState(() => store.get('addDraft', ''));
  const running = useRef(0);
  const queue = useRef([]);

  const addJobs = useCallback((ids) => {
    setJobIds((j) => {
      const next = [...ids, ...j].slice(0, 40);
      store.set('addJobs', next);
      return next;
    });
  }, []);
  const setDraft = useCallback((v) => {
    setDraftState(v);
    store.set('addDraft', v);
  }, []);
  const forgetJobs = useCallback(() => {
    setJobIds([]);
    store.set('addJobs', []);
  }, []);

  const pump = useCallback((target) => {
    while (running.current < 3 && queue.current.length) {
      const it = queue.current.shift();
      running.current++;
      const upd = (patch) => setUploads((u) => u.map((x) => (x.key === it.key ? { ...x, ...patch } : x)));
      upd({ state: 'uploading' });
      (async () => {
        try {
          const id = await uploadFile(it.file, { relativePath: it.rel, onProgress: (p) => upd({ progress: p }) });
          const r = await post(`uploads/${id}/finish`, { profileId: it.target || target });
          upd({ state: 'reading', job: r.job, progress: 1 });
          addJobs([r.job]);
        } catch (e) {
          upd({ state: 'failed', error: e.message });
        } finally {
          running.current--;
          pump(target);
        }
      })();
    }
  }, [addJobs]);

  const addFiles = useCallback(
    (files, target) => {
      const items = [...files].map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, file: f, name: f.name, size: f.size, rel: f.webkitRelativePath || f.relPath || '', progress: 0, state: 'waiting', target }));
      if (!items.length) return;
      setUploads((u) => [...items, ...u]);
      queue.current.push(...items);
      pump(target);
    },
    [pump],
  );
  const clearUploads = useCallback(() => setUploads((u) => u.filter((x) => !['reading', 'failed'].includes(x.state))), []);
  const busy = uploads.some((u) => ['waiting', 'uploading'].includes(u.state));

  // Leaving the page while uploading would cut them off: ask first.
  if (typeof window !== 'undefined') window.onbeforeunload = busy ? () => 'Uploads are still running' : null;

  return <Ctx.Provider value={{ uploads, addFiles, clearUploads, jobIds, addJobs, forgetJobs, draft, setDraft, busy }}>{children}</Ctx.Provider>;
}
