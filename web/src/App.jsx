import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate, Link } from 'react-router';
import { useApp } from './lib/app.jsx';
import { usePlayer } from './lib/player.jsx';
import { Topbar, Rail, SubNav, Toasts, useInboxCount } from './components/Shell.jsx';
import { Deck, Capsule } from './components/Deck.jsx';
import { TourOffer } from './components/Tour.jsx';
import { Spinner } from './components/ui.jsx';
import { store, cx } from './lib/util.js';
import { get } from './lib/api.js';
import { useMenus } from './components/menus.jsx';
import { Shortcuts } from './components/Shortcuts.jsx';

const page = (f) => lazy(f);
const Login = page(() => import('./pages/Login.jsx'));
const Setup = page(() => import('./pages/Setup.jsx'));
const Home = page(() => import('./pages/Home.jsx'));
const SearchPage = page(() => import('./pages/Search.jsx'));
const Albums = page(() => import('./pages/Browse.jsx').then((m) => ({ default: m.Albums })));
const Album = page(() => import('./pages/Browse.jsx').then((m) => ({ default: m.Album })));
const Artists = page(() => import('./pages/Browse.jsx').then((m) => ({ default: m.Artists })));
const Artist = page(() => import('./pages/Artist.jsx'));
const Genres = page(() => import('./pages/Browse.jsx').then((m) => ({ default: m.Genres })));
const Folders = page(() => import('./pages/Browse.jsx').then((m) => ({ default: m.Folders })));
const Favorites = page(() => import('./pages/Browse.jsx').then((m) => ({ default: m.Favorites })));
const Radio = page(() => import('./pages/Browse.jsx').then((m) => ({ default: m.Radio })));
const Playlists = page(() => import('./pages/Playlists.jsx').then((m) => ({ default: m.Playlists })));
const Playlist = page(() => import('./pages/Playlists.jsx').then((m) => ({ default: m.Playlist })));
const SmartPlaylists = page(() => import('./pages/Smart.jsx'));
const Library = page(() => import('./pages/Library.jsx'));
const Duplicates = page(() => import('./pages/Duplicates.jsx'));
const Organize = page(() => import('./pages/Tools.jsx').then((m) => ({ default: m.Organize })));
const ExportPage = page(() => import('./pages/Tools.jsx').then((m) => ({ default: m.Export })));
const Trash = page(() => import('./pages/Tools.jsx').then((m) => ({ default: m.Trash })));
const Add = page(() => import('./pages/Add.jsx'));
const InboxPage = page(() => import('./pages/Inbox.jsx'));
const Stats = page(() => import('./pages/Stats.jsx').then((m) => ({ default: m.Listening })));
const LibraryStats = page(() => import('./pages/Stats.jsx').then((m) => ({ default: m.LibraryStats })));
const Wrapped = page(() => import('./pages/Wrapped.jsx'));
const Scrobbles = page(() => import('./pages/Scrobbles.jsx'));
const Shares = page(() => import('./pages/Shares.jsx'));
const Everywhere = page(() => import('./pages/Everywhere.jsx'));
const Settings = page(() => import('./pages/settings/Settings.jsx'));

function Loading() {
  return (
    <div className="deck-idle" style={{ minHeight: 240 }}>
      <Spinner />
    </div>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const p = usePlayer();
  const [deck, setDeck] = useState(() => store.get('deck', innerWidth > 1180));
  const inbox = useInboxCount();
  const menus = useMenus();
  useEffect(() => store.set('deck', deck), [deck]);
  // App shortcut "Shuffle everything" (long-press the app icon): /?do=shuffle.
  const { pid, toast } = useApp();
  const nav = useNavigate();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('do') !== 'shuffle' || !pid) return;
    nav('/', { replace: true });
    get(`p/${pid}/random`, { size: 300 })
      .then((songs) => {
        p.playList(songs, 0, pid);
        // Browsers may want a tap before sound starts.
        setTimeout(() => !p.audio?.paused || toast('Shuffled. Press play to start.'), 1200);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'p' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !e.ctrlKey && !e.metaKey) setDeck((d) => !d);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => {
    document.querySelector('.content')?.scrollTo(0, 0);
  }, [pathname]);
  const small = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 820px)').matches;
  return (
    <div className={cx('app', !deck && 'deck-closed')}>
      <div className="ambient" aria-hidden="true" />
      <Topbar deckOpen={deck} toggleDeck={() => setDeck((d) => !d)} />
      <Rail inboxCount={inbox} />
      <main className="main">
        <SubNav />
        {inbox > 0 && !/^\/(add|inbox)/.test(pathname) && (
          <div className="waiting-bar">
            <span className="grow"><b>{inbox} {inbox === 1 ? 'song is' : 'songs are'} waiting</b> for you to check before they go into your library.</span>
            <Link className="btn small primary" to="/add#review">Check and import</Link>
          </div>
        )}
        <div className="content" id="content" onContextMenu={(e) => !e.defaultPrevented && menus.background(e)}>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/albums" element={<Albums />} />
              <Route path="/album/:id" element={<Album />} />
              <Route path="/artists" element={<Artists />} />
              <Route path="/artist/:id" element={<Artist />} />
              <Route path="/genres" element={<Genres />} />
              <Route path="/folders" element={<Folders />} />
              <Route path="/favorites" element={<Favorites />} />
              <Route path="/radio" element={<Radio />} />
              <Route path="/playlists" element={<Playlists />} />
              <Route path="/playlist/:id" element={<Playlist />} />
              <Route path="/smart" element={<SmartPlaylists />} />
              <Route path="/library" element={<Library />} />
              <Route path="/duplicates" element={<Duplicates />} />
              <Route path="/organize" element={<Organize />} />
              <Route path="/export" element={<ExportPage />} />
              <Route path="/trash" element={<Trash />} />
              <Route path="/add" element={<Add />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/stats/library" element={<LibraryStats />} />
              <Route path="/wrapped" element={<Wrapped />} />
              <Route path="/scrobbles" element={<Scrobbles />} />
              <Route path="/shares" element={<Shares />} />
              <Route path="/everywhere" element={<Everywhere />} />
              <Route path="/settings/*" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </div>
      </main>
      {deck && <Deck onClose={() => setDeck(false)} />}
      {(!deck || small) && p.current && <Capsule onOpen={() => setDeck(true)} />}
      <Toasts />
      <TourOffer />
      <Shortcuts />
    </div>
  );
}

export default function App() {
  const { ready, me, settings, profiles } = useApp();
  const { pathname } = useLocation();
  if (!ready) return <div className="center-page"><Spinner size={26} /></div>;
  const signedIn = me?.user || me?.guest;
  if (!signedIn && pathname !== '/login') return <Navigate to="/login" replace />;
  const needsSetup = signedIn && (!settings?.setupDone || (!profiles.length && pathname !== '/setup'));
  return (
    <Suspense fallback={<div className="center-page"><Spinner size={26} /></div>}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={needsSetup && !pathname.startsWith('/settings') ? <Navigate to="/setup" replace /> : <Shell />} />
      </Routes>
    </Suspense>
  );
}
