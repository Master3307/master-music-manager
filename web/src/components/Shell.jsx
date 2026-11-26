import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router';
import {
  Disc3, Library, Download, BarChart3, Share2, Settings, Search, Terminal, Wifi, WifiOff, HardDrive, ChevronDown, Check, Activity, X, Loader2, CircleAlert, LogOut, User,
  PanelRight, Sun, Moon, Monitor, Inbox, Network, Plus,
  Smartphone,
} from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { usePlayer } from '../lib/player.jsx';
import { post, get } from '../lib/api.js';
import { cx, ago, store } from '../lib/util.js';
import { Logo, Menu, MenuItem, MenuSep, JobDetails, Progress, Spinner, GithubIcon, Modal } from './ui.jsx';
import { useInstall } from '../lib/install.js';

export const SECTIONS = [
  { id: 'listen', label: 'Listen', icon: Disc3, to: '/', match: /^\/($|listen|albums|artists|genres|playlists|radio|favorites|folders|album\/|artist\/|playlist\/|everywhere)/,
    tabs: (c) => [['/', 'Home'], ['/albums', 'Albums'], ['/artists', 'Artists'], ['/genres', 'Genres'], ['/playlists', 'Playlists'], ['/favorites', 'Favorites'], ['/radio', 'Radio'], c.service && ['/folders', 'Folders'], c.nodes && ['/everywhere', 'Everywhere']] },
  { id: 'library', label: 'Library', icon: Library, to: '/library', match: /^\/(library|duplicates|organize|export|trash|smart)/,
    tabs: (c) => [['/library', 'Tracks'], c.files && ['/duplicates', 'Duplicates'], c.files && ['/organize', 'Organize'], ['/export', 'Export'], c.files && ['/smart', 'Smart playlists'], c.files && ['/trash', 'Trash']] },
  { id: 'add', label: 'Add', icon: Download, to: '/add', match: /^\/(add|inbox)/, badge: 'inbox',
    tabs: () => [['/add', 'Add music'], ['/inbox', 'Check & import']] },
  { id: 'stats', label: 'Stats', icon: BarChart3, to: '/stats', match: /^\/(stats|wrapped|scrobbles)/,
    tabs: () => [['/stats', 'Listening'], ['/stats/library', 'Library'], ['/wrapped', 'Wrapped'], ['/scrobbles', 'Scrobbles']] },
  { id: 'share', label: 'Share', icon: Share2, to: '/shares', match: /^\/shares/, tabs: () => [] },
];

export function Rail({ inboxCount }) {
  const { pathname } = useLocation();
  const { settings, can, caps } = useApp();
  const simple = settings?.appearance?.simple;
  const show = (s) => {
    if (s.id === 'library') return !simple && can('manage') && caps.files;
    if (s.id === 'add') return can('manage');
    if (s.id === 'stats') return !simple;
    if (s.id === 'share') return can('share') && !simple;
    return true;
  };
  return (
    <nav className="rail" aria-label="Sections">
      {SECTIONS.filter(show).map((s) => (
        <NavLink key={s.id} to={s.to} className={() => cx(s.match.test(pathname) && 'active')} end={s.to === '/'}>
          <s.icon />
          <span>{s.label}</span>
          {s.badge === 'inbox' && inboxCount > 0 && <span className="badge">{inboxCount > 99 ? '99+' : inboxCount}</span>}
        </NavLink>
      ))}
      <div className="spacer" />
      <NavLink to="/settings" className={() => cx(pathname.startsWith('/settings') && 'active')}>
        <Settings />
        <span>Settings</span>
      </NavLink>
    </nav>
  );
}

export function SubNav() {
  const { pathname } = useLocation();
  const { caps, profiles } = useApp();
  const sec = SECTIONS.find((s) => s.match.test(pathname));
  if (!sec) return null;
  const nodes = false; // filled by /everywhere when instances exist
  const tabs = sec.tabs({ ...caps, nodes: nodes || store.get('hasNodes', false) }).filter(Boolean);
  if (tabs.length < 2) return null;
  return (
    <div className="subnav">
      {tabs.map(([to, label]) => (
        <NavLink key={to} to={to} end className={({ isActive }) => cx(isActive && 'active')}>
          {label}
        </NavLink>
      ))}
      {profiles.length > 1 && <span className="faint" style={{ marginLeft: 'auto', fontSize: 12.5 }} />}
    </div>
  );
}

/** Search + command line in one: plain words search, "/" filters, ">" runs a command on the library. */
export function Omnibar() {
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const [q, setQ] = useState(() => new URLSearchParams(search).get('q') || '');
  const ref = useRef(null);
  useEffect(() => {
    const k = (e) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName))) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const isCmd = q.startsWith('>');
  const submit = (e) => {
    e.preventDefault();
    if (isCmd) nav(`/library?cmd=${encodeURIComponent(q.slice(1).trim())}`);
    else if (/[:=<>~]/.test(q) || pathname.startsWith('/library')) nav(`/library?q=${encodeURIComponent(q)}`);
    else nav(`/search?q=${encodeURIComponent(q)}`);
  };
  return (
    <form className="searchbar" onSubmit={submit} role="search">
      {isCmd ? <Terminal /> : <Search />}
      <input
        ref={ref}
        className={cx('input', isCmd && 'mono')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search, filter like artist:nujabes, or type > for a command"
        aria-label="Search or command"
        spellCheck={false}
      />
      <span className="hint-keys">
        <span className="kbd">Ctrl K</span>
      </span>
    </form>
  );
}

function ProfilePill() {
  const { profiles, profile, setPid, isAdmin } = useApp();
  const [m, setM] = useState(null);
  const nav = useNavigate();
  if (!profile) return isAdmin ? <Link className="btn small" to="/settings/profiles"><Plus /> Add a library</Link> : null;
  const st = profile.status;
  const dot = !profile.features?.service ? <HardDrive size={15} className="faint" /> : st?.online ? <span className="dot ok" /> : st ? <span className="dot off" /> : <span className="dot" />;
  return (
    <>
      <button className="profile-pill" onClick={(e) => setM({ x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom + 6 })} title={st?.online === false ? `${profile.name} can't be reached: ${st.error}` : profile.name}>
        {dot}
        <span className="ellipsis">{profile.name}</span>
        <ChevronDown size={15} className="faint" />
      </button>
      {m && (
        <Menu at={m} align="right" onClose={() => setM(null)}>
          <div className="menu-label">Libraries</div>
          {profiles.map((p) => (
            <MenuItem key={p.id} icon={p.id === profile.id ? Check : p.features?.service ? (p.status?.online === false ? WifiOff : Wifi) : HardDrive} onClick={() => setPid(p.id)} hint={p.status?.online === false ? 'offline' : p.kindLabel}>
              {p.name}
            </MenuItem>
          ))}
          {isAdmin && (
            <>
              <MenuSep />
              <MenuItem icon={Plus} onClick={() => nav('/settings/profiles?add=1')}>
                Add a library or server
              </MenuItem>
              <MenuItem icon={Network} onClick={() => nav('/settings/instances')}>
                Linked instances
              </MenuItem>
            </>
          )}
        </Menu>
      )}
    </>
  );
}

function JobsButton() {
  const { jobs } = useApp();
  const [open, setOpen] = useState(false);
  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.created_at - a.created_at), [jobs]);
  const running = list.filter((j) => ['queued', 'running'].includes(j.status));
  const recentFail = list.find((j) => j.status === 'failed' && Date.now() - j.finished_at < 60_000);
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  return (
    <>
      <button className={cx('btn icon ghost', running.length && 'on')} onClick={() => setOpen((o) => !o)} aria-label="Activity" title="Activity">
        {running.length ? <Loader2 className="spin" style={{ animation: 'spin 1s linear infinite' }} /> : recentFail ? <CircleAlert style={{ color: 'var(--danger)' }} /> : <Activity />}
      </button>
      {open && (
        <div className="jobs-tray" role="dialog" aria-label="Activity">
          <div className="row" style={{ padding: '6px 8px 8px' }}>
            <b className="grow">Activity</b>
            <Link className="btn small ghost" to="/settings/logs" onClick={() => setOpen(false)}>
              Logs
            </Link>
            <button className="btn icon small ghost" onClick={() => setOpen(false)} aria-label="Close">
              <X />
            </button>
          </div>
          {!list.length && <p className="faint" style={{ padding: '0 10px 10px', margin: 0 }}>Nothing has happened yet. Scans, downloads and imports show up here.</p>}
          {list.slice(0, 30).map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </>
  );
}

export function JobRow({ job: j }) {
  const live = ['queued', 'running'].includes(j.status);
  return (
    <div className="job">
      <div className="job-top">
        {live ? <Spinner size={15} /> : j.status === 'done' ? <Check size={16} style={{ color: 'var(--ok)' }} /> : <CircleAlert size={16} style={{ color: j.status === 'failed' ? 'var(--danger)' : 'var(--text-3)' }} />}
        <div className="grow">
          <div className="job-title ellipsis">{j.title}</div>
          <div className="job-detail ellipsis">{j.status === 'failed' ? j.error : j.status === 'cancelled' ? 'Cancelled' : live ? j.detail || (j.status === 'queued' ? 'Waiting…' : 'Working…') : `Finished ${ago(j.finished_at)}`}</div>
        </div>
        {live && (
          <button className="btn small ghost" onClick={() => post(`jobs/${j.id}/cancel`)}>
            Stop
          </button>
        )}
      </div>
      {live && <Progress value={j.progress} indeterminate={!j.progress} />}
      <JobDetails jobId={j.id} live={live} />
    </div>
  );
}

function UserButton() {
  const { me, settings, saveSetting, isAdmin, listenOnly } = useApp();
  const [m, setM] = useState(null);
  const nav = useNavigate();
  const inst = useInstall();
  const [iosHelp, setIosHelp] = useState(false);
  if (listenOnly) return <Link className="btn small primary" to="/login">Log in</Link>;
  const mode = settings?.appearance?.mode;
  const name = me?.user?.displayName || 'Guest';
  return (
    <>
      <button className="avatar" onClick={(e) => setM({ x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom + 6 })} aria-label="Account">
        {me?.user?.avatar ? <img src={me.user.avatar} alt="" /> : name[0]?.toUpperCase()}
      </button>
      {m && (
        <Menu at={m} align="right" onClose={() => setM(null)}>
          <div className="menu-label">{me?.user ? `Signed in as ${name}` : 'Not signed in (logins are off)'}</div>
          {isAdmin && (
            <>
              <MenuItem icon={Sun} onClick={() => saveSetting('appearance', { mode: 'light' })} hint={mode === 'light' ? '✓' : ''}>
                Light
              </MenuItem>
              <MenuItem icon={Moon} onClick={() => saveSetting('appearance', { mode: 'dark' })} hint={mode === 'dark' ? '✓' : ''}>
                Dark
              </MenuItem>
              <MenuItem icon={Monitor} onClick={() => saveSetting('appearance', { mode: 'system' })} hint={mode === 'system' ? '✓' : ''}>
                Like the system
              </MenuItem>
              <MenuSep />
              <MenuItem icon={Disc3} onClick={() => saveSetting('appearance', { simple: !settings?.appearance?.simple })} hint={settings?.appearance?.simple ? '✓' : ''}>
                Simple player (hide the tools)
              </MenuItem>
              <MenuSep />
            </>
          )}
          {(inst.can || inst.ios) && (
            <MenuItem icon={Smartphone} onClick={() => (inst.can ? inst.install() : setIosHelp(true))}>
              Install as an app
            </MenuItem>
          )}
          <MenuItem icon={User} onClick={() => nav('/settings/account')}>
            Account & security
          </MenuItem>
          <MenuItem icon={GithubIcon} onClick={() => window.open('https://github.com/Master3307/master-music-manager', '_blank', 'noopener')}>
            Source code
          </MenuItem>
          <MenuItem icon={Disc3} onClick={() => window.open('https://home.master3307.org', '_blank', 'noopener')}>
            Made by MrKoby07
          </MenuItem>
          {me?.user && (
            <>
              <MenuSep />
              <MenuItem
                icon={LogOut}
                onClick={async () => {
                  await post('auth/logout');
                  location.href = '/login';
                }}
              >
                Log out
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      {iosHelp && (
        <Modal title="Put it on your home screen" icon={<Smartphone />} onClose={() => setIosHelp(false)} footer={<button className="btn primary" onClick={() => setIosHelp(false)}>Got it</button>}>
          <ol className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
            <li>Tap the <b>Share</b> button in Safari (the square with the arrow).</li>
            <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          </ol>
          <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>It then opens like an app: full screen, its own icon, and the lock screen controls for music.</p>
        </Modal>
      )}
    </>
  );
}

export function Topbar({ deckOpen, toggleDeck }) {
  const { update } = useApp();
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="Home">
        <Logo />
        <span className="brand-name">
          Master Music
          <small>Manager</small>
        </span>
      </Link>
      <Omnibar />
      <div className="top-right">
        {update?.update && (
          <Link className="btn small hide-sm" to="/settings/system" title={`Version ${update.latest.version} is out`}>
            Update ready
          </Link>
        )}
        <ProfilePill />
        <JobsButton />
        <button className={cx('btn icon ghost hide-sm', deckOpen && 'on')} onClick={toggleDeck} aria-label={deckOpen ? 'Hide the player' : 'Show the player'} title="Player (P)">
          <PanelRight />
        </button>
        <UserButton />
      </div>
    </header>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.kind)}>
          {t.kind === 'error' ? <CircleAlert /> : <Check />}
          <span>{t.msg}</span>
          {t.action && (
            <button className="btn small" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function useInboxCount() {
  const { jobs } = useApp();
  const [n, setN] = useState(0);
  const finished = Object.values(jobs).filter((j) => j.status === 'done').length;
  useEffect(() => {
    get('inbox')
      .then((l) => setN(l.filter((i) => i.status !== 'imported').length))
      .catch(() => {});
  }, [finished]);
  return n;
}

export function usePlayerNow() {
  return usePlayer();
}
