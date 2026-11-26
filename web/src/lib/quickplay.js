import { get } from './api.js';

const shuffle = (l) => {
  const c = l.slice();
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};

const localTrack = (t) => ({ id: `l:${t.id}`, localId: t.id, remoteId: t.remoteId, title: t.title || t.filename, artist: t.artist, album: t.album, duration: t.duration, coverArt: t.cover ? `l:${t.id}` : null });

/** Turn a Quick play pin into songs. */
export async function resolvePin(pin, pid, caps) {
  switch (pin.type) {
    case 'shuffle':
      return get(`p/${pid}/random`, { size: 400 });
    case 'recent': {
      if (caps.files) return (await get(`p/${pid}/tracks`, { sort: '-added', limit: 200 })).tracks.map(localTrack);
      const albums = await get(`p/${pid}/albums`, { type: 'newest', size: 12 });
      const all = [];
      for (const a of albums) all.push(...((await get(`p/${pid}/albums/${encodeURIComponent(a.id)}`).catch(() => null))?.songs || []));
      return all;
    }
    case 'favorites':
      return shuffle((await get(`p/${pid}/starred`)).songs || []);
    case 'forgotten': {
      const fav = (await get(`p/${pid}/starred`).catch(() => ({ songs: [] }))).songs || [];
      const old = fav.filter((s) => !s.played || Date.now() - Date.parse(s.played) > 60 * 86400e3);
      return shuffle(old.length ? old : fav.length ? fav : await get(`p/${pid}/random`, { size: 200 }));
    }
    case 'genre':
      return get(`p/${pid}/random`, { size: 300, genre: pin.name });
    case 'album':
      return (await get(`p/${pid}/albums/${encodeURIComponent(pin.id)}`)).songs || [];
    case 'playlist':
      return (await get(`p/${pid}/playlists/${encodeURIComponent(pin.id)}`)).songs || [];
    case 'artist': {
      const a = await get(`p/${pid}/artists/${encodeURIComponent(pin.id)}`);
      if (a.top?.length && String(pin.id).startsWith('lr:')) return shuffle(a.top);
      const all = [];
      for (const al of a.albums || []) all.push(...((await get(`p/${pid}/albums/${encodeURIComponent(al.id)}`).catch(() => null))?.songs || []));
      return shuffle(all.length ? all : a.top || []);
    }
    case 'filter':
      return shuffle((await get(`p/${pid}/tracks`, { q: pin.query, limit: 1000 })).tracks.map(localTrack));
    default:
      return [];
  }
}
