import { useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

function SetNewPassword() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setBusy(true);
    setError(await updatePassword(password));
    setBusy(false);
  }

  return (
    <div className="ins ins-narrow">
      <h1>Set a new password</h1>
      <form onSubmit={submit} className="ins-form">
        <label>
          New password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <p className="ins-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Save password</button>
      </form>
    </div>
  );
}

/** Wraps instructor routes: waits for the session and the invite claim, redirects to /login when signed out. */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, session, claimedFor, recovering } = useAuth();
  const location = useLocation();
  if (loading) return <div className="ins ins-narrow"><p>Loading...</p></div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (recovering) return <SetNewPassword />;
  if (claimedFor !== session.user.id) return <div className="ins ins-narrow"><p>Loading...</p></div>;
  return <>{children}</>;
}
