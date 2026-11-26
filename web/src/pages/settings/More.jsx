import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { KeyRound, ShieldCheck, Plus, Trash2, Monitor, Network, RefreshCw, Copy, Download, Upload, FolderOpen, ExternalLink, Power, Rocket, Puzzle, Check, Terminal } from 'lucide-react';
import { useApp, useLoad } from '../../lib/app.jsx';
import { get, post, put, del, patch, api, download, uploadFile } from '../../lib/api.js';
import { ago, copy, cx, fmtSize, date } from '../../lib/util.js';
import { Field, Toggle, Notice, Segmented, Modal, Spinner, CopyField, JobDetails, useConfirm, Empty } from '../../components/ui.jsx';
import { Section, useSection } from './Settings.jsx';
import { ImageEditor } from '../../components/ImageEditor.jsx';

export function Account() {
  const { me, isAdmin, fail, toast, loadMe } = useApp();
  const confirm = useConfirm();
  const [pw, setPw] = useState({ current: '', password: '' });
  const [totp, setTotp] = useState(null);
  const sessions = useLoad(() => (me?.user ? get('account/sessions') : []), [me]);
  const apps = useLoad(() => (me?.user ? get('account/app-passwords') : []), [me]);
  const [newApp, setNewApp] = useState(null);
  const [made, setMade] = useState(null);
  const [auth, setAuth] = useSection('auth');
  const users = useLoad(() => (isAdmin && me?.user ? get('users') : []), [isAdmin, me]);
  const [newUser, setNewUser] = useState(null);
  const [pic, setPic] = useState(false);
  const startTotp = async () => {
    const r = await post('account/totp/start');
    setTotp({ ...r, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }), code: '' });
  };
  const dav = `${location.origin}/dav/`;
  return (
    <>
      <h1 className="page-title">Account & security</h1>
      {!me?.user && (
        <Notice kind="warn">
          Logins are off, so you’re using the app as a guest with full rights. {me?.needsAdmin ? <a href="/login">Create the admin account</a> : 'Log in to manage your account.'}
        </Notice>
      )}
      {me?.user && (
        <>
          <Section title={`Signed in as ${me.user.displayName}`} description={`Username ${me.user.username} · ${me.user.role === 'admin' ? 'admin' : 'member'} · ${me.user.provider === 'local' ? 'local account' : `logs in with ${me.user.provider}`}`}>
            <div className="row" style={{ gap: 14 }}>
              <span className="avatar-big" aria-hidden="true">{me.user.avatar ? <img src={me.user.avatar} alt="" /> : (me.user.displayName || '?')[0].toUpperCase()}</span>
              <div className="col" style={{ gap: 6 }}>
                <b style={{ fontSize: 13.5 }}>Profile picture</b>
                <div className="row wrap" style={{ gap: 6 }}>
                  <button className="btn small" onClick={() => setPic(true)}>{me.user.ownAvatar ? 'Change' : 'Add a picture'}</button>
                  {me.user.ownAvatar && <button className="btn small ghost" onClick={() => del('account/avatar').then(loadMe, fail)}>{me.user.provider === 'discord' ? 'Use my Discord picture' : 'Remove'}</button>}
                </div>
              </div>
            </div>
            {me.user.provider === 'local' && (
              <div className="fields two">
                <Field label="Current password"><input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
                <Field label="New password" hint="At least 8 characters. Logs out your other devices."><input className="input" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" /></Field>
                <div><button className="btn" disabled={pw.password.length < 8} onClick={() => post('account/password', pw).then(() => { toast('Password changed'); setPw({ current: '', password: '' }); }, fail)}><KeyRound /> Change password</button></div>
              </div>
            )}
          </Section>
          {me.user.provider === 'local' && (
            <Section title="Two-step login" description="Also ask for a code from an authenticator app (Aegis, 2FAS, Google Authenticator …).">
              {me.user.totp ? (
                <div className="row"><span className="badge ok"><ShieldCheck size={12} /> On</span><button className="btn small" onClick={async () => { const code = prompt('Enter a code from your app to turn it off'); if (code) post('account/totp/disable', { code }).then(() => { toast('Two-step login is off'); loadMe(); }, fail); }}>Turn off</button></div>
              ) : !totp ? (
                <button className="btn" onClick={startTotp}><ShieldCheck /> Set up</button>
              ) : (
                <div className="row wrap" style={{ gap: 20, alignItems: 'flex-start' }}>
                  <img src={totp.qr} alt="QR code for your authenticator app" style={{ borderRadius: 10, background: '#fff', padding: 6 }} />
                  <div className="col" style={{ minWidth: 260 }}>
                    <span className="muted">Scan it, or type this key:</span>
                    <CopyField value={totp.secret} />
                    <Field label="Code from the app"><input className="input mono" inputMode="numeric" value={totp.code} onChange={(e) => setTotp({ ...totp, code: e.target.value })} /></Field>
                    <button className="btn primary" onClick={() => post('account/totp/enable', { secret: totp.secret, code: totp.code }).then(() => { toast('Two-step login is on'); setTotp(null); loadMe(); }, fail)}><Check /> Turn on</button>
                  </div>
                </div>
              )}
            </Section>
          )}
          {!me.perms?.includes('download') && <AskDownloads />}
          <Section title="Where you’re logged in">
            {(sessions.data || []).map((s) => (
              <div key={s.id} className="row" style={{ padding: '4px 0' }}>
                <Monitor size={16} className="faint" />
                <span className="grow ellipsis" style={{ fontSize: 13 }}>{s.userAgent?.replace(/\(.*?\)/g, '').slice(0, 90) || 'Unknown'} <span className="faint">· {s.ip} · {ago(s.lastSeen)}</span></span>
                {s.current ? <span className="badge accent">this one</span> : <button className="btn small ghost" onClick={() => del(`account/sessions/${s.id}`).then(sessions.reload, fail)}>Log out</button>}
              </div>
            ))}
          </Section>
          <Section title="WebDAV & app passwords" description="Open your libraries in a file manager, Windows Explorer or Finder. Use your username and an app password (never your real password).">
            <Field label="Address"><CopyField value={dav} /></Field>
            {(apps.data || []).map((a) => (
              <div key={a.id} className="row">
                <KeyRound size={15} className="faint" />
                <span className="grow">{a.name} <span className="faint">· {a.scopes.includes('webdav:write') ? 'read & write' : 'read only'} · {a.last_used ? `used ${ago(a.last_used)}` : 'never used'}</span></span>
                <button className="btn small ghost danger" onClick={() => del(`account/app-passwords/${a.id}`).then(apps.reload, fail)}>Revoke</button>
              </div>
            ))}
            <div><button className="btn" onClick={() => setNewApp({ name: 'My laptop', write: false })}><Plus /> New app password</button></div>
          </Section>
        </>
      )}
      {isAdmin && (
        <>
          <Section title="Logging in" description="Who can use this app and how.">
            <Toggle checked={auth.required} onChange={(v) => setAuth({ required: v })} label="Require logging in" description="Strongly recommended as soon as this is reachable from outside your home." />
            {auth.required && (
              <Field label="People who aren’t logged in">
                <Segmented value={auth.guestAccess || 'none'} onChange={(v) => setAuth({ guestAccess: v })} options={[{ value: 'none', label: 'See the login page' }, { value: 'listen', label: 'Can listen to everything' }]} />
                <span className="hint">“Can listen”: they browse and play, see public stats and keep their look in their browser. They can’t download, change, or share anything.</span>
              </Field>
            )}
            <Toggle checked={auth.allowLocal} onChange={(v) => setAuth({ allowLocal: v })} label="Accounts made here" />
            <Toggle checked={auth.allowService} onChange={(v) => setAuth({ allowService: v })} label="Log in with Navidrome / Jellyfin / OpenSubsonic" description="Only for the servers added as libraries. People get their own playlists, favorites and shares." />
            {auth.allowService && (
              <Field label="People who log in this way are">
                <Segmented value={auth.serviceRole} onChange={(v) => setAuth({ serviceRole: v })} options={[{ value: 'user', label: 'Members' }, { value: 'mirror', label: 'Admins if they are admins there' }, { value: 'admin', label: 'Admins' }]} />
              </Field>
            )}
            <Field label="Stay logged in for (days)"><input className="input" type="number" min={1} max={365} value={auth.sessionDays || 30} onChange={(e) => setAuth({ sessionDays: Number(e.target.value) || 30 })} style={{ maxWidth: 140 }} /></Field>
          </Section>
          <Section title="Log in with Discord" description="Like on HomeSite. Make an application at discord.com/developers, add the redirect below.">
            <Toggle checked={auth.discord?.enabled} onChange={(v) => setAuth({ discord: { ...auth.discord, enabled: v } })} label="Discord login" />
            {auth.discord?.enabled && (
              <>
                <Field label="Redirect to add in Discord"><CopyField value={`${location.origin}/api/auth/discord/callback`} /></Field>
                <div className="fields two">
                  <Field label="Client ID"><input className="input mono" value={auth.discord?.clientId || ''} onChange={(e) => setAuth({ discord: { ...auth.discord, clientId: e.target.value } })} /></Field>
                  <Field label="Client secret"><input className="input mono" type="password" value={auth.discord?.clientSecret || ''} onChange={(e) => setAuth({ discord: { ...auth.discord, clientSecret: e.target.value } })} /></Field>
                  <Field label="Allowed Discord user IDs" hint="Empty = anyone with Discord"><input className="input mono" value={auth.discord?.allowedIds || ''} onChange={(e) => setAuth({ discord: { ...auth.discord, allowedIds: e.target.value } })} /></Field>
                  <Field label="Admin Discord user IDs"><input className="input mono" value={auth.discord?.adminIds || ''} onChange={(e) => setAuth({ discord: { ...auth.discord, adminIds: e.target.value } })} /></Field>
                </div>
              </>
            )}
          </Section>
          {me?.user && (
            <>
            <Section title="People">
              {(users.data || []).map((u) => (
                <div key={u.id} className="row" style={{ padding: '4px 0' }}>
                  <b className="grow">{u.displayName} <span className="faint" style={{ fontWeight: 400 }}>@{u.username} · {u.provider} · {u.lastLogin ? `last in ${ago(u.lastLogin)}` : 'never logged in'}</span></b>
                  <select className="select" style={{ width: 120, height: 32 }} value={u.role} onChange={(e) => patch(`users/${u.id}`, { role: e.target.value }).then(users.reload, fail)} disabled={u.id === me.user.id} title={me.roles?.[u.role]}>
                    <option value="admin">Admin</option><option value="user">User</option><option value="visitor">Visitor</option>
                  </select>
                  {u.role !== 'admin' && (
                    <label className="row" style={{ gap: 4, fontSize: 12.5 }} title="Can download songs and exports">
                      <input type="checkbox" checked={u.extraPerms?.includes('download')} onChange={(e) => patch(`users/${u.id}`, { extraPerms: e.target.checked ? [...(u.extraPerms || []), 'download'] : (u.extraPerms || []).filter((x) => x !== 'download') }).then(users.reload, fail)} /> downloads
                    </label>
                  )}
                  {u.totp && <button className="btn small ghost" onClick={() => patch(`users/${u.id}`, { resetTotp: true }).then(() => { toast('Two-step login reset'); users.reload(); }, fail)}>Reset 2-step</button>}
                  {u.id !== me.user.id && <button className="btn icon small ghost danger" onClick={async () => { if (await confirm({ title: `Remove ${u.username}?`, danger: true, confirm: 'Remove' })) del(`users/${u.id}`).then(users.reload, fail); }} aria-label="Remove"><Trash2 /></button>}
                </div>
              ))}
              <div><button className="btn" onClick={() => setNewUser({ username: '', password: '', role: 'user' })}><Plus /> Add a person</button></div>
              <div className="faint" style={{ fontSize: 12.5 }}>{Object.entries(me.roles || {}).map(([k, v]) => <div key={k}><b>{k[0].toUpperCase() + k.slice(1)}</b>: {v}</div>)}</div>
            </Section>
            <DownloadRequests />
            </>
          )}
        </>
      )}
      {newApp && (
        <Modal title="New app password" onClose={() => setNewApp(null)} footer={<><button className="btn ghost" onClick={() => setNewApp(null)}>Cancel</button><button className="btn primary" onClick={() => post('account/app-passwords', newApp).then((r) => { setMade(r); setNewApp(null); apps.reload(); }, fail)}>Create</button></>}>
          <Field label="For what"><input className="input" value={newApp.name} onChange={(e) => setNewApp({ ...newApp, name: e.target.value })} /></Field>
          <Toggle checked={newApp.write} onChange={(v) => setNewApp({ ...newApp, write: v })} label="Allow changes" description="Off = read only. Deleting moves files to the app’s trash." />
        </Modal>
      )}
      {made && <Modal title="Your app password" onClose={() => setMade(null)}><p className="muted" style={{ margin: 0 }}>Shown only now. Log in to <span className="mono">{dav}</span> with your username and this:</p><CopyField value={made.password} /></Modal>}
      {newUser && (
        <Modal title="Add a person" onClose={() => setNewUser(null)} footer={<><button className="btn ghost" onClick={() => setNewUser(null)}>Cancel</button><button className="btn primary" onClick={() => post('users', newUser).then(() => { setNewUser(null); users.reload(); }, fail)}>Add</button></>}>
          <Field label="Username"><input className="input" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></Field>
          <Field label="Password" hint="They can change it later."><input className="input" type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></Field>
          <Segmented value={newUser.role} onChange={(v) => setNewUser({ ...newUser, role: v })} options={[{ value: 'admin', label: 'Admin' }, { value: 'user', label: 'User' }, { value: 'visitor', label: 'Visitor' }]} />
          <span className="faint" style={{ fontSize: 12.5 }}>{me?.roles?.[newUser.role]}</span>
        </Modal>
      )}
      {pic && (
        <ImageEditor
          title="Your profile picture"
          allowAnimated={false}
          initialUrl={me?.user?.ownAvatar ? me.user.avatar : undefined}
          onClose={() => setPic(false)}
          onSave={async (blob) => {
            await api('account/avatar', { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'image/png' } });
            setPic(false);
            await loadMe();
            toast('Picture saved', { kind: 'ok' });
          }}
        />
      )}
    </>
  );
}

function AskDownloads() {
  const { fail, toast } = useApp();
  const st = useLoad(() => get('account/download-request'), []);
  const [note, setNote] = useState('');
  return (
    <Section title="Downloads" description="Downloading songs needs an admin’s OK here.">
      {st.data?.status === 'open' ? <span className="badge warn">Asked {ago(st.data.created_at)}. Waiting for an admin.</span> : st.data?.status === 'declined' ? <span className="badge danger">Declined. You can ask again.</span> : null}
      {st.data?.status !== 'open' && (
        <div className="row">
          <input className="input" placeholder="Why? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn" onClick={() => post('download-requests', { note }).then(() => { toast('Asked. An admin will see it in their settings.'); st.reload(); }, fail)}>Ask for downloads</button>
        </div>
      )}
    </Section>
  );
}

function DownloadRequests() {
  const { fail } = useApp();
  const { data, reload } = useLoad(() => get('download-requests'), []);
  if (!data?.length) return null;
  return (
    <Section title="People asking for downloads">
      {data.map((r) => (
        <div key={r.id} className="row">
          <span className="grow"><b>{r.display_name || r.username}</b> <span className="faint">{ago(r.created_at)}{r.note ? ` · “${r.note}”` : ''}</span></span>
          <button className="btn small primary" onClick={() => post(`download-requests/${r.id}`, { approve: true }).then(reload, fail)}>Allow</button>
          <button className="btn small ghost" onClick={() => post(`download-requests/${r.id}`, { approve: false }).then(reload, fail)}>Decline</button>
        </div>
      ))}
    </Section>
  );
}

const MODES = [
  ['catalog', 'See its songs', 'Keeps a list of what it has, also while it’s off.'],
  ['stream', 'Play from it', 'Songs only it has play from there (when it’s reachable).'],
  ['host', 'It is my host', 'Send my settings, stats, listens and song list to it.'],
  ['mirror', 'Copy everything it has', 'A full backup: songs I don’t have are copied here.'],
  ['settings', 'Take its look & rules', 'Use its theme, naming and format settings.'],
  ['serve', 'Let it see and play mine', 'Off hides my songs from it.'],
  ['acceptFiles', 'Accept songs it sends', 'For “move / copy to” from that side.'],
  ['allowRemove', 'Let it remove songs here', 'For “remove from everywhere”.'],
];

export function Instances() {
  const { fail, toast, afterJob } = useApp();
  const confirm = useConfirm();
  const { data, reload } = useLoad(() => get('nodes'), []);
  const states = useLoad(() => get('nodes/states'), []);
  const [code, setCode] = useState(null);
  const [join, setJoin] = useState('');
  const [joining, setJoining] = useState(false);
  const make = async () => setCode(await post('nodes/code', {}).catch(fail));
  const doJoin = async () => {
    setJoining(true);
    try {
      const n = await post('nodes/join', { code: join, modes: { catalog: true, stream: true } });
      toast(`Linked with ${n.name}`);
      setJoin('');
      reload();
    } catch (e) {
      fail(e);
    }
    setJoining(false);
  };
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Linked instances</h1>
          <p className="page-sub">Link Master Music Manager on other machines (your server and your PC, say). They share song lists, play each other’s songs, can back each other up, and keep working when one is off.</p>
        </div>
        <button className="btn" onClick={async () => { const r = await post('nodes/sync'); toast('Syncing…'); afterJob(r.job).then(reload); }}><RefreshCw /> Sync now</button>
      </div>
      {data?.self && (
        <Section title={`This one: ${data.self.name}`}>
          <div className="faint" style={{ fontSize: 13 }}>
            On your network: {data.self.lanUrls.map((u) => <span key={u} className="mono" style={{ marginRight: 10 }}>{u}</span>)}<br />
            Public: {data.self.publicUrl ? <span className="mono">{data.self.publicUrl}</span> : 'not set (Settings → General)'}
          </div>
        </Section>
      )}
      <div className="fields two">
        <Section title="Link another one to this" description="1. Make a code here. 2. Paste it on the other machine under “Join”. It works for 30 minutes, once.">
          {!code ? <button className="btn primary" onClick={make}><Network /> Make a code</button> : (
            <>
              <CopyField value={code.code} />
              <span className="faint" style={{ fontSize: 12.5 }}>It contains {code.urls.local ? <span className="mono">{code.urls.local}</span> : 'no LAN address'} and {code.urls.public ? <span className="mono">{code.urls.public}</span> : 'no public address'}. The other side tries the LAN address first.</span>
            </>
          )}
        </Section>
        <Section title="Join another one" description="Paste the code you made on the other machine.">
          <textarea className="textarea mono" rows={3} value={join} onChange={(e) => setJoin(e.target.value)} placeholder="mmm1.…" />
          <div><button className="btn primary" onClick={doJoin} disabled={!join.trim() || joining}>{joining ? <Spinner size={14} /> : <Check />} Link</button></div>
        </Section>
      </div>
      {(data?.nodes || []).map((n) => (
        <div key={n.id} className="panel">
          <div className="row">
            <span className={cx('dot', n.online ? 'ok' : 'off')} />
            <b className="grow">{n.name}</b>
            <span className="faint" style={{ fontSize: 12.5 }}>{n.online ? `online via ${n.lastUrl === n.localUrl ? 'your network' : 'the internet'}` : n.lastError ? `offline: ${n.lastError}` : 'not seen yet'} · {n.tracks} songs · seen {ago(n.lastSeen)}</span>
            <button className="btn icon small ghost danger" aria-label="Unlink" onClick={async () => { if (await confirm({ title: `Unlink ${n.name}?`, body: 'Both sides forget each other. No songs are deleted.', danger: true, confirm: 'Unlink' })) del(`nodes/${n.id}`).then(reload, fail); }}><Trash2 /></button>
          </div>
          <div className="fields two" style={{ marginTop: 12 }}>
            <Field label="Address on your network"><input className="input mono" defaultValue={n.localUrl || ''} onBlur={(e) => e.target.value !== (n.localUrl || '') && patch(`nodes/${n.id}`, { localUrl: e.target.value }).then(reload, fail)} /></Field>
            <Field label="Public address"><input className="input mono" defaultValue={n.publicUrl || ''} onBlur={(e) => e.target.value !== (n.publicUrl || '') && patch(`nodes/${n.id}`, { publicUrl: e.target.value }).then(reload, fail)} /></Field>
          </div>
          <div className="fields two" style={{ marginTop: 8 }}>
            {MODES.map(([k, l, d]) => (
              <Toggle key={k} checked={n.modes[k] !== false && (n.modes[k] || ['catalog', 'stream', 'serve', 'acceptFiles', 'allowRemove'].includes(k))} onChange={(v) => patch(`nodes/${n.id}`, { modes: { [k]: v } }).then(reload, fail)} label={l} description={d} />
            ))}
          </div>
        </div>
      ))}
      {states.data?.length > 0 && (
        <Section title="Instances that use this one as their host" description="Their last known state, kept here even while they’re off.">
          {states.data.map((s) => (
            <div key={s.id} className="row"><b className="grow">{s.name}</b><span className="faint" style={{ fontSize: 12.5 }}>version {s.version} · last report {ago(s.at)} · {s.stats?.reduce((a, x) => a + x.tracks, 0) || 0} songs</span></div>
          ))}
        </Section>
      )}
    </>
  );
}

export function Plugin() {
  const { profiles, fail, toast } = useApp();
  const st = useLoad(() => get('plugin/status'), []);
  const upd = useLoad(() => get('update'), []);
  const [secret, setSecret] = useState(null);
  const nd = profiles.find((p) => p.kind === 'navidrome');
  // Navidrome on this same machine reaches us fastest (and without the internet) on localhost.
  const sameMachine = (() => {
    try {
      return ['localhost', '127.0.0.1', '::1'].includes(new URL(nd?.url || '').hostname);
    } catch {
      return false;
    }
  })();
  const [where, setWhere] = useState(null);
  const place = where ?? (sameMachine ? 'here' : 'other');
  const url = place === 'here' && st.data?.port ? `http://localhost:${st.data.port}` : location.origin;
  const script = 'https://raw.githubusercontent.com/Master3307/master-music-manager/master/scripts/install-plugin.sh';
  return (
    <>
      <h1 className="page-title">Navidrome plugin</h1>
      <p className="page-sub">A small plugin that runs inside Navidrome. It sends every play to Master Music Manager the moment it happens (from every app, not just this one), copies Navidrome’s whole listening history once, and serves the artist texts you write here back to Navidrome.</p>
      <Section title="Status">
        {st.data?.lastSeen ? <span className="badge ok"><Check size={12} /> Last heard from {ago(st.data.lastSeen)}{st.data.version ? ` · version ${st.data.version}` : ''}</span> : <span className="badge">Not connected yet</span>}
        {upd.data?.latest?.plugin && <span className="faint" style={{ fontSize: 13 }}>Newest plugin: {upd.data.latest.plugin.version}</span>}
      </Section>
      <Section title="Install it" description="One command on the machine where Navidrome runs. It finds Navidrome by itself (as a service, a plain program or in Docker), installs the plugin, connects it and switches it on.">
        <Segmented
          value={place}
          onChange={setWhere}
          options={[
            { value: 'here', label: 'Navidrome is on this machine' },
            { value: 'other', label: 'On another machine' },
          ]}
        />
        {place === 'here' ? (
          <>
            <Field label="Run this on the machine" hint="It makes a new secret itself, so nothing to copy.">
              <CopyField value="sudo mmm plugin" />
            </Field>
            <span className="faint" style={{ fontSize: 12.5 }}>In a Proxmox container: <span className="mono">pct exec &lt;id&gt; -- mmm plugin</span></span>
          </>
        ) : secret ? (
          <Field label="Run this on the Navidrome machine" hint="Navidrome has to reach this address. If it doesn’t, the command says so.">
            <CopyField value={`curl -fsSL ${script} | sudo bash -s -- --url ${url} --secret ${secret}`} />
          </Field>
        ) : (
          <div>
            <button className="btn primary" onClick={() => post('plugin/secret').then((r) => setSecret(r.secret), fail)}><KeyRound /> Make the command</button>
            <span className="faint" style={{ fontSize: 12.5, marginLeft: 10 }}>Makes a new secret; an older one stops working.</span>
          </div>
        )}
        {!nd && <Notice>None of your libraries is a Navidrome server. The plugin only works with Navidrome.</Notice>}
      </Section>
      <Section title="By hand" description="Without a terminal, for example on Windows.">
        <ol className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            Download <b>master-music-manager.ndp</b> from the <a href="https://github.com/Master3307/master-music-manager/releases?q=plugin&expanded=true" target="_blank" rel="noopener noreferrer">latest plugin release <ExternalLink size={12} /></a> into Navidrome’s <span className="mono">plugins</span> folder (inside its data folder) and restart Navidrome.
          </li>
          <li>Make a secret: choose “On another machine” above and press the button.</li>
          <li>Navidrome → Plugins → Master Music Manager: paste the address and the secret, allow all users, and enable it.</li>
        </ol>
        <Field label="Address"><CopyField value={url} /></Field>
        {secret && <Field label="Secret"><CopyField value={secret} /></Field>}
      </Section>
      <Notice>The plugin needs to reach this address. If Navidrome runs on another machine, use an address it can reach (LAN IP or public URL).</Notice>
      {toast && null}
    </>
  );
}

export function Backup() {
  const { fail, toast } = useApp();
  const [exp, setExp] = useState({ includeSecrets: false, passphrase: '' });
  const [imp, setImp] = useState({ mode: 'merge', passphrase: '', file: null });
  const [result, setResult] = useState(null);
  const doImport = async () => {
    try {
      const id = await uploadFile(imp.file);
      const r = await post('backup/import', { upload: id, mode: imp.mode, passphrase: imp.passphrase });
      setResult(r);
      toast('Backup imported');
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <h1 className="page-title">Backup</h1>
      <p className="page-sub">Settings, accounts, libraries, playlists made here, shares, listens, artist texts and links. Music files are not included (they’re your library itself).</p>
      <Section title="Save a backup">
        <Toggle checked={exp.includeSecrets} onChange={(v) => setExp({ ...exp, includeSecrets: v })} label="Include server passwords and 2-step keys" description="Encrypted with a passphrase. Without it, you type server passwords again after restoring." />
        {exp.includeSecrets && <Field label="Passphrase"><input className="input" type="password" value={exp.passphrase} onChange={(e) => setExp({ ...exp, passphrase: e.target.value })} /></Field>}
        <div><button className="btn primary" disabled={exp.includeSecrets && exp.passphrase.length < 6} onClick={() => download('/api/backup/export', exp, 'mmm-backup.json').catch(fail)}><Download /> Download backup</button></div>
      </Section>
      <Section title="Restore a backup">
        <label className="btn" style={{ alignSelf: 'flex-start' }}><Upload /> {imp.file ? imp.file.name : 'Choose the file'}<input type="file" accept=".json" hidden onChange={(e) => setImp({ ...imp, file: e.target.files[0] })} /></label>
        <Segmented value={imp.mode} onChange={(v) => setImp({ ...imp, mode: v })} options={[{ value: 'merge', label: 'Add to what’s here' }, { value: 'replace', label: 'Replace what’s here' }]} />
        <Field label="Passphrase (if it has one)"><input className="input" type="password" value={imp.passphrase} onChange={(e) => setImp({ ...imp, passphrase: e.target.value })} /></Field>
        <div><button className="btn primary" disabled={!imp.file} onClick={doImport}>Restore</button></div>
        {result && <Notice kind="accent">Imported: {Object.entries(result.counts).map(([k, n]) => `${n} ${k}`).join(', ')}. Restart the app to be safe (System &amp; updates).</Notice>}
      </Section>
    </>
  );
}

export function Logs() {
  const { fail } = useApp();
  const { data, reload } = useLoad(() => get('logs'), []);
  const [view, setView] = useState(null);
  const audit = useLoad(() => get('audit', { limit: 200 }), []);
  const open = async (name) => setView({ name, text: await api(`/api/logs/file?name=${encodeURIComponent(name)}&tail=400000`).catch(fail) });
  return (
    <>
      <div className="page-head">
        <h1 className="page-title grow">Logs</h1>
        <a className="btn" href="/api/logs/export"><Download /> Export all</a>
        <button className="btn ghost" onClick={reload}><RefreshCw /></button>
      </div>
      <Section title="Where they are" description="On the machine running Master Music Manager.">
        {data && <CopyField value={data.dir} />}
        <div className="row wrap">
          <a className="btn small" href="/settings/logs" onClick={(e) => { e.preventDefault(); open('mmm.log'); }}><FolderOpen /> Open the app log</a>
          <span className="faint" style={{ fontSize: 12.5 }}>On the server: <span className="mono">journalctl -u master-music-manager -f</span> or <span className="mono">mmm logs</span></span>
        </div>
      </Section>
      <Section title="Files">
        {(data?.files || []).slice(0, 200).map((f) => (
          <div key={f.name} className="row" style={{ padding: '3px 0' }}>
            <span className="mono grow ellipsis" style={{ fontSize: 12.5 }}>{f.name}</span>
            <span className="faint" style={{ fontSize: 12 }}>{fmtSize(f.size)} · {ago(f.modified)}</span>
            <button className="btn small ghost" onClick={() => open(f.name)}>Show</button>
            <a className="btn small ghost" href={`/api/logs/file?name=${encodeURIComponent(f.name)}&download=1`} aria-label="Download"><Download /></a>
          </div>
        ))}
      </Section>
      <Section title="Latest lines">
        <pre className="codeblock" style={{ maxHeight: 300 }}>{(data?.recent || []).slice(-150).map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.level.padEnd(5)} ${l.msg}`).join('\n') || 'Nothing yet.'}</pre>
      </Section>
      <Section title="What changed (audit log)">
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {(audit.data || []).map((a) => (
            <div key={a.id} className="row" style={{ fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="faint" style={{ width: 130 }}>{new Date(a.ts).toLocaleString()}</span>
              <b style={{ width: 120 }}>{a.username || 'system'}</b>
              <span className="mono grow ellipsis">{a.action} {a.detail}</span>
            </div>
          ))}
        </div>
      </Section>
      {view && (
        <Modal title={view.name} size="xl" onClose={() => setView(null)} footer={<><button className="btn" onClick={() => copy(view.text)}><Copy /> Copy</button><a className="btn" href={`/api/logs/file?name=${encodeURIComponent(view.name)}&download=1`}><Download /> Download</a></>}>
          <pre className="codeblock" style={{ maxHeight: 'none', flex: 1 }}>{view.text}</pre>
        </Modal>
      )}
    </>
  );
}

export function System() {
  const { fail, toast, setUpdate } = useApp();
  const confirm = useConfirm();
  const sys = useLoad(() => get('system'), []);
  const upd = useLoad(() => get('update'), []);
  const start = useLoad(() => get('startup'), []);
  const [job, setJob] = useState(null);
  const check = async () => {
    const r = await get('update', { force: 1 });
    upd.setData(r);
    setUpdate(r);
    toast(r.update ? `Version ${r.latest.version} is out` : r.disabled ? 'Update checks are off (privacy)' : 'You have the newest version');
  };
  const s = sys.data;
  const u = upd.data;
  return (
    <>
      <h1 className="page-title">System & updates</h1>
      <Section title="Version">
        <div className="row wrap">
          <b>Master Music Manager {u?.version || s?.version}</b>
          {u?.update ? <span className="badge accent">{u.latest.version} is out</span> : u?.latest ? <span className="badge ok">up to date</span> : null}
          <span className="grow" />
          <button className="btn" onClick={check}><RefreshCw /> Check now</button>
          <button className="btn primary" onClick={async () => { if (await confirm({ title: 'Update now?', body: 'Downloads the newest version, builds it and restarts. Takes a minute or two.', confirm: 'Update' })) post('update').then((r) => setJob(r.job), fail); }}><Rocket /> Update {u?.update ? `to ${u.latest.version}` : 'anyway'}</button>
        </div>
        {u?.update && u.latest.notes && <pre className="codeblock" style={{ maxHeight: 200 }}>{u.latest.notes}</pre>}
        {job && <JobDetails jobId={job} defaultOpen live />}
      </Section>
      <Section title="Start and stop">
        <div className="row wrap">
          <button className="btn" onClick={async () => { if (await confirm({ title: 'Restart Master Music Manager?', body: 'Takes a few seconds. Running jobs stop.', confirm: 'Restart' })) { await post('restart').catch(fail); toast('Restarting…'); setTimeout(() => location.reload(), 5000); } }}><Power /> Restart</button>
        </div>
        {start.data && (
          <>
            <Toggle
              checked={start.data.installed}
              onChange={async (v) => { const r = await post('startup', { enable: v }).catch(fail); if (r) setJob(r.job); setTimeout(start.reload, 2500); }}
              label="Start with the computer"
              description={start.data.platform !== 'linux' ? 'Only automatic on Linux (systemd). See the README for other systems.' : start.data.system ? 'As a system service (runs before anyone logs in).' : 'As a user service, kept running when you log out.'}
            />
            <details className="details"><summary>Service file</summary><pre className="codeblock">{start.data.unit}</pre></details>
          </>
        )}
      </Section>
      {s && (
        <Section title="This machine">
          <div className="faint mono" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            {s.hostname} · {s.platform} · Node {s.node}<br />
            Data: {s.dataDir} · Logs: {s.logDir}<br />
            Port {s.port} · {s.lanUrls.join(' · ')}<br />
            Running for {Math.round(s.uptime / 60)} min · {fmtSize(s.memory)} memory · installed from {s.install}{s.supervised ? ' · managed by systemd' : ''}
          </div>
        </Section>
      )}
      <Section title="From the command line" description="Everything here also works in a terminal on the server.">
        <pre className="codeblock">{`mmm status          # is it running, version, address
mmm update          # update to the newest version and restart
mmm restart         # restart
mmm logs            # follow the log
mmm scan [--full]   # read the library folders again
mmm backup out.json # save a backup
mmm doctor          # check FFmpeg, spotDL, yt-dlp, permissions
mmm password <user> # set a new password for someone
mmm help            # everything else`}</pre>
      </Section>
      <p className="faint" style={{ fontSize: 12.5 }}><Terminal size={13} /> Installed as a system service? <span className="mono">sudo systemctl status master-music-manager</span> · <span className="mono">journalctl -u master-music-manager -f</span></p>
      {date && null}
    </>
  );
}

export { Puzzle, Empty, put };
