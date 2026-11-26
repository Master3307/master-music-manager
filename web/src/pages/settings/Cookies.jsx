import { useRef, useState } from 'react';
import { Cookie, Upload, RefreshCw, Trash2, CircleCheck, CircleAlert, CircleHelp, ChevronDown } from 'lucide-react';
import { useApp, useLoad } from '../../lib/app.jsx';
import { get, post, del, api } from '../../lib/api.js';
import { ago, date } from '../../lib/util.js';
import { Notice, Spinner, useConfirm } from '../../components/ui.jsx';

/** Upload, check and remove the YouTube cookies (stored sealed on the server). */
export function YouTubeCookies({ legacyField }) {
  const { fail, toast } = useApp();
  const confirm = useConfirm();
  const st = useLoad(() => get('downloads/cookies'), []);
  const [busy, setBusy] = useState(null); // 'upload' | 'check'
  const [guide, setGuide] = useState(false);
  const input = useRef(null);
  const s = st.data;

  const upload = async (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return fail(new Error('That file is too big for a cookies.txt'));
    setBusy('upload');
    try {
      const r = await api('downloads/cookies', { method: 'PUT', body: await file.text(), headers: { 'Content-Type': 'text/plain' } });
      st.setData(r);
      toast(r.check?.ok ? 'Cookies saved, and they work' : 'Cookies saved', { kind: r.check?.ok ? 'ok' : undefined });
    } catch (e) {
      fail(e);
    }
    setBusy(null);
    if (input.current) input.current.value = '';
  };
  const check = async () => {
    setBusy('check');
    try {
      const c = await post('downloads/cookies/check');
      st.setData({ ...s, check: c });
    } catch (e) {
      fail(e);
    }
    setBusy(null);
  };

  const c = s?.check;
  const state = !s?.present ? 'none' : busy === 'check' ? 'checking' : c?.ok === true ? 'ok' : c?.ok === false ? 'bad' : 'unknown';
  const soon = s?.expires && s.expires - Date.now() < 14 * 86_400_000;
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="cookie-status" data-state={state}>
        {state === 'ok' ? <CircleCheck /> : state === 'bad' ? <CircleAlert /> : state === 'checking' ? <Spinner size={16} /> : state === 'none' ? <Cookie /> : <CircleHelp />}
        <div className="grow" style={{ minWidth: 0 }}>
          <b>{state === 'ok' ? 'Working' : state === 'bad' ? 'Not working' : state === 'checking' ? 'Checking…' : state === 'none' ? 'No cookies yet' : 'Not checked yet'}</b>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {s?.present
              ? [c?.message, `${s.count} YouTube cookies`, s.loggedIn ? null : 'no login in them', s.expires ? `the login runs until ${date(s.expires)}` : null, c?.at ? `checked ${ago(c.at)}` : null, s.refreshedAt ? `renewed ${ago(s.refreshedAt)}` : null].filter(Boolean).join(' · ')
              : s?.legacyPath
                ? `Using the file ${s.legacyPath}. Upload it here instead to keep it encrypted and see whether it works.`
                : 'Without them, YouTube refuses age-restricted songs and sometimes asks the server to “confirm you’re not a bot”.'}
          </div>
        </div>
      </div>
      {soon && state !== 'bad' && <Notice kind="warn">The login in these cookies ends soon ({date(s.expires)}). Export new ones before then.</Notice>}
      <div className="row wrap" style={{ gap: 6 }}>
        <input ref={input} type="file" accept=".txt,text/plain" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <button className="btn small primary" disabled={Boolean(busy)} onClick={() => input.current?.click()}>{busy === 'upload' ? <Spinner size={14} /> : <Upload />} {s?.present ? 'Upload new ones' : 'Upload cookies.txt'}</button>
        {s?.present && <button className="btn small" disabled={Boolean(busy)} onClick={check}><RefreshCw /> Check now</button>}
        {s?.present && <button className="btn small ghost danger" disabled={Boolean(busy)} onClick={async () => { if (await confirm({ title: 'Remove the YouTube cookies?', body: 'Downloads go on without a login.', confirm: 'Remove', danger: true })) del('downloads/cookies').then(st.setData, fail); }}><Trash2 /> Remove</button>}
        <button className="btn small ghost" onClick={() => setGuide(!guide)} aria-expanded={guide}><ChevronDown style={{ transform: guide ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} /> How do I get them?</button>
      </div>
      {guide && (
        <div className="panel cookie-guide">
          <ol>
            <li>Install the browser extension <b>Get cookies.txt LOCALLY</b> (<a href="https://github.com/kairi003/Get-cookies.txt-LOCALLY" target="_blank" rel="noopener noreferrer">its page, with links for Chrome, Edge, Brave and Firefox</a>). It’s open source and sends nothing anywhere.</li>
            <li>Open a <b>private window</b> (allow the extension there) and log in to <a href="https://www.youtube.com" target="_blank" rel="noopener noreferrer">youtube.com</a>. Best with a second Google account, not your main one.</li>
            <li>While youtube.com is open, click the extension and <b>Export</b> (format: Netscape). You get a cookies.txt file.</li>
            <li><b>Close the private window</b> right away, without logging out. Using YouTube there again would make these cookies stop working.</li>
            <li>Upload the file here. It’s checked straight away.</li>
          </ol>
          <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
            Cookies are a login, so treat the file like a password and delete it after uploading. Here they’re saved once, encrypted on the server, and used for every download until you remove them: only the YouTube and Google cookies, never shown again. More in <a href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies" target="_blank" rel="noopener noreferrer">yt-dlp’s guide</a>.
          </p>
        </div>
      )}
      {!s?.present && legacyField}
      {st.loading && !s && <Spinner />}
    </div>
  );
}
