import { useRef, useState } from 'react';
import { FileAudio, Link2, Wand2, Fingerprint, Check, Upload } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { post, uploadFile } from '../lib/api.js';
import { Modal, Spinner, Notice } from './ui.jsx';

const WORDS = { title: 'title', artist: 'artist', album: 'album', cover: 'cover' };

/**
 * Put another recording into a song: a file, or a link (YouTube, SoundCloud,
 * a direct link …). Its name, tags, cover and lyrics stay. Afterwards, if
 * details are missing, offer to find them.
 */
export function ReplaceAudio({ track, pid, onClose, onDone, onFindDetails, onRecognize }) {
  const { fail, afterJob, toast } = useApp();
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(null); // text while working
  const [done, setDone] = useState(null); // { missing }
  const [drag, setDrag] = useState(false);
  const pick = useRef(null);

  const go = async () => {
    try {
      let body = { url: url.trim() };
      if (file) {
        setBusy('Uploading 0%');
        body = { uploadId: await uploadFile(file, { onProgress: (x) => setBusy(`Uploading ${Math.round(x * 100)}%`) }) };
      }
      setBusy(file ? 'Putting the new audio in…' : 'Getting the audio…');
      const { job } = await post(`p/${pid}/tracks/${track.id}/replace-audio`, body);
      const j = await afterJob(job);
      setBusy(null);
      if (j.status !== 'done') return fail(new Error(j.error || 'That didn’t work'));
      onDone?.();
      if (j.result.missing?.length) setDone(j.result);
      else {
        toast('New audio in, everything else kept', { kind: 'ok' });
        onClose();
      }
    } catch (e) {
      setBusy(null);
      fail(e);
    }
  };

  if (done)
    return (
      <Modal title="New audio is in" onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>Not now</button>}>
        <p className="muted" style={{ margin: 0 }}>
          The song kept its details, but it has no {done.missing.map((m) => WORDS[m]).join(', ').replace(/, ([^,]*)$/, ' and $1')}. Want to fill that in?
        </p>
        <div className="col" style={{ gap: 8 }}>
          {onFindDetails && <button className="choice" onClick={() => { onClose(); onFindDetails(); }}><Wand2 /><span><b>Look it up by name</b><small>Searches the details and the cover online. You pick, nothing is saved by itself.</small></span></button>}
          {onRecognize && <button className="choice" onClick={() => { onClose(); onRecognize(); }}><Fingerprint /><span><b>Recognize it from the sound</b><small>For when even the name is unknown.</small></span></button>}
        </div>
      </Modal>
    );

  const ready = Boolean(file || /^https?:\/\/\S+/i.test(url.trim()));
  return (
    <Modal
      title={`New audio for “${track.title || track.filename}”`}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
          <button className="btn primary" onClick={go} disabled={!ready || Boolean(busy)}>{busy ? <Spinner size={14} /> : <Check />} {busy || 'Replace the audio'}</button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>Only the sound changes. The name, artist, album, cover and lyrics stay as they are, and the old audio is kept as a restore point.</p>
      <div
        className={`drop-zone${drag ? ' over' : ''}${file ? ' has' : ''}`}
        onClick={() => pick.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) { setFile(f); setUrl(''); } }}
        role="button"
        tabIndex={0}
      >
        {file ? <FileAudio /> : <Upload />}
        <span>{file ? <b>{file.name}</b> : <>Drop a song or video here, or <u>pick a file</u></>}</span>
        <input ref={pick} type="file" accept="audio/*,video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setUrl(''); } }} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Link2 size={16} className="faint" />
        <input className="input grow" value={url} onChange={(e) => { setUrl(e.target.value); if (e.target.value) setFile(null); }} placeholder="…or paste a link: YouTube, SoundCloud, a direct link" onKeyDown={(e) => e.key === 'Enter' && ready && !busy && go()} />
      </div>
      {busy && <Notice>{busy} You can close the editor; it goes on in the background.</Notice>}
    </Modal>
  );
}
