import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Link2, RotateCw, FlipHorizontal2, FlipVertical2, Crop, RefreshCcw, Check, Clipboard } from 'lucide-react';
import { Modal, Field, Notice, Segmented, Spinner } from './ui.jsx';
import { useApp } from '../lib/app.jsx';

const ASPECTS = [
  { value: 1, label: 'Square' },
  { value: 16 / 9, label: '16:9' },
  { value: 0, label: 'Free' },
];

async function isAnimated(blob) {
  const buf = new Uint8Array(await blob.slice(0, 2 * 1024 * 1024).arrayBuffer());
  if (blob.type === 'image/gif') {
    // More than one image descriptor (0x2C after a graphic control block) = animated.
    let frames = 0;
    for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && ++frames > 1) return true;
    return false;
  }
  if (blob.type === 'image/webp') return new TextDecoder().decode(buf.slice(0, 4096)).includes('ANIM');
  return false;
}

/**
 * Pick and edit a picture. onSave(blob). With allowAnimated, an untouched GIF
 * or animated WebP is passed on as it is, so it keeps moving.
 */
export function ImageEditor({ title = 'Picture', onClose, onSave, allowAnimated = true, initialUrl }) {
  const { fail } = useApp();
  const [file, setFile] = useState(null);
  const [img, setImg] = useState(null);
  const [animated, setAnimated] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [rot, setRot] = useState(0);
  const [flip, setFlip] = useState({ h: false, v: false });
  const [adj, setAdj] = useState({ brightness: 100, contrast: 100, saturate: 100, blur: 0 });
  const [aspect, setAspect] = useState(1);
  const [crop, setCrop] = useState(null); // in source pixels
  const [out, setOut] = useState({ size: 1200, format: 'image/jpeg', quality: 0.9 });
  const [keepAnim, setKeepAnim] = useState(true);
  const stage = useRef(null);
  const canvas = useRef(null);
  const drag = useRef(null);
  const touched = rot !== 0 || flip.h || flip.v || adj.brightness !== 100 || adj.contrast !== 100 || adj.saturate !== 100 || adj.blur !== 0 || (crop && img && (crop.w < img.naturalWidth - 1 || crop.h < img.naturalHeight - 1));

  const load = useCallback(async (blob) => {
    setFile(blob);
    const anim = await isAnimated(blob);
    setAnimated(anim);
    if (anim) setOut((o) => ({ ...o, size: 800, format: blob.type === 'image/webp' ? 'image/webp' : 'image/gif' }));
    const u = URL.createObjectURL(blob);
    const i = new Image();
    i.onload = () => {
      setImg(i);
      setRot(0);
      setFlip({ h: false, v: false });
      const s = Math.min(i.naturalWidth, i.naturalHeight);
      setCrop({ x: (i.naturalWidth - s) / 2, y: (i.naturalHeight - s) / 2, w: s, h: s });
    };
    i.src = u;
  }, []);

  useEffect(() => {
    if (initialUrl) fetch(initialUrl).then((r) => (r.ok ? r.blob() : null)).then((b) => b && load(b)).catch(() => {});
  }, [initialUrl, load]);

  useEffect(() => {
    const paste = (e) => {
      const it = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith('image/'));
      if (it) load(it.getAsFile());
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [load]);

  const fromUrl = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/fetch-image?url=${encodeURIComponent(url)}`, { headers: { 'X-MMM': '1' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load that address');
      await load(await r.blob());
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };

  // Draw the source (rotated / flipped / adjusted) for the preview.
  const W = img ? (rot % 180 ? img.naturalHeight : img.naturalWidth) : 0;
  const H = img ? (rot % 180 ? img.naturalWidth : img.naturalHeight) : 0;
  useEffect(() => {
    if (!img || !canvas.current) return;
    const c = canvas.current;
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.save();
    g.filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturate}%) blur(${adj.blur}px)`;
    g.translate(W / 2, H / 2);
    g.rotate((rot * Math.PI) / 180);
    g.scale(flip.h ? -1 : 1, flip.v ? -1 : 1);
    g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    g.restore();
  }, [img, rot, flip, adj, W, H]);

  useEffect(() => {
    // Keep the crop inside the rotated image and in the chosen shape.
    if (!img) return;
    setCrop((c) => {
      let w = Math.min(c?.w || W, W);
      let h = aspect ? w / aspect : Math.min(c?.h || H, H);
      if (h > H) {
        h = H;
        w = aspect ? h * aspect : w;
      }
      return { x: Math.min(Math.max(0, c?.x ?? 0), W - w), y: Math.min(Math.max(0, c?.y ?? 0), H - h), w, h };
    });
  }, [aspect, W, H, img]);

  const scale = () => (canvas.current ? canvas.current.getBoundingClientRect().width / W : 1);
  const onDown = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { mode, x: e.clientX, y: e.clientY, c: { ...crop } };
    const move = (ev) => {
      const d = drag.current;
      if (!d) return;
      const s = scale();
      const dx = (ev.clientX - d.x) / s;
      const dy = (ev.clientY - d.y) / s;
      if (d.mode === 'move') setCrop({ ...d.c, x: Math.min(Math.max(0, d.c.x + dx), W - d.c.w), y: Math.min(Math.max(0, d.c.y + dy), H - d.c.h) });
      else {
        let w = Math.max(40, Math.min(W - d.c.x, d.c.w + dx));
        let h = aspect ? w / aspect : Math.max(40, Math.min(H - d.c.y, d.c.h + dy));
        if (d.c.y + h > H) {
          h = H - d.c.y;
          if (aspect) w = h * aspect;
        }
        setCrop({ ...d.c, w, h });
      }
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const save = async () => {
    setBusy(true);
    try {
      if (animated && allowAnimated && !touched) {
        await onSave(file);
        return;
      }
      if (animated && allowAnimated && keepAnim) {
        // Every frame is edited on the server, so it keeps moving.
        const q = new URLSearchParams({ rot, flipH: flip.h ? 1 : 0, flipV: flip.v ? 1 : 0, x: crop.x, y: crop.y, w: crop.w, h: crop.h, ...adj, size: out.size, format: out.format === 'image/webp' ? 'webp' : 'gif', quality: out.quality });
        const r = await fetch(`/api/image/animated-edit?${q}`, { method: 'POST', body: file, headers: { 'X-MMM': '1', 'Content-Type': file.type || 'image/gif' } });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Editing the animation failed');
        await onSave(await r.blob());
        return;
      }
      const c = document.createElement('canvas');
      const scaleOut = Math.min(1, out.size / Math.max(crop.w, crop.h));
      c.width = Math.round(crop.w * scaleOut);
      c.height = Math.round(crop.h * scaleOut);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(canvas.current, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, out.format, out.quality));
      await onSave(blob);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const s = scale();
  return (
    <Modal
      title={title}
      size="wide"
      onClose={onClose}
      footer={
        <>
          {img && <span className="faint grow" style={{ fontSize: 12.5 }}>{animated && allowAnimated && !touched ? 'Animated: saved exactly as it is.' : animated && keepAnim ? 'Animated: every frame gets the edits.' : crop ? `${Math.round(Math.min(crop.w, out.size))} × ${Math.round(Math.min(crop.h, out.size * (crop.h / crop.w)))} px` : ''}</span>}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!img || busy} onClick={save}>{busy ? <Spinner size={14} /> : <Check />} Save picture</button>
        </>
      }
    >
      <div className="row wrap">
        <label className="btn">
          <Upload /> Choose a file
          <input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && load(e.target.files[0])} />
        </label>
        <div className="row grow" style={{ minWidth: 260 }}>
          <input className="input mono" placeholder="…or paste an image address" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url && fromUrl()} />
          <button className="btn" onClick={fromUrl} disabled={!url || busy}><Link2 /> Load</button>
        </div>
        <span className="faint" style={{ fontSize: 12.5 }}><Clipboard size={13} /> Ctrl V pastes a copied picture</span>
      </div>
      {!img && (
        <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.dataTransfer.files[0] && load(e.dataTransfer.files[0]); }}>
          <Upload className="big" />
          <div>Drop a picture here</div>
        </div>
      )}
      {img && (
        <div className="editor-grid">
          <div className="col" style={{ gap: 14 }}>
            {animated && allowAnimated && (
              <Notice kind="accent">
                This picture is animated.{' '}
                <label className="row" style={{ marginTop: 6, gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={keepAnim} onChange={(e) => setKeepAnim(e.target.checked)} /> Keep it moving (edits are applied to every frame)
                </label>
              </Notice>
            )}
            <Field label="Shape"><Segmented value={aspect} onChange={setAspect} options={ASPECTS} /></Field>
            <div className="row">
              <button className="btn icon" onClick={() => setRot((r) => (r + 90) % 360)} aria-label="Rotate"><RotateCw /></button>
              <button className="btn icon" onClick={() => setFlip((f) => ({ ...f, h: !f.h }))} aria-label="Flip sideways"><FlipHorizontal2 /></button>
              <button className="btn icon" onClick={() => setFlip((f) => ({ ...f, v: !f.v }))} aria-label="Flip upside down"><FlipVertical2 /></button>
              <button className="btn icon" onClick={() => setCrop({ x: 0, y: 0, w: W, h: aspect ? Math.min(H, W / aspect) : H })} aria-label="Whole picture"><Crop /></button>
              <button className="btn icon" onClick={() => { setAdj({ brightness: 100, contrast: 100, saturate: 100, blur: 0 }); setRot(0); setFlip({ h: false, v: false }); }} aria-label="Reset"><RefreshCcw /></button>
            </div>
            {[['brightness', 'Brightness', 30, 170], ['contrast', 'Contrast', 30, 170], ['saturate', 'Colour', 0, 200], ['blur', 'Blur', 0, 20]].map(([k, l, lo, hi]) => (
              <Field key={k} label={`${l} ${k === 'blur' ? `${adj[k]} px` : `${adj[k]}%`}`}>
                <input type="range" min={lo} max={hi} value={adj[k]} onChange={(e) => setAdj({ ...adj, [k]: Number(e.target.value) })} style={{ accentColor: 'var(--accent)' }} />
              </Field>
            ))}
            <div className="fields two">
              <Field label="Size">
                <select className="select" value={out.size} onChange={(e) => setOut({ ...out, size: Number(e.target.value) })}>
                  {[500, 800, 1200, 1600, 3000].map((x) => <option key={x} value={x}>{x} px</option>)}
                </select>
              </Field>
              <Field label="Format">
                <select className="select" value={out.format} onChange={(e) => setOut({ ...out, format: e.target.value })}>
                  {animated && keepAnim ? (
                    <>
                      <option value="image/gif">GIF (animated)</option>
                      <option value="image/webp">WebP (animated, smaller)</option>
                    </>
                  ) : (
                    <>
                      <option value="image/jpeg">JPEG</option>
                      <option value="image/png">PNG</option>
                      <option value="image/webp">WebP</option>
                    </>
                  )}
                </select>
              </Field>
            </div>
          </div>
          <div className="crop-stage" ref={stage}>
            <div style={{ position: 'relative', lineHeight: 0 }}>
              <canvas ref={canvas} />
              {crop && (
                <div className="crop-box" style={{ left: crop.x * s, top: crop.y * s, width: crop.w * s, height: crop.h * s }} onPointerDown={(e) => onDown(e, 'move')}>
                  <div className="h" onPointerDown={(e) => onDown(e, 'resize')} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
