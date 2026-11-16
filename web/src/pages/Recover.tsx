import { FormEvent, useState } from 'react';
import { recoverLinks } from '../api/student';
import { ErrorMessage, Page } from '../components/common';

export const RECOVER_CONFIRMATION =
  'If this email is on a course roster, we have sent your links. Check your spam folder too.';

export default function Recover() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (email.trim() === '') return;
    setBusy(true);
    setError('');
    try {
      await recoverLinks(email);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Get your links">
      {done ? (
        <p role="status">{RECOVER_CONFIRMATION}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <p>Enter the email your instructor has for you.</p>
          <div className="field">
            <label htmlFor="recover-email">Email</label>
            <input
              id="recover-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Sending...' : 'Email me my links'}
            </button>
          </div>
        </form>
      )}
    </Page>
  );
}
