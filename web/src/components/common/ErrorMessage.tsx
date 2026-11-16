import type { ReactNode } from 'react';

/** An error box. Not colour only: it has the word "Error" and role="alert". */
export default function ErrorMessage({ children, title = 'Error' }: { children: ReactNode; title?: string }) {
  return (
    <div className="error-box" role="alert">
      <strong>{title}: </strong>
      {children}
    </div>
  );
}
