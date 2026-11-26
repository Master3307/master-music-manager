import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, ArrowLeft, Wrench, Music2, FolderTree, Sparkles, FolderOpen, Upload, Server, Headphones } from 'lucide-react';
import { FolderPicker } from '../components/FolderPicker.jsx';
import { useApp } from '../lib/app.jsx';
import { post, get } from '../lib/api.js';
import { Logo, Field, Notice, Toggle, Spinner, Segmented } from '../components/ui.jsx';
import { ProfileForm, useDetect } from '../components/ProfileForm.jsx';
import { cx } from '../lib/util.js';

const TEMPLATES = [
  { value: '{folderartist}/{album|title}/{?disctotal>1:{disc}-}{?track:{track:2} - }{title}', example: 'Daft Punk/Discovery/01 - One More Time.mp3', label: 'Artist / Album / 01 - Title' },
  { value: '{folderartist}/{year} - {album|title}/{?track:{track:2} }{title}', example: 'Daft Punk/2001 - Discovery/01 One More Time.mp3', label: 'Artist / Year - Album / 01 Title' },
  { value: '{folderartist:initial}/{folderartist}/{album|title}/{?track:{track:2} - }{title}', example: 'D/Daft Punk/Discovery/01 - One More Time.mp3', label: 'Letter / Artist / Album / …' },
  { value: '{genre:first|"Unsorted"}/{folderartist}/{album|title}/{title}', example: 'House/Daft Punk/Discovery/One More Time.mp3', label: 'Genre / Artist / Album / Title' },
  { value: '{folderartist} - {title}', example: 'Daft Punk - One More Time.mp3', label: 'Everything in one folder' },
];

export default function Setup() {
  const { me, settings, saveSetting, loadProfiles, profiles, fields, isAdmin, toast } = useApp();
  const nav = useNavigate();
  const detected = useDetect();
  const [step, setStep] = useState(profiles.length ? 2 : 0);
  const [lib, setLib] = useState(() => ({ ...settings?.library }));
  const [conv, setConv] = useState(() => ({ ...settings?.convert }));
  const [added, setAdded] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [intent, setIntent] = useState(null); // listen | upload | server
  const [folder, setFolder] = useState('');
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const steps = ['Welcome', 'Your music', 'How files are named', 'Ready'];
  const simple = intent === 'listen' || intent === 'upload';
  if (!isAdmin) {
    return (
      <div className="center-page">
        <div className="auth-card">
          <Logo size={40} />
          <h1>Not set up yet</h1>
          <p className="muted">An admin needs to finish the setup first.</p>
        </div>
      </div>
    );
  }
  const seps = fields?.separators || [{ value: ' / ', label: 'A / B' }];

  const finish = async () => {
    await saveSetting('library', lib);
    await saveSetting('convert', conv);
    if (simple) await saveSetting('appearance', { simple: true });
    await saveSetting('setupDone', true);
    toast('All set. Your music is being read in the background; it appears as it goes.');
    nav(`/${intent === 'upload' ? 'add' : ''}?tour=ask`);
  };

  // The simple ways: one folder, no questions about servers.
  const addFolder = async (path, createFolder) => {
    setBusy(true);
    try {
      const p = await post('profiles', { kind: 'local', name: 'My music', localPath: path, createFolder });
      await loadProfiles();
      setAdded(p);
      setStep(3);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    setBusy(false);
  };

  return (
    <div className="center-page">
      <div className="ambient" style={{ '--ambient': 'var(--accent)' }} aria-hidden="true" />
      <div className="auth-card setup">
        <div className="row" style={{ marginBottom: 18 }}>
          <Logo size={34} />
          <b className="grow">Master Music Manager</b>
          <span className="faint" style={{ fontSize: 13 }}>
            Step {step + 1} of {steps.length}: {steps[step]}
          </span>
        </div>
        <div className="steps">{steps.map((s, i) => <i key={s} className={cx(i <= step && 'on')} />)}</div>

        {step === 0 && (
          <div className="col" style={{ gap: 16 }}>
            <h1 style={{ margin: 0 }}>Let’s get your music in order.</h1>
            <p className="muted" style={{ margin: 0, maxWidth: '62ch' }}>
              Master Music Manager edits tags, sorts files into folders, finds duplicates, downloads and imports music, and plays it, with Navidrome, Jellyfin or any OpenSubsonic server, or just a folder. This takes about two minutes. Everything can be changed later in Settings.
            </p>
            {detected ? (
              <div className="panel">
                <h3>What we found on this machine</h3>
                <ul className="muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {detected.servers.map((s) => (
                    <li key={s.url}>
                      {s.kind === 'jellyfin' ? 'Jellyfin' : s.kind === 'navidrome' ? 'Navidrome' : 'A Subsonic server'} at <span className="mono">{s.url}</span>
                      {s.musicFolder ? <> with music in <span className="mono">{s.musicFolder}</span></> : null}
                    </li>
                  ))}
                  {detected.folders.map((f) => (
                    <li key={f}>A music folder: <span className="mono">{f}</span></li>
                  ))}
                  {!detected.servers.length && !detected.folders.length && <li>No server or music folder yet. You can type them in on the next step.</li>}
                </ul>
                <div className="chips" style={{ marginTop: 12 }}>
                  {Object.entries(detected.tools).map(([t, ok]) => (
                    <span key={t} className={cx('badge', ok ? 'ok' : '')}>{ok ? '✓' : '–'} {t}</span>
                  ))}
                </div>
                {!detected.tools.ffmpeg && <Notice kind="warn">FFmpeg is missing. Converting and the audio editor need it: <span className="mono">sudo apt install ffmpeg</span></Notice>}
              </div>
            ) : (
              <Spinner />
            )}
            {me?.guest && (
              <Notice kind="warn">
                Logins are off, so anyone who opens this address can change everything. Turn them on in <b>Settings → Account &amp; security</b> if this is reachable from outside.
              </Notice>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" onClick={() => setStep(1)}>Start</button>
            </div>
          </div>
        )}

        {step === 1 && !intent && (
          <div className="col" style={{ gap: 14 }}>
            <h1 style={{ margin: 0 }}>What would you like to do?</h1>
            <p className="muted" style={{ margin: 0 }}>Pick what fits. Everything else can be added later, in Settings → Libraries.</p>
            <div className="col" style={{ gap: 10 }}>
              <button className="choice" onClick={() => { setIntent('listen'); setFolder(detected?.counted?.sort((a, b) => b.songs - a.songs)[0]?.path || ''); }}>
                <Headphones /><span><b>Just listen to my music</b><small>You have a folder with music on this machine. It becomes your library, with covers and everything.</small></span>
              </button>
              <button className="choice" onClick={() => setIntent('upload')}>
                <Upload /><span><b>I’ll upload my music</b><small>Start with an empty music folder, then drop your songs, folders or zip files into the app.</small></span>
              </button>
              <button className="choice" onClick={() => setIntent('server')}>
                <Server /><span><b>Connect my music server</b><small>Navidrome, Jellyfin or any OpenSubsonic server, with or without its music folder.{detected?.servers?.length ? ` Found: ${detected.servers.map((x) => x.kind).join(', ')}.` : ''}</small></span>
              </button>
            </div>
            <div className="row"><button className="btn ghost" onClick={() => setStep(0)}><ArrowLeft /> Back</button></div>
          </div>
        )}

        {step === 1 && intent === 'listen' && (
          <div className="col" style={{ gap: 14 }}>
            <h1 style={{ margin: 0 }}>Where is your music?</h1>
            <p className="muted" style={{ margin: 0 }}>The folder with all your music. Subfolders are included.</p>
            {(detected?.counted || []).length > 0 && (
              <div className="col" style={{ gap: 8 }}>
                {detected.counted.map((f) => (
                  <button key={f.path} className={cx('choice', folder === f.path && 'active')} onClick={() => setFolder(f.path)}>
                    <FolderOpen /><span><b className="mono">{f.path}</b><small>{f.songs ? `${f.more ? 'more than ' : ''}${f.songs.toLocaleString()} songs` : 'no songs found right inside'}</small></span>
                  </button>
                ))}
              </div>
            )}
            <div className="row">
              <input className="input mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/home/you/Music" />
              <button className="btn" onClick={() => setPicker(true)}><FolderOpen /> Browse</button>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={() => setIntent(null)}><ArrowLeft /> Back</button>
              <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={!folder || busy} onClick={() => addFolder(folder)}>{busy ? <Spinner size={14} /> : <Check />} Use this folder</button>
            </div>
            {picker && <FolderPicker start={folder || '/'} onClose={() => setPicker(false)} onPick={(p) => { setFolder(p); setPicker(false); }} />}
          </div>
        )}

        {step === 1 && intent === 'upload' && (
          <div className="col" style={{ gap: 14 }}>
            <h1 style={{ margin: 0 }}>Where should your music be kept?</h1>
            <p className="muted" style={{ margin: 0 }}>A folder on this machine. It’s made for you if it doesn’t exist.</p>
            <input className="input mono" value={folder || detected?.suggestedNew || ''} onChange={(e) => setFolder(e.target.value)} />
            <div className="row">
              <button className="btn ghost" onClick={() => setIntent(null)}><ArrowLeft /> Back</button>
              <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => addFolder(folder || detected?.suggestedNew, true)}>{busy ? <Spinner size={14} /> : <Check />} Make it my library</button>
            </div>
          </div>
        )}

        {step === 1 && intent === 'server' && (
          <div className="col" style={{ gap: 14 }}>
            <h1 style={{ margin: 0 }}>Connect your music server</h1>
            <p className="muted" style={{ margin: 0 }}>Add the music folder too if this machine can see it: then you can also edit tags, covers and lyrics and move files.</p>
            {detected ? (
              <ProfileForm
                detected={detected}
                onDone={async (p, opts) => {
                  await loadProfiles();
                  setAdded(p);
                  if (!opts?.linkFailed) setStep(2);
                }}
              />
            ) : (
              <Spinner />
            )}
            <div className="row">
              <button className="btn ghost" onClick={() => setIntent(null)}><ArrowLeft /> Back</button>
              {profiles.length > 0 && <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setStep(2)}>Skip</button>}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="col" style={{ gap: 18 }}>
            <h1 style={{ margin: 0 }}>How should files be named?</h1>
            <p className="muted" style={{ margin: 0 }}>New and edited songs are filed like this. Nothing is moved until you say so; Library → Organize shows a preview first.</p>
            <div className="col" style={{ gap: 8 }}>
              {TEMPLATES.map((t) => (
                <button key={t.value} className={cx('choice', lib.template === t.value && 'active')} onClick={() => setLib({ ...lib, template: t.value })}>
                  <FolderTree />
                  <span>
                    <b>{t.label}</b>
                    <small className="mono">{t.example}</small>
                  </span>
                </button>
              ))}
            </div>
            <Field label="Between several artists" hint={`“Daft Punk feat. Pharrell & Nile Rodgers” becomes “${['Daft Punk', 'Pharrell', 'Nile Rodgers'].join(lib.separator === '\u0000' ? ' ␀ ' : lib.separator)}”`}>
              <select className="select" value={lib.separator} onChange={(e) => setLib({ ...lib, separator: e.target.value })}>
                {seps.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}{s.note ? ` — ${s.note}` : ''}</option>
                ))}
              </select>
            </Field>
            <Toggle checked={lib.splitArtists} onChange={(v) => setLib({ ...lib, splitArtists: v })} label="Split artists automatically" description="Turns feat., ft., &, x and commas into the separator. Names like “Simon & Garfunkel” can be protected in Settings." />
            <Field label="Songs without any artist or title">
              <Segmented
                value={lib.misc?.enabled === true ? 'misc' : lib.misc?.enabled === false ? 'keep' : 'ask'}
                onChange={(v) => setLib({ ...lib, misc: { ...lib.misc, enabled: v === 'misc' ? true : v === 'keep' ? false : null } })}
                options={[{ value: 'misc', label: 'Put in !Misc' }, { value: 'keep', label: 'Use the file name' }, { value: 'ask', label: 'Ask me each time' }]}
              />
            </Field>
            <Field label="Format for new music" hint="Uploads, downloads and imports. Your existing files are never converted unless you ask.">
              <select className="select" value={conv.format} onChange={(e) => setConv({ ...conv, format: e.target.value })}>
                <option value="mp3">MP3 (plays everywhere, recommended)</option>
                <option value="flac">FLAC (lossless, bigger files)</option>
                <option value="opus">Opus (smallest for the quality)</option>
                <option value="m4a">AAC / M4A (Apple devices)</option>
                <option value="original">Keep whatever it comes in</option>
              </select>
            </Field>
            <Toggle checked={conv.keepLossless} onChange={(v) => setConv({ ...conv, keepLossless: v })} label="Keep lossless files lossless" description="FLAC and WAV stay FLAC instead of becoming MP3." />
            <Toggle checked={conv.animatedCovers} onChange={(v) => setConv({ ...conv, animatedCovers: v })} label="Animated covers from music videos" description="When you add a video, a short loop of it becomes the song’s moving cover." />
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(1)}><ArrowLeft /> Back</button>
              <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setStep(3)}>Next</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="col" style={{ gap: 16 }}>
            <h1 style={{ margin: 0 }}>Ready.</h1>
            {simple ? (
              <div className="choices">
                <div className="choice"><Headphones /><span><b>Listen</b><small>Albums, artists, playlists and a big shuffle button.</small></span></div>
                <div className="choice"><Upload /><span><b>Add</b><small>Drop songs, folders or zip files, or paste links.</small></span></div>
                <div className="choice"><Wrench /><span><b>Want more?</b><small>Settings → Look → turn off “Simple player” for tag editing, duplicates and more.</small></span></div>
              </div>
            ) : (
            <div className="choices">
              <div className="choice"><Music2 /><span><b>Library → Tracks</b><small>Every song as a table. Filter, select, edit many at once, or type commands.</small></span></div>
              <div className="choice"><Sparkles /><span><b>Add</b><small>Paste Spotify, YouTube or SoundCloud links, drop files, folders or archives.</small></span></div>
              <div className="choice"><Wrench /><span><b>Settings</b><small>Themes, accounts, logins, the Navidrome plugin, linked computers and more.</small></span></div>
            </div>
            )}
            {(added || profiles[0])?.localPath && <Notice kind="accent">Your folder is read once now, in the background. With many songs this takes a few minutes; you can use the app meanwhile.</Notice>}
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(simple ? 1 : 2)}><ArrowLeft /> Back</button>
              <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={finish} disabled={scanning}>
                <Check /> Open Master Music Manager
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { get };
