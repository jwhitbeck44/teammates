import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { errorText, getMyRole, isRlsDenied } from '../../api/instructor';
import { ROLE_PERMISSIONS, type InstructorRole, type Permission } from '../../lib/types';
import '../../styles/instructor.css';

// ---------------------------------------------------------------------------
// Data loading

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  set: (v: T | null) => void;
}

/** Runs `fn` on mount and whenever `deps` change. `reload()` runs it again without clearing the data. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let active = true;
    setLoading(true);
    fnRef.current().then(
      (d) => {
        if (!active) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (!active) return;
        setError(errorText(e));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, set: setData };
}

/** Role of the signed-in user in a course, and a `can()` helper. The database still enforces everything. */
export function useCoursePerms(courseId: string | undefined) {
  const { user } = useAuth();
  const role = useLoad<InstructorRole | null>(
    () => (courseId && user ? getMyRole(courseId, user.id) : Promise.resolve(null)),
    [courseId, user?.id],
  );
  const r = role.data;
  return {
    loading: role.loading,
    role: r,
    can: (p: Permission): boolean => (r ? ROLE_PERMISSIONS[r][p] : false),
  };
}

// ---------------------------------------------------------------------------
// Small pieces

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="ins-error" role="alert">
      {error}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="ins-notice">{children}</p>;
}

export function Loading() {
  return <p className="ins-muted">Loading...</p>;
}

export interface Crumb {
  to?: string;
  label: string;
}

export function Page({ title, crumbs, children, wide }: { title: string; crumbs?: Crumb[]; children: ReactNode; wide?: boolean }) {
  const { user, signOut } = useAuth();
  return (
    <div className="ins">
      <header className="ins-top">
        <Link to="/" className="ins-brand">
          Peer feedback
        </Link>
        <span className="ins-top-right">
          <span className="ins-muted">{user?.email}</span>
          <button type="button" className="ins-link" onClick={() => void signOut()}>
            Sign out
          </button>
        </span>
      </header>
      <main className={wide ? 'ins-main ins-wide' : 'ins-main'}>
        {crumbs && crumbs.length > 0 && (
          <nav className="ins-crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i}>
                {c.to ? <Link to={c.to}>{c.label}</Link> : c.label}
                {i < crumbs.length - 1 ? ' / ' : ''}
              </span>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

/** A button that asks for confirmation (window.confirm) before it runs. */
export function ConfirmButton({
  onConfirm,
  message,
  children,
  disabled,
  className,
}: {
  onConfirm: () => void | Promise<void>;
  message: string;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        if (window.confirm(message)) void onConfirm();
      }}
    >
      {children}
    </button>
  );
}

/** Action runner for buttons: tracks busy state and error text. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setDenied(false);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      setDenied(isRlsDenied(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, denied, run };
}

// ---------------------------------------------------------------------------
// Files and text

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  // The byte order mark makes Excel read UTF-8 names correctly.
  const blob = new Blob(mime.startsWith('text/csv') ? ['﻿', text] : [text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(...parts: string[]): string {
  return parts
    .join('_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Where students open their pages: this app's origin and path plus `#/s/<token>`. */
export function appBaseUrl(): string {
  return window.location.origin + window.location.pathname;
}
