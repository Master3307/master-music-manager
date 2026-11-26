import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { KeyRound, Server, ShieldCheck } from 'lucide-react';
import { useApp } from '../lib/app.jsx';
import { post } from '../lib/api.js';
import { Logo, Field, Notice, Segmented, Toggle } from '../components/ui.jsx';

const ERRORS = { state: 'The login took too long or was opened twice. Try again.', discord: 'Discord login failed. Try again.', 'not-allowed': 'This Discord account is not allowed here.', 'discord-off': 'Discord login is switched off.' };

export default function Login() {
  const { me } = useApp();
  const [params] = useSearchParams();
  const services = me?.methods?.services || [];
  const [mode, setMode] = useState(me?.needsAdmin ? 'create' : me?.methods?.local !== false ? 'local' : 'service');
  const [f, setF] = useState({ username: '', password: '', code: '', profileId: services[0]?.id, requireLogin: true, displayName: '' });
  const [needsCode, setNeedsCode] = useState(false);
  const [err, setErr] = useState(ERRORS[params.get('error')] || null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [codeOk, setCodeOk] = useState(!me?.setupNeedsCode);
  if (me?.user) return <Navigate to="/" replace />;
  if (me?.guest && !me?.needsAdmin) return <Navigate to="/" replace />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'create') await post('auth/setup-admin', { username: f.username, password: f.password, displayName: f.displayName, requireLogin: f.requireLogin, setupCode: code });
      else if (mode === 'local') {
        const r = await post('auth/login', { username: f.username, password: f.password, code: needsCode ? f.code : undefined });
        if (r.needsCode) {
          setNeedsCode(true);
          setBusy(false);
          return;
        }
      } else await post('auth/service-login', { profileId: f.profileId, username: f.username, password: f.password });
      location.href = '/';
    } catch (e2) {
      setErr(e2.message);
    }
    setBusy(false);
  };

  if (mode === 'create' && !codeOk)
    return (
      <div className="center-page">
        <div className="ambient" style={{ '--ambient': 'var(--accent)' }} aria-hidden="true" />
        <form
          className="auth-card"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await post('auth/setup-code', { setupCode: code });
              setCodeOk(true);
            } catch (e2) {
              setErr(e2.message);
            }
          }}
        >
          <Logo size={44} />
          <h1>Almost ready</h1>
          <p className="muted">
            Nobody has set up this Master Music Manager yet. To make sure it’s you, type the setup code from the server. Get it by running <span className="mono">mmm setup-code</span> there (on Proxmox: <span className="mono">pct exec &lt;id&gt; -- mmm setup-code</span>). It’s also in the log.
          </p>
          <div className="col" style={{ gap: 12, marginTop: 14 }}>
            <Field label="Setup code">
              <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoFocus autoComplete="off" spellCheck={false} />
            </Field>
            {err && <Notice kind="danger">{err}</Notice>}
            <button className="btn primary" disabled={code.replace(/[^A-Z0-9]/g, '').length < 8} style={{ height: 42 }}><ShieldCheck /> Continue</button>
          </div>
        </form>
      </div>
    );

  const options = [me?.methods?.local !== false && { value: 'local', label: 'Account' }, services.length && { value: 'service', label: 'Music server' }].filter(Boolean);
  return (
    <div className="center-page">
      <div className="ambient" style={{ '--ambient': 'var(--accent)' }} aria-hidden="true" />
      <form className="auth-card" onSubmit={submit}>
        <Logo size={44} />
        <h1>{mode === 'create' ? 'Create the admin account' : 'Log in to Master Music Manager'}</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          {mode === 'create' ? 'This account can change every setting. You can add more people later.' : mode === 'service' ? 'Use the same login as on your music server.' : 'Welcome back.'}
        </p>
        {mode !== 'create' && options.length > 1 && (
          <div style={{ margin: '14px 0' }}>
            <Segmented value={mode} onChange={setMode} options={options} />
          </div>
        )}
        <div className="col" style={{ gap: 12, marginTop: 14 }}>
          {mode === 'service' && (
            <Field label="Server">
              <select className="select" value={f.profileId} onChange={set('profileId')}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.kind === 'jellyfin' ? 'Jellyfin' : s.kind === 'navidrome' ? 'Navidrome' : 'OpenSubsonic'}, {s.host})
                  </option>
                ))}
              </select>
            </Field>
          )}
          {mode === 'create' && (
            <Field label="Your name" hint="Shown in the app. Optional.">
              <input className="input" value={f.displayName} onChange={set('displayName')} autoComplete="name" />
            </Field>
          )}
          {!needsCode && (
            <>
              <Field label="Username">
                <input className="input" value={f.username} onChange={set('username')} autoComplete="username" autoFocus required />
              </Field>
              <Field label="Password" hint={mode === 'create' ? 'At least 8 characters.' : undefined}>
                <input className="input" type="password" value={f.password} onChange={set('password')} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} required minLength={mode === 'create' ? 8 : undefined} />
              </Field>
            </>
          )}
          {needsCode && (
            <Field label="Code from your authenticator app" hint="6 digits. It changes every 30 seconds.">
              <input className="input mono" value={f.code} onChange={set('code')} inputMode="numeric" autoComplete="one-time-code" autoFocus pattern="[0-9 ]{6,7}" required />
            </Field>
          )}
          {mode === 'create' && (
            <Toggle checked={f.requireLogin} onChange={(v) => setF({ ...f, requireLogin: v })} label="Require logging in" description="Recommended. Without it, anyone who can open this address can change everything." />
          )}
          {err && <Notice kind="danger">{err}</Notice>}
          <button className="btn primary" disabled={busy} style={{ height: 42 }}>
            {mode === 'create' ? <ShieldCheck /> : mode === 'service' ? <Server /> : <KeyRound />}
            {busy ? 'One moment…' : mode === 'create' ? 'Create account' : needsCode ? 'Check code' : 'Log in'}
          </button>
          {me?.methods?.discord && mode !== 'create' && (
            <a className="btn" href="/api/auth/discord" style={{ height: 42 }}>
              Log in with Discord
            </a>
          )}
        </div>
      </form>
    </div>
  );
}
