import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { FolderTree, Check, Download, Copy, Archive, FileText, RotateCcw, Trash2, Star } from 'lucide-react';
import { useApp, useLoad } from '../lib/app.jsx';
import { get, post, put, del, download } from '../lib/api.js';
import { fmtSize, plural, ago, copy, cx } from '../lib/util.js';
import { useMenus } from '../components/menus.jsx';
import { Empty, Field, Notice, Spinner, Segmented, Toggle, useConfirm, Modal, JobProgress } from '../components/ui.jsx';

const VARS = ['{title}', '{artist}', '{album}', '{albumartist}', '{folderartist}', '{primaryartist}', '{year}', '{track:2}', '{disc}', '{genre:first}', '{label}', '{ext}', '{artist:initial}', '{album|title}', '{?disctotal>1:CD{disc}/}', '{tag.NAME}'];

export function Organize() {
  const { pid, caps, settings, saveSetting, fail, toast, afterJob, jobs } = useApp();
  const [tpl, setTpl] = useState(settings?.library?.template || '');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(null); // the job moving the files
  const dirty = tpl !== settings?.library?.template;
  const run = async () => {
    setBusy(true);
    try {
      if (dirty) await saveSetting('library', { template: tpl });
      setPreview(await post(`p/${pid}/organize`, query ? { query } : {}));
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  const apply = async () => {
    try {
      const r = await post(`p/${pid}/organize`, { ...(query ? { query } : {}), apply: true });
      setMoving(r.job);
      setPreview(null);
      afterJob(r.job).then((j) => toast(j.status === 'done' ? `Moved ${j.result.moved} files` : j.error, { kind: j.status === 'done' ? 'ok' : 'error' }));
    } catch (e) {
      fail(e);
    }
  };
  if (!caps.files) return <Empty icon={FolderTree} title="Needs the music folder">Link the folder in Settings → Libraries.</Empty>;
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Organize</h1>
          <p className="page-sub">Rename and move files so the folders follow one layout. You see every move before anything happens.</p>
        </div>
      </div>
      {moving && jobs[moving] && <JobProgress job={jobs[moving]} onDone={() => setMoving(null)} what="Moving files" />}
      <div className="panel">
        <Field label="Folder layout" hint="Folders are separated by /. The file extension is added for you.">
          <input className="input mono" value={tpl} onChange={(e) => setTpl(e.target.value)} spellCheck={false} />
        </Field>
        <div className="chips" style={{ marginTop: 10 }}>
          {VARS.map((v) => <button key={v} className="chip mono" onClick={() => setTpl((t) => `${t}${v}`)}>{v}</button>)}
        </div>
        <p className="faint" style={{ fontSize: 12.5, marginBottom: 0 }}>
          <span className="mono">{'{a|b}'}</span> uses b when a is empty · <span className="mono">{'{track:2}'}</span> pads to 2 digits · <span className="mono">{'{?cond:text}'}</span> only when the condition holds (field, !field, field&gt;1, field=value) · <span className="mono">:upper :lower :title :first :initial</span>
        </p>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <input className="input mono grow" placeholder="Only songs matching this filter (empty = all)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" onClick={run} disabled={busy}>{busy ? <Spinner size={14} /> : <FolderTree />} Show what would move</button>
      </div>
      {preview && (
        <section className="section">
          <div className="section-head">
            <h2>{preview.total ? `${plural(preview.total, 'file')} would move` : 'Everything is already in place'}</h2>
            {preview.total > 0 && <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={apply}><Check /> Move {plural(preview.total, 'file')}</button>}
          </div>
          <div className="col" style={{ gap: 0 }}>
            {preview.preview.map((it) => (
              <div key={it.id} className="mono" style={{ fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="change-old ellipsis">{it.path}</div>
                <div className="change-new ellipsis">{it.move}</div>
              </div>
            ))}
            {preview.total > preview.preview.length && <p className="faint">… and {preview.total - preview.preview.length} more.</p>}
          </div>
        </section>
      )}
    </>
  );
}

export function Export() {
  const { pid, caps, fail, toast } = useApp();
  const formats = useLoad(() => get('export/formats'), []);
  const [kind, setKind] = useState('list');
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const [f, setF] = useState({ format: 'template', template: '{artist} - {title}', preset: 'useful', header: true, title: 'My music' });
  const [a, setA] = useState({ format: 'zip', layout: 'library', template: '{folderartist}/{album}/{track:2} {title}', includeList: true, name: 'music' });
  const [text, setText] = useState(null);
  const body = () => ({ ...(scope === 'filter' ? { query } : {}) });
  const doList = async (mode) => {
    try {
      if (mode === 'copy' || mode === 'show') {
        const r = await post(`p/${pid}/export/list`, { ...f, ...body(), inline: true });
        if (mode === 'copy') {
          await copy(r.text);
          toast(`Copied ${plural(r.count, 'song')}`);
        } else setText(r.text);
      } else await download(`/api/p/${pid}/export/list`, { ...f, ...body() }, 'music.txt');
    } catch (e) {
      fail(e);
    }
  };
  const doArchive = async () => {
    try {
      const r = await post(`p/${pid}/export/archive`, { ...a, ...body() });
      toast(`Preparing ${plural(r.count, 'song')} (${fmtSize(r.size)})…`);
      window.location.href = r.url;
    } catch (e) {
      fail(e);
    }
  };
  if (!caps.files) return <Empty icon={Archive} title="Needs the music folder">Exports read your files, so link the folder first.</Empty>;
  const F = formats.data;
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Export</h1>
          <p className="page-sub">A list of your songs in any format, or the music itself as an archive.</p>
        </div>
        <Segmented value={kind} onChange={setKind} options={[{ value: 'list', label: 'A list', icon: FileText }, { value: 'archive', label: 'The music files', icon: Archive }]} />
      </div>
      <div className="panel">
        <Field label="Which songs">
          <Segmented value={scope} onChange={setScope} options={[{ value: 'all', label: 'All songs' }, { value: 'filter', label: 'Only a filter' }]} />
        </Field>
        {scope === 'filter' && <input className="input mono" style={{ marginTop: 10 }} placeholder='genre:phonk year>2020   (same as in Library)' value={query} onChange={(e) => setQuery(e.target.value)} />}
      </div>
      {!F && <Spinner />}
      {F && kind === 'list' && (
        <div className="panel">
          <div className="fields two">
            <Field label="Format">
              <select className="select" value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>
                {Object.entries(F.lists).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Title" hint="Used in playlists and the web page"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          </div>
          <p className="faint" style={{ margin: '8px 0' }}>{F.lists[f.format]?.note}</p>
          {f.format === 'template' && (
            <Field label="Line pattern" hint="Any field in braces: {artist} - {title} ({year}) · {track:2}. {album} · {length}">
              <input className="input mono" value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })} />
            </Field>
          )}
          {['csv', 'tsv', 'json', 'ndjson', 'md', 'html'].includes(f.format) && (
            <Field label="What to include">
              <Segmented value={f.preset} onChange={(v) => setF({ ...f, preset: v })} options={Object.entries(F.presets).map(([k, v]) => ({ value: k, label: v.label }))} />
            </Field>
          )}
          {f.preset === 'useful' && ['csv', 'tsv', 'json', 'md', 'html'].includes(f.format) && <p className="faint" style={{ fontSize: 12.5 }}>Useful = artist, title, album, album artist, year, track, disc, genre, length, format, bitrate, path. “All” adds every tag any song has, including custom ones.</p>}
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={() => doList('download')}><Download /> Download</button>
            <button className="btn" onClick={() => doList('copy')}><Copy /> Copy</button>
            <button className="btn ghost" onClick={() => doList('show')}>Show</button>
          </div>
        </div>
      )}
      {F && kind === 'archive' && (
        <div className="panel">
          <Field label="Archive type">
            <div className="col" style={{ gap: 8 }}>
              {Object.entries(F.archives).map(([k, v]) => (
                <button key={k} className={cx('choice', a.format === k && 'active')} onClick={() => setA({ ...a, format: k })} disabled={!v.available} style={!v.available ? { opacity: 0.5 } : undefined}>
                  <Archive />
                  <span>
                    <b>{v.label} {v.recommended && <span className="badge accent"><Star size={11} /> Recommended</span>}</b>
                    <small>{v.why}{!v.available ? ' (not installed on this server)' : ''}</small>
                  </span>
                </button>
              ))}
            </div>
          </Field>
          <div className="fields two" style={{ marginTop: 14 }}>
            <Field label="Folders inside">
              <select className="select" value={a.layout} onChange={(e) => setA({ ...a, layout: e.target.value })}>
                <option value="library">Same as the library</option>
                <option value="flat">All files in one folder</option>
                <option value="template">My own layout</option>
              </select>
            </Field>
            <Field label="Name"><input className="input" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></Field>
          </div>
          {a.layout === 'template' && <Field label="Layout"><input className="input mono" value={a.template} onChange={(e) => setA({ ...a, template: e.target.value })} /></Field>}
          <div style={{ marginTop: 10 }}><Toggle checked={a.includeList} onChange={(v) => setA({ ...a, includeList: v })} label="Put a playlist (.m3u8) inside" /></div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={doArchive}><Download /> Download archive</button>
            <span className="faint" style={{ fontSize: 12.5 }}>It’s built while it downloads, so it starts right away even for huge libraries.</span>
          </div>
        </div>
      )}
      {text != null && (
        <Modal title="Export" size="wide" onClose={() => setText(null)} footer={<button className="btn" onClick={() => copy(text).then(() => toast('Copied'))}><Copy /> Copy</button>}>
          <pre className="codeblock" style={{ maxHeight: '60vh' }}>{text}</pre>
        </Modal>
      )}
    </>
  );
}

/** Songs taken out of the library (their files untouched), with a way back. */
function TakenOut() {
  const { pid, fail, toast } = useApp();
  const list = useLoad(() => (pid ? get(`p/${pid}/taken-out`) : []), [pid]);
  const back = async (paths) => {
    try {
      const r = await post(`p/${pid}/taken-out/back`, { paths });
      toast(`${plural(r.back, 'song')} back in the library`, { kind: 'ok' });
      list.reload();
    } catch (e) {
      fail(e);
    }
  };
  if (!list.data?.length) return null;
  return (
    <div className="panel col" style={{ gap: 6, marginBottom: 18 }}>
      <div className="row">
        <b className="grow">Taken out ({list.data.length})</b>
        <button className="btn small primary" onClick={() => back(list.data.map((x) => x.path))}><RotateCcw /> Take all back in</button>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Their files are where they always were; they’re just not shown or changed here.</p>
      {list.data.map((x) => (
        <div key={x.path} className="row" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis">{x.title || x.path.split('/').pop()} <span className="faint">{x.artist ? `· ${x.artist}` : ''}</span></div>
            <div className="faint mono ellipsis" style={{ fontSize: 12 }}>{x.path} · {ago(x.at)}</div>
          </div>
          <button className="btn small" onClick={() => back([x.path])}><RotateCcw /> Take back in</button>
        </div>
      ))}
    </div>
  );
}

export function Trash() {
  const { fail, toast } = useApp();
  const confirm = useConfirm();
  const menus = useMenus();
  const putBack = async (x) => {
    try {
      await post(`trash/${encodeURIComponent(x.id)}/restore`);
      toast('Put back');
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const { data, loading, reload } = useLoad(() => get('trash'), []);
  const total = (data || []).reduce((a, x) => a + (x.size || 0), 0);
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Trash</h1>
          <p className="page-sub">Everything removed in Master Music Manager waits here until you empty it. {data ? `${plural(data.length, 'file')}, ${fmtSize(total)}.` : ''}</p>
        </div>
        <button className="btn" onClick={async () => { if (await confirm({ title: 'Empty files older than 30 days?', confirm: 'Empty', danger: true })) { const r = await del('trash', { olderThanDays: 30 }); toast(`${r.removed} files deleted`); reload(); } }}>Older than 30 days</button>
        <button className="btn danger" onClick={async () => { if (await confirm({ title: 'Empty the trash?', body: 'The files are deleted for good.', confirm: 'Delete forever', danger: true })) { const r = await del('trash'); toast(`${r.removed} files deleted`); reload(); } }}><Trash2 /> Empty the trash</button>
      </div>
      {loading && <Spinner />}
      <TakenOut />
      {data && !data.length && <Empty icon={Trash2} title="The trash is empty" />}
      {(data || []).map((x) => (
        <div key={x.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }} onContextMenu={(e) => menus.custom(e, x.path.split('/').pop(), [{ label: 'Put back', icon: RotateCcw, onClick: () => putBack(x) }, { label: 'Copy the path', icon: Copy, onClick: () => navigator.clipboard.writeText(x.path).then(() => toast('Copied')) }])}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="mono ellipsis" style={{ fontSize: 13 }}>{x.path}</div>
            <div className="faint" style={{ fontSize: 12 }}>{ago(x.at)} · {fmtSize(x.size)}{x.via ? ` · via ${x.via}` : ''}</div>
          </div>
          <button className="btn small" onClick={async () => { try { await post(`trash/${encodeURIComponent(x.id)}/restore`); toast('Put back'); reload(); } catch (e) { fail(e); } }}><RotateCcw /> Put back</button>
        </div>
      ))}
    </>
  );
}

export { Link, useEffect, useMemo, put };
