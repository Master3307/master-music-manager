// What right-clicking something offers, everywhere in the app.
import { useNavigate } from 'react-router';
import {
  Play, Shuffle, ListPlus, ListEnd, ListMusic, Share2, Pin, User, Disc3, Copy, Pencil, Trash2, ImagePlus, Radio as RadioIcon, ArrowLeft, ArrowRight, RefreshCw, PanelRight,
  Search, Settings, Link2, Heart, SkipForward, Pause, Library, Maximize2, Download,
} from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { get, post, del } from '../lib/api.js';
import { copy } from '../lib/util.js';
import { useCtxMenu, useDialog } from './ui.jsx';
import { AddToPlaylist, ShareDialog } from './Songs.jsx';
import { usePins } from '../lib/pins.js';

async function albumSongs(pid, id) {
  return (await get(`p/${pid}/albums/${encodeURIComponent(id)}`)).songs || [];
}
async function artistSongs(pid, artist) {
  if (String(artist.id).startsWith('lr:')) return (await get(`p/${pid}/artists/${encodeURIComponent(artist.id)}`)).top || [];
  const a = await get(`p/${pid}/artists/${encodeURIComponent(artist.id)}`);
  const all = [];
  for (const al of a.albums || []) all.push(...(await albumSongs(pid, al.id).catch(() => [])));
  return all;
}
const shuffled = (l) => {
  const c = l.slice();
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
};

export function useMenus() {
  const open = useCtxMenu();
  const dialog = useDialog();
  const p = usePlayer();
  const nav = useNavigate();
  const { pid, caps, toast, fail, can } = useApp();
  const pins = usePins();
  const run = (fn) => () => Promise.resolve(fn()).catch(fail);

  const playItems = (load, label) => [
    { label: 'Play', icon: Play, onClick: run(async () => p.playList(await load(), 0, pid)) },
    { label: 'Shuffle', icon: Shuffle, onClick: run(async () => p.playList(shuffled(await load()), 0, pid)) },
    { label: 'Play next', icon: ListPlus, onClick: run(async () => p.addToQueue(await load(), pid, { nextUp: true })) },
    { label: 'Add to the queue', icon: ListEnd, onClick: run(async () => p.addToQueue(await load(), pid)) },
    can('personal') && { label: 'Add to a playlist…', icon: ListMusic, onClick: run(async () => dialog(<AddToPlaylist songs={await load()} pid={pid} />)) },
    label && { label: 'Pin to Quick play', icon: Pin, onClick: () => { pins.add(label); toast('Pinned to Quick play on the home page'); } },
  ];

  return {
    /** Any page's own menu, in the same look: menus.custom(e, 'Heading', [items]). */
    custom: (e, heading, items) => open(e, [heading && { heading }, ...items]),
    album: (e, a) =>
      open(e, [
        { heading: a.name },
        ...playItems(() => albumSongs(pid, a.id), { type: 'album', id: a.id, name: a.name, cover: a.coverArt }),
        'sep',
        { label: 'Open', icon: Disc3, onClick: () => nav(`/album/${encodeURIComponent(a.id)}`) },
        (a.artistId || a.artist) && { label: `Go to ${a.artist}`, icon: User, onClick: () => nav(a.artistId ? `/artist/${encodeURIComponent(a.artistId)}` : `/artists?q=${encodeURIComponent(a.artist)}`) },
        can('share') && { label: 'Share…', icon: Share2, onClick: () => dialog(<ShareDialog kind="album" refData={{ id: a.id }} title={a.name} pid={pid} />) },
        caps.files && can('manage') && { label: 'Edit…', icon: Pencil, hint: 'every song', onClick: () => nav(`/library?q=${encodeURIComponent(`album:"${a.name}"`)}&edit=all`) },
        { label: 'Copy name', icon: Copy, onClick: () => copy(`${a.artist ? `${a.artist} - ` : ''}${a.name}`).then(() => toast('Copied')) },
      ]),
    artist: (e, a) =>
      open(e, [
        { heading: a.name },
        ...playItems(() => artistSongs(pid, a), { type: 'artist', id: a.id, name: a.name, cover: a.coverArt }),
        caps.service && !String(a.id).startsWith('lr:') && { label: 'Artist radio (similar songs)', icon: RadioIcon, onClick: run(async () => { const top = await artistSongs(pid, a); const sim = top[0] ? await get(`p/${pid}/similar/${encodeURIComponent(top[0].id)}`).catch(() => []) : []; p.playList(sim.length ? sim : shuffled(top), 0, pid); }) },
        'sep',
        { label: 'Open', icon: User, onClick: () => nav(`/artist/${encodeURIComponent(a.id)}`) },
        can('manage') && { label: 'Edit…', icon: Pencil, hint: 'picture, about', onClick: () => nav(`/artist/${encodeURIComponent(a.id)}?edit=1`) },
        can('share') && { label: 'Share…', icon: Share2, onClick: () => dialog(<ShareDialog kind="artist" refData={{ id: a.id }} title={a.name} pid={pid} />) },
        caps.files && { label: 'All songs in the library', icon: Library, onClick: () => nav(`/library?q=${encodeURIComponent(`artist:"${a.name}"`)}`) },
        { label: 'Copy name', icon: Copy, onClick: () => copy(a.name).then(() => toast('Copied')) },
      ]),
    playlist: (e, pl, { onChanged } = {}) =>
      open(e, [
        { heading: pl.name },
        ...playItems(async () => (await get(`p/${pid}/playlists/${encodeURIComponent(pl.id)}`)).songs || [], { type: 'playlist', id: pl.id, name: pl.name, cover: pl.coverArt }),
        'sep',
        { label: 'Open', icon: ListMusic, onClick: () => nav(`/playlist/${encodeURIComponent(pl.id)}`) },
        !pl.smart && can('personal') && { label: 'Edit…', icon: Pencil, hint: 'name, description', onClick: () => nav(`/playlist/${encodeURIComponent(pl.id)}?edit=1`) },
        pl.smart && can('manage') && { label: 'Edit the rules…', icon: Pencil, onClick: () => nav('/smart') },
        can('share') && { label: 'Share…', icon: Share2, onClick: () => dialog(<ShareDialog kind="playlist" refData={{ id: pl.id }} title={pl.name} pid={pid} />) },
        !pl.smart && can('personal') && { label: 'Delete', icon: Trash2, danger: true, onClick: run(async () => { if (!confirm(`Delete “${pl.name}”? The songs stay.`)) return; await del(`p/${pid}/playlists/${encodeURIComponent(pl.id)}`); toast('Deleted'); onChanged?.(); }) },
      ]),
    genre: (e, g) =>
      open(e, [
        { heading: g.name },
        { label: 'Shuffle this genre', icon: Shuffle, onClick: run(async () => p.playList(await get(`p/${pid}/random`, { size: 200, genre: g.name }), 0, pid)) },
        { label: 'Pin to Quick play', icon: Pin, onClick: () => { pins.add({ type: 'genre', name: g.name }); toast('Pinned'); } },
        { label: 'Show its albums', icon: Disc3, onClick: () => nav(`/albums?genre=${encodeURIComponent(g.name)}`) },
        caps.files && can('manage') && { label: 'Edit…', icon: Pencil, hint: 'rename everywhere', onClick: () => nav(`/library?q=${encodeURIComponent(`genre="${g.name}"`)}&cmd=${encodeURIComponent(`replace genre "${g.name}" "${g.name}"`)}`) },
        { label: 'Copy name', icon: Copy, onClick: () => copy(g.name).then(() => toast('Copied')) },
      ]),
    queueItem: (e, q, i) =>
      open(e, [
        { heading: q.title },
        { label: 'Play now', icon: Play, onClick: () => p.jump(i) },
        { label: 'Play next', icon: SkipForward, onClick: () => p.move(i, p.index + (i > p.index ? 1 : 0)) },
        { label: 'Remove from the queue', icon: Trash2, onClick: () => p.removeAt(i) },
        q.localId && caps.files && can('manage') && { label: 'Edit…', icon: Pencil, onClick: () => nav(`/library?ids=${q.localId}&edit=1`) },
        'sep',
        q.albumId && { label: 'Go to the album', icon: Disc3, onClick: () => nav(`/album/${encodeURIComponent(q.albumId)}`) },
        q.artistId && { label: 'Go to the artist', icon: User, onClick: () => nav(`/artist/${encodeURIComponent(q.artistId)}`) },
        { label: 'Never play this (trash bin)', icon: Trash2, onClick: () => { p.setTrash({ ...p.trash, songs: [...new Set([...p.trash.songs, `${q.title}|${q.artist}`])] }); p.removeAt(i); } },
        { label: 'Clear everything after this', icon: ListEnd, onClick: () => p.queue.slice(i + 1).forEach(() => p.removeAt(i + 1)) },
      ]),
    nowPlaying: (e, { onFull, onHide } = {}) =>
      open(e, [
        p.current && { heading: p.current.title },
        { label: p.playing ? 'Pause' : 'Play', icon: p.playing ? Pause : Play, onClick: p.toggle },
        { label: 'Next', icon: SkipForward, onClick: p.next },
        onFull && { label: 'Full screen', icon: Maximize2, onClick: onFull },
        p.current?.artistId && { label: 'Go to the artist', icon: User, onClick: () => nav(`/artist/${encodeURIComponent(p.current.artistId)}`) },
        p.current?.albumId && { label: 'Go to the album', icon: Disc3, onClick: () => nav(`/album/${encodeURIComponent(p.current.albumId)}`) },
        p.current && { label: 'Copy “Artist - Title”', icon: Copy, onClick: () => copy(`${p.current.artist || ''} - ${p.current.title}`).then(() => toast('Copied')) },
        p.current?.localId && caps.files && can('manage') && { label: 'Edit…', icon: Pencil, onClick: () => nav(`/library?ids=${p.current.localId}&edit=1`) },
        onHide && 'sep',
        onHide && { label: 'Hide the player', icon: PanelRight, onClick: onHide },
      ]),
    background: (e) => {
      // Text fields, links and selected text keep the browser's menu.
      if (e.target.closest('input, textarea, [contenteditable], a[href]') || String(window.getSelection())) return;
      open(e, [
        { label: 'Back', icon: ArrowLeft, onClick: () => history.back() },
        { label: 'Forward', icon: ArrowRight, onClick: () => history.forward() },
        { label: 'Reload', icon: RefreshCw, onClick: () => location.reload() },
        'sep',
        p.current && { label: p.playing ? 'Pause' : 'Play', icon: p.playing ? Pause : Play, onClick: p.toggle },
        { label: 'Shuffle everything', icon: Shuffle, onClick: run(async () => p.playList(await get(`p/${pid}/random`, { size: 300 }), 0, pid)) },
        { label: 'Search', icon: Search, hint: 'Ctrl K', onClick: () => document.querySelector('.topbar .searchbar input')?.focus() },
        'sep',
        { label: 'Copy the address of this page', icon: Link2, onClick: () => copy(location.href).then(() => toast('Copied')) },
        { label: 'Settings', icon: Settings, onClick: () => nav('/settings') },
        { label: 'Right-click again here for the browser’s menu', disabled: true },
      ]);
    },
  };
}

export { Heart, ImagePlus, Download, post };
