import { Link } from 'react-router-dom';
import { Page } from '../../components/common';

/** Shown when the token in the URL does not match a student. */
export default function InvalidLink() {
  return (
    <Page title="This link does not work">
      <p>The link may be old or copied wrong. Get your links by email.</p>
      <p>
        <Link className="button primary" to="/recover">
          Email me my links
        </Link>
      </p>
    </Page>
  );
}
