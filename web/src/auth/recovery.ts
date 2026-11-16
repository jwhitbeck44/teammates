// Password recovery under HashRouter (review finding F7).
//
// The reset link comes back as `<app>/?code=...` (PKCE flow, no hash). supabase-js exchanges the code while the
// client is created and emits PASSWORD_RECOVERY from a timer, which can fire before React has mounted. This
// module subscribes at import time, remembers that the event happened, and sends the user to the guarded root
// route, where RequireAuth shows the set-new-password screen while `recovering` is true.
// Not verified against a live project.
import { supabase } from '../api/client';

let pending = false;
const listeners = new Set<() => void>();

/** True after PASSWORD_RECOVERY fired and the new password has not been saved yet. */
export const recoveryPending = (): boolean => pending;

export function clearRecovery(): void {
  pending = false;
}

/** Calls `cb` when a recovery starts. Returns an unsubscribe function. */
export function onRecovery(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Remove a leftover `?code=` from the address bar, keeping the hash route. supabase-js normally does it already. */
export function stripAuthCode(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('code')) return;
  url.searchParams.delete('code');
  window.history.replaceState(window.history.state, '', url.toString());
}

if (typeof window !== 'undefined') {
  // Synchronous callback only: supabase calls from inside it can deadlock.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      pending = true;
      if (window.location.hash !== '#/') window.location.hash = '#/';
      listeners.forEach((cb) => cb());
    }
    if (event === 'SIGNED_OUT') pending = false;
    if (event !== 'INITIAL_SESSION') stripAuthCode();
  });
}
