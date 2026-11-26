// Fetching addresses people type in (cover URLs, direct downloads): public
// addresses only (no SSRF into the LAN), checked redirects, size and time caps.
import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || v.startsWith('fe80') || v.startsWith('ff');
}

export async function checkUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error('That is not a valid address'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Only http and https addresses work'), { status: 400 });
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length) throw Object.assign(new Error(`Can't find ${host}`), { status: 400 });
  if (ips.some(isPrivate)) throw Object.assign(new Error('Addresses in your local network are blocked here'), { status: 400 });
  return u;
}

export async function safeFetch(raw, { maxBytes = 50 * 1024 * 1024, timeout = 30000, allowPrivate = false, headers = {} } = {}) {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    await checkUrl(url, { allowPrivate });
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'MasterMusicManager', ...headers } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = new URL(r.headers.get('location'), url).href;
      continue;
    }
    if (!r.ok) throw Object.assign(new Error(`The address answered ${r.status}`), { status: 502 });
    const len = Number(r.headers.get('content-length') || 0);
    if (len > maxBytes) throw Object.assign(new Error('The file is too big'), { status: 413 });
    const chunks = [];
    let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > maxBytes) throw Object.assign(new Error('The file is too big'), { status: 413 });
      chunks.push(c);
    }
    return { body: Buffer.concat(chunks), type: r.headers.get('content-type')?.split(';')[0], url, name: nameFrom(r, url) };
  }
  throw Object.assign(new Error('Too many redirects'), { status: 400 });
}

function nameFrom(r, url) {
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  if (m) return decodeURIComponent(m[1] || m[2]);
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
  } catch {
    return 'download';
  }
}
