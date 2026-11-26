// Little things that make it feel like cheating:
// - paste a link anywhere (not in a field) → "Get this?" with one click;
// - drop music files anywhere on the app → they're uploaded right away.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Download, X, Upload } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { useAdding } from '../lib/adding.jsx';
import { post } from '../lib/api.js';
import { plural } from '../lib/util.js';

const MEDIA = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|wv|ape|wma|aiff?|alac|dsf|mka|mp4|mkv|webm|mov|zip|rar|7z|tar|gz)$/i;
const inField = (el) => el?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');

export function Shortcuts() {
  const { pid, can, toast, fail, settings } = useApp();
  const add = useAdding();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [offer, setOffer] = useState(null); // pasted links
  const [dragging, setDragging] = useState(false);
  const canAdd = can('manage');

  useEffect(() => {
    if (!canAdd) return;
    const onPaste = (e) => {
      if (inField(e.target) || pathname === '/add') return;
      const text = e.clipboardData?.getData('text') || '';
      const links = text.match(/https?:\/\/[^\s<>"]+/g);
      if (links?.length) setOffer([...new Set(links)].slice(0, 50));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [canAdd, pathname]);

  useEffect(() => {
    if (!canAdd || pathname === '/add') return; // that page has its own drop area
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e) => hasFiles(e) && e.preventDefault();
    const drop = (e) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...e.dataTransfer.files].filter((f) => MEDIA.test(f.name) || /^(audio|video)\//.test(f.type));
      if (!files.length) return toast('Those aren’t songs, videos or archives.');
      add.addFiles(files, pid);
      toast(`Uploading ${plural(files.length, 'file')}. They wait in Check & import.`);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [canAdd, pathname, pid, add, toast]);

  const get = async () => {
    const links = offer;
    setOffer(null);
    try {
      await post('downloads', { input: links.join('\n'), profileId: pid, autoImport: settings?.downloads?.reviewBeforeImport === false });
      toast(`Getting ${plural(links.length, 'link')}. ${settings?.downloads?.reviewBeforeImport === false ? 'They go straight into your library.' : 'They wait in Check & import.'}`, { kind: 'ok' });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      {offer && (
        <div className="paste-offer" role="dialog" aria-label="Get the pasted link">
          <Download />
          <div className="grow" style={{ minWidth: 0 }}>
            <b>Get {offer.length > 1 ? `these ${offer.length} links` : 'this'}?</b>
            <div className="faint ellipsis mono" style={{ fontSize: 12 }}>{offer[0]}</div>
          </div>
          <button className="btn small ghost" onClick={() => { add.setDraft(offer.join('\n')); setOffer(null); nav('/add'); }}>Check first</button>
          <button className="btn small primary" onClick={get}>Get it</button>
          <button className="btn icon small ghost" onClick={() => setOffer(null)} aria-label="No"><X /></button>
        </div>
      )}
      {dragging && (
        <div className="drop-everywhere" aria-hidden="true">
          <Upload />
          <b>Drop to add to your library</b>
          <span>Songs, videos or archives</span>
        </div>
      )}
    </>
  );
}
