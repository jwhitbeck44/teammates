import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../api/client';

interface AuthState {
  /** True until the first session lookup has finished. */
  loading: boolean;
  session: Session | null;
  user: User | null;
  /** The user id for which claim_instructor_invites() has finished (success or failure). */
  claimedFor: string | null;
  /** True after the user opened a password recovery link and has not set a new password yet. */
  recovering: boolean;
  signIn(email: string, password: string): Promise<string | null>;
  /** Returns an error message, or null. `needsConfirmation` is true when the project requires email confirmation. */
  signUp(email: string, password: string): Promise<{ error: string | null; needsConfirmation: boolean }>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<string | null>;
  updatePassword(password: string): Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [claimedFor, setClaimedFor] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    // Keep this callback synchronous: calling supabase from inside it can deadlock.
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (event === 'SIGNED_OUT') {
        setRecovering(false);
        setClaimedFor(null);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // After every sign-in (and on page load with a stored session) link invites sent to this email.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) return;
    let active = true;
    void supabase.rpc('claim_instructor_invites').then(() => {
      if (active) setClaimedFor(userId);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      user: session?.user ?? null,
      claimedFor,
      recovering,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        return error ? error.message : null;
      },
      async signUp(email, password) {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) return { error: error.message, needsConfirmation: false };
        return { error: null, needsConfirmation: data.session === null };
      },
      async signOut() {
        await supabase.auth.signOut();
      },
      async requestPasswordReset(email) {
        const redirectTo = window.location.origin + window.location.pathname;
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        return error ? error.message : null;
      },
      async updatePassword(password) {
        const { error } = await supabase.auth.updateUser({ password });
        if (!error) setRecovering(false);
        return error ? error.message : null;
      },
    }),
    [loading, session, claimedFor, recovering],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
