import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Download, Upload, FolderUp, Link2, HardDrive, Check, CircleAlert, Wrench, RefreshCw, Inbox as InboxIcon, X, FolderOpen } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post, uploadFile } from '../lib/api.js';
import { fmtSize, cx, plural } from '../lib/util.js';
import { Field, Notice, Spinner, Toggle, Progress, Segmented } from '../components/ui.jsx';
import { JobRow } from '../components/Shell.jsx';
import { FolderPicker } from '../components/FolderPicker.jsx';
import { useAdding } from '../lib/adding.jsx';
import { InboxPanel } from './Inbox.jsx';

function useDetectLines(text) {
  const [out, setOut] = useState([]);
  useEffect(() => {
    const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const t = setTimeout(async () => {
      const res = await Promise.all(lines.map((l) => post('downloads/detect', { input: l }).then((d) => ({ line: l, ...d })).catch(() => ({ line: l }))));
      setOut(res);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);
  return out;
}

export default function Add() {
  const { profiles, pid, settings, jobs, fail, toast, isAdmin } = useApp();
  const [target, setTarget] = useState(pid);
  const add = useAdding();
  const text = add.draft;
  const setText = add.setDraft;
  const [review, setReview] = useState(settings?.downloads?.reviewBeforeImport !== false);
  const [video, setVideo] = useState(settings?.convert?.animatedCovers !== false);
  const mine = add.jobIds;
  const setMine = (fn) => add.addJobs(fn([]));
  const uploads = add.uploads;
  const [over, setOver] = useState(false);
  const [path, setPath] = useState('');
  const [move, setMove] = useState(false);
  const [picker, setPicker] = useState(false);
  const [url, setUrl] = useState('');
  const tools = useLoad(() => get('downloads/tools'), []);
  const detected = useDetectLines(text);
  const folderInput = useRef(null);
  const fileInput = useRef(null);
  const privacy = settings?.privacy?.fullLocal;
  const libs = profiles.filter((p) => p.localPath);

  const start = async () => {
    try {
      const r = await post('downloads', { input: text, profileId: target, autoImport: !review, video });
      setMine((m) => [...r.jobs, ...m]);
      setText('');
      toast(`Started ${plural(r.jobs.length, 'download')}`);
    } catch (e) {
      fail(e);
    }
  };

  const queueFiles = (files) => add.addFiles(files, target);

  // Folders dropped from the file manager: walk them.
  const onDrop = async (e) => {
    e.preventDefault();
    setOver(false);
    const entries = [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return queueFiles(e.dataTransfer.files);
    const files = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const f = await new Promise((res) => entry.file(res));
        f.relPath = `${prefix}${f.name}`;
        files.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res) => reader.readEntries(res));
          if (!batch.length) break;
          for (const c of batch) await walk(c, `${prefix}${entry.name}/`);
        }
      }
    };
    for (const en of entries) await walk(en, '');
    queueFiles(files);
  };

  const fromPath = async () => {
    try {
      const r = await post('inbox/from-path', { path, move, profileId: target });
      setMine((m) => [r.job, ...m]);
      toast('Reading the folder…');
    } catch (e) {
      fail(e);
    }
  };
  const fromUrl = async () => {
    try {
      const r = await post('inbox/from-url', { url, profileId: target });
      setMine((m) => [r.job, ...m]);
      setUrl('');
    } catch (e) {
      fail(e);
    }
  };

  const T = tools.data;
  const myJobs = mine.map((id) => jobs[id]).filter(Boolean);
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Add music</h1>
          <p className="page-sub">Two steps: <b>1</b> add music from anywhere, <b>2</b> check names and covers below, then import. It keeps running while you use the rest of the app.</p>
        </div>
        <Field label="Into">
          <select className="select" style={{ width: 240 }} value={target || ''} onChange={(e) => setTarget(e.target.value)}>
            {libs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {!libs.length && <option value="">No library with a folder</option>}
          </select>
        </Field>
      </div>
      {!libs.length && <Notice kind="warn">Importing needs a library with a linked folder. <Link to="/settings/profiles">Add or link one</Link>.</Notice>}

      <h2 style={{ fontSize: 19, margin: '6px 0 12px' }}>1 · Add music</h2>
      <section className="panel">
        <h3><Download size={16} /> From the web</h3>
        <p className="muted" style={{ margin: '4px 0 12px' }}>
          Paste links, one per line: Spotify, YouTube Music, YouTube, SoundCloud, Bandcamp, Deezer, Apple Music and about 1,800 more sites, or just “Artist - Title”.
          Want YouTube’s audio with Spotify’s names and cover? Put both on one line: <span className="mono">youtube-link|spotify-link</span>.
        </p>
        {privacy && <Notice kind="warn">Privacy mode is on, so nothing is downloaded from the internet. Turn it off in Settings → Privacy &amp; online.</Notice>}
        <textarea className="textarea mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://open.spotify.com/album/…\nhttps://music.youtube.com/playlist?list=…\nPorter Robinson - Shelter'} disabled={privacy} />
        {detected.length > 0 && (
          <div className="chips" style={{ marginTop: 8 }}>
            {detected.map((d, i) => (
              <span key={i} className="badge accent" title={d.hint}>{d.label || '?'} · {d.tool}</span>
            ))}
          </div>
        )}
        <div className="row wrap" style={{ marginTop: 12 }}>
          <Toggle checked={review} onChange={setReview} label="Let me check before importing" description="Off: straight into the library." />
          <Toggle checked={video} onChange={setVideo} label="Keep music videos for animated covers" description="YouTube only. Uses more data." />
          <span className="grow" />
          <button className="btn primary" onClick={start} disabled={!text.trim() || privacy}><Download /> Download</button>
        </div>
      </section>

      <section className="panel">
        <h3><Upload size={16} /> From this device</h3>
        <div className={cx('drop', over && 'over')} style={{ marginTop: 10 }} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          <Upload className="big" />
          <div><b>Drop songs, videos, folders or archives here</b></div>
          <div className="faint" style={{ fontSize: 13, margin: '4px 0 14px' }}>Any format. Archives (zip, rar, 7z, tar …) are searched all the way down, also archives inside archives. Big files upload in parts and resume if the connection drops.</div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => fileInput.current.click()}><Upload /> Choose files</button>
            <button className="btn" onClick={() => folderInput.current.click()}><FolderUp /> Choose a folder</button>
          </div>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => queueFiles(e.target.files)} />
          <input ref={folderInput} type="file" multiple hidden webkitdirectory="" directory="" onChange={(e) => queueFiles(e.target.files)} />
        </div>
        {uploads.length > 0 && (
          <div className="col" style={{ gap: 6, marginTop: 12, maxHeight: 260, overflow: 'auto' }}>
            {uploads.map((u) => (
              <div key={u.key} className="row">
                {u.state === 'failed' ? <CircleAlert size={16} style={{ color: 'var(--danger)' }} /> : u.state === 'reading' ? <Check size={16} style={{ color: 'var(--ok)' }} /> : <Spinner size={14} />}
                <span className="ellipsis grow" title={u.rel || u.file.name}>{u.rel || u.file.name}</span>
                <span className="faint tabular" style={{ fontSize: 12 }}>{u.state === 'failed' ? u.error : u.state === 'reading' ? 'uploaded' : `${Math.round(u.progress * 100)}% of ${fmtSize(u.file.size)}`}</span>
                <div style={{ width: 120 }}><Progress value={u.progress} /></div>
              </div>
            ))}
            <button className="btn small ghost" style={{ alignSelf: 'flex-end' }} onClick={add.clearUploads}><X /> Clear finished</button>
          </div>
        )}
      </section>

      <div className="fields two" style={{ marginTop: 14 }}>
        {isAdmin && (
          <section className="panel">
            <h3><HardDrive size={16} /> From a folder on the server</h3>
            <p className="muted" style={{ margin: '4px 0 12px' }}>For music that is already on this machine, like a download folder or an old drive.</p>
            <div className="row">
              <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/mnt/music/!Download" />
              <button className="btn icon" onClick={() => setPicker(true)} aria-label="Browse"><FolderOpen /></button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Segmented value={move ? 'move' : 'copy'} onChange={(v) => setMove(v === 'move')} options={[{ value: 'copy', label: 'Copy' }, { value: 'move', label: 'Move' }]} />
              <span className="grow" />
              <button className="btn primary" onClick={fromPath} disabled={!path}>Read folder</button>
            </div>
          </section>
        )}
        <section className="panel">
          <h3><Link2 size={16} /> From a direct link</h3>
          <p className="muted" style={{ margin: '4px 0 12px' }}>A link straight to a music file or an archive (not a page).</p>
          <div className="row">
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/album.zip" />
            <button className="btn primary" onClick={fromUrl} disabled={!url || privacy}>Fetch</button>
          </div>
        </section>
      </div>

      {myJobs.length > 0 && (
        <section className="section">
          <div className="section-head"><h2 style={{ fontSize: 16 }}>Working on it</h2><button className="more btn small ghost" onClick={add.forgetJobs}>Clear the list</button></div>
          <div className="panel" style={{ padding: 6 }}>{myJobs.slice(0, 12).map((j) => <JobRow key={j.id} job={j} />)}</div>
        </section>
      )}

      <section className="section" id="review">
        <InboxPanel embedded />
      </section>

      <section className="section">
        <div className="section-head"><h2><Wrench size={17} /> Tools</h2><button className="more btn small ghost" onClick={tools.reload}><RefreshCw /> Check again</button></div>
        {!T && <Spinner />}
        {T && (
          <div className="fields two">
            {Object.entries(T).map(([name, t]) => (
              <div key={name} className="panel row" style={{ padding: 12 }}>
                <span className={cx('dot', t.path ? 'ok' : 'off')} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <b>{{ spotdl: 'spotDL', ytdlp: 'yt-dlp', ffmpeg: 'FFmpeg', fpcalc: 'Chromaprint (fpcalc)', shazamio: 'Shazam (unofficial)' }[name] || name}</b>
                  <div className="faint ellipsis" style={{ fontSize: 12 }}>{t.path ? `${t.version || 'installed'} · ${t.path}` : t.install}</div>
                </div>
                {isAdmin && name !== 'ffmpeg' && (
                  <button className="btn small" disabled={privacy} onClick={async () => { const r = await post(`downloads/tools/${name}/${t.path && name !== 'shazamio' && name !== 'fpcalc' ? 'update' : 'install'}`); setMine((m) => [r.job, ...m]); }}>
                    {t.path ? 'Update' : 'Install'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {picker && <FolderPicker start={path || '/'} onClose={() => setPicker(false)} onPick={(p) => { setPath(p); setPicker(false); }} />}
    </>
  );
}

export { useMemo };
