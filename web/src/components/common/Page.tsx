import type { ReactNode } from 'react';

/** Page frame for the student pages: one column, a title, optional subtitle. */
export default function Page({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="page">
      <h1>{title}</h1>
      {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      {children}
    </main>
  );
}
