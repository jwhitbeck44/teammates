import { Link } from 'react-router-dom';
import { APP_NAME, BUILDERS, LOGO_ALT, LOGO_SRC } from '../../brand';

/** UCCS logo and app name. Links home only for signed-in instructors (`homeLink`). */
export function BrandMark({ homeLink }: { homeLink?: boolean }) {
  const name = <span className="brand-name">{APP_NAME}</span>;
  return (
    <span className="brand-mark">
      <img className="brand-logo" src={LOGO_SRC} alt={LOGO_ALT} />
      {homeLink ? (
        <Link to="/" className="brand-home">
          {name}
        </Link>
      ) : (
        name
      )}
    </span>
  );
}

/** Black UCCS bar for the student, sign-in and link-recovery pages. */
export function SiteHeader() {
  return (
    <header className="site-header">
      <BrandMark />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      Built for UCCS courses by {BUILDERS}. Not an official UCCS service.
    </footer>
  );
}
