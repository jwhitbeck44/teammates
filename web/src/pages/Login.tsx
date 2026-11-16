import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import '../styles/instructor.css';

type Mode = 'signin' | 'signup' | 'reset';

export default function Login() {
  const { session, loading, signIn, signUp, requestPasswordReset } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && session) return <Navigate to={from} replace />;

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setMessage(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (email.trim() === '') {
      setError('Enter your email address.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') {
        const err = await signIn(email, password);
        if (err) setError(err);
        else navigate(from, { replace: true });
      } else if (mode === 'signup') {
        if (password.length < 8) {
          setError('Use a password of at least 8 characters.');
          return;
        }
        const r = await signUp(email, password);
        if (r.error) setError(r.error);
        else if (r.needsConfirmation) setMessage('Check your email for a confirmation link, then sign in.');
        else navigate(from, { replace: true });
      } else {
        const err = await requestPasswordReset(email);
        if (err) setError(err);
        else setMessage('If that address has an account, a reset link is on its way.');
      }
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'signin' ? 'Instructor sign in' : mode === 'signup' ? 'Create an instructor account' : 'Reset your password';

  return (
    <div className="ins ins-narrow">
      <h1>{title}</h1>
      <form onSubmit={submit} className="ins-form">
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        {mode !== 'reset' && (
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </label>
        )}
        {error && <p className="ins-error" role="alert">{error}</p>}
        {message && <p className="ins-ok">{message}</p>}
        <div className="ins-actions">
          <button type="submit" className="ins-primary" disabled={busy}>
            {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
          </button>
        </div>
      </form>
      <p className="ins-small">
        {mode !== 'signin' && (
          <>
            <button type="button" className="ins-link" onClick={() => switchMode('signin')}>Back to sign in</button>{' '}
          </>
        )}
        {mode === 'signin' && (
          <>
            <button type="button" className="ins-link" onClick={() => switchMode('signup')}>Create an account</button>
            {' | '}
            <button type="button" className="ins-link" onClick={() => switchMode('reset')}>Forgot your password?</button>
          </>
        )}
      </p>
      <p className="ins-muted ins-small">
        Students do not sign in. Use the personal link from your instructor, or <a href="#/recover">email me my links</a>.
      </p>
    </div>
  );
}
