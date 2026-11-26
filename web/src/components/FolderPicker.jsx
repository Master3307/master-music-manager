import { useEffect, useState } from 'react';
import { Folder, FolderOpen, CornerLeftUp, HardDrive, Music2 } from 'lucide-react';
import { get } from '../lib/api.js';
import { Modal, Spinner } from './ui.jsx';

/** Pick a folder on the machine Master Music Manager runs on. */
export function FolderPicker({ start, onPick, onClose, title = 'Choose a folder' }) {
  const [path, setPath] = useState(start || '');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [typed, setTyped] = useState(start || '');
  useEffect(() => {
    setErr(null);
    get('fs', { path })
      .then((d) => {
        setData(d);
        setTyped(d.path);
      })
      .catch((e) => setErr(e.message));
  }, [path]);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="faint grow" style={{ fontSize: 12.5 }}>{data ? `${data.media} music files right here` : ''}</span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!data} onClick={() => onPick(data.path)}>
            Use this folder
          </button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); setPath(typed); }} className="row">
        <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Path" />
        <button className="btn">Go</button>
      </form>
      {data?.places && (
        <div className="chips">
          {data.places.map((p) => (
            <button key={p} className="chip" onClick={() => setPath(p)}>
              <HardDrive /> {p}
            </button>
          ))}
        </div>
      )}
      {err && <div className="notice danger">{err}</div>}
      {!data && !err && <Spinner />}
      {data && (
        <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-s)' }}>
          {data.parent && (
            <button className="menu-item" onClick={() => setPath(data.parent)}>
              <CornerLeftUp /> Up
            </button>
          )}
          {data.dirs.map((d) => (
            <button key={d} className="menu-item" onClick={() => setPath(`${data.path.replace(/\/$/, '')}/${d}`)} onDoubleClick={() => onPick(`${data.path.replace(/\/$/, '')}/${d}`)}>
              {d.toLowerCase().includes('music') ? <Music2 /> : <Folder />}
              <span className="ellipsis grow">{d}</span>
            </button>
          ))}
          {!data.dirs.length && <p className="faint" style={{ padding: 12, margin: 0 }}><FolderOpen size={14} /> No folders inside.</p>}
        </div>
      )}
    </Modal>
  );
}
