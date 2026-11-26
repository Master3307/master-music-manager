// Small fetch wrapper: JSON in and out, the CSRF header on every change, and
// readable errors (the server always answers { error }).
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || {};
  }
}

export async function api(path, { method = 'GET', body, query, raw, headers, signal } = {}) {
  let url = path.startsWith('/') ? path : `/api/${path}`;
  if (query) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if ([...q].length) url += `${url.includes('?') ? '&' : '?'}${q}`;
  }
  const isBlob = body instanceof Blob || body instanceof ArrayBuffer;
  let res;
  try {
    res = await fetch(url, {
      method,
      signal,
      credentials: 'same-origin',
      headers: { 'X-MMM': '1', ...(body && !isBlob && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isBlob || typeof body === 'string' ? body : JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Master Music Manager can’t be reached. Is it still running?', 0);
  }
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new ApiError(data?.error || (typeof data === 'string' && data) || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const get = (p, query) => api(p, { query });
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const put = (p, body) => api(p, { method: 'PUT', body: body ?? {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body: body ?? {} });
export const del = (p, query) => api(p, { method: 'DELETE', query });

/** Download a POST response as a file (exports, backups). */
export async function download(path, body, fallbackName = 'download') {
  const res = await api(path, { method: 'POST', body, raw: true });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new ApiError(e.error || 'Download failed', res.status);
  }
  const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/)?.[1] || fallbackName;
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = decodeURIComponent(name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Upload one file. Up to 50 MB in one request, bigger files in parts the
 * server tells us about (32 MB). A failed part is retried from what the
 * server confirmed it has. onProgress(0..1).
 */
export async function uploadFile(file, { relativePath, onProgress, signal } = {}) {
  const start = await post('uploads', { name: file.name, size: file.size, relativePath: relativePath || file.webkitRelativePath || '' });
  const { id, chunkSize } = start;
  let offset = 0;
  let tries = 0;
  while (offset < file.size || file.size === 0) {
    if (signal?.aborted) {
      await del(`uploads/${id}`).catch(() => {});
      throw new DOMException('Cancelled', 'AbortError');
    }
    const part = file.slice(offset, Math.min(file.size, offset + chunkSize));
    try {
      const r = await sendPart(`/api/uploads/${id}?offset=${offset}`, part, (loaded) => onProgress?.((offset + loaded) / Math.max(1, file.size)), signal);
      offset = r.received;
      tries = 0;
      if (r.done || file.size === 0) break;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (++tries > 4) throw e;
      await new Promise((res) => setTimeout(res, 800 * tries));
      const st = await get(`uploads/${id}`).catch(() => null);
      if (st) offset = st.received;
    }
  }
  onProgress?.(1);
  return id;
}

function sendPart(url, blob, onLoaded, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('X-MMM', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status})`, xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError('The connection dropped during the upload', 0));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
    xhr.send(blob);
  });
}

/** Live events: job progress, job logs, app log lines. Reconnects by itself. */
export function events(handlers) {
  let es;
  let closed = false;
  let retry;
  const open = () => {
    es = new EventSource('/api/events');
    for (const [type, fn] of Object.entries(handlers)) es.addEventListener(type, (e) => fn(JSON.parse(e.data)));
    es.onerror = () => {
      es.close();
      if (!closed) retry = setTimeout(open, 3000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}

/** Resolve when a job is done (or failed). */
export async function waitJob(id, onUpdate) {
  for (;;) {
    const j = await get(`jobs/${id}`, { tail: 1 });
    onUpdate?.(j);
    if (!['queued', 'running'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 800));
  }
}
