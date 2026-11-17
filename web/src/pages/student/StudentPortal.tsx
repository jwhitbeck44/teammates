import { Link, useParams } from 'react-router-dom';
import { studentPortal } from '../../api/student';
import type { PortalSession } from '../../api/student';
import { ErrorMessage, Loading, Page, TimeText, useLoad, useNow } from '../../components/common';
import { STATUS_LABELS, answeredText, effectiveStatus, isInvalidToken, printedDeadline, timeLeftText } from '../../lib/studentView';
import InvalidLink from './InvalidLink';

export default function StudentPortal() {
  const { token = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => studentPortal(token), [token]);
  const now = useNow();

  if (loading) return <Page title="Your sessions"><Loading /></Page>;
  if (error && isInvalidToken(error)) return <InvalidLink />;
  if (error || !data) {
    return (
      <Page title="Your sessions">
        <ErrorMessage>{error?.message ?? 'Could not load.'}</ErrorMessage>
        <p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </p>
      </Page>
    );
  }

  const tz = data.course.time_zone;
  return (
    <Page
      title={data.course.name}
      subtitle={
        <>
          {data.student.name}, team {data.student.team}
        </>
      }
    >
      {data.sessions.length === 0 ? <p>No sessions yet. Check back later.</p> : null}
      <ul className="cards">
        {data.sessions.map((s) => (
          <SessionCard key={s.id} s={s} token={token} tz={tz} now={now} />
        ))}
      </ul>
    </Page>
  );
}

function SessionCard({ s, token, tz, now }: { s: PortalSession; token: string; tz: string; now: number }) {
  // The real cutoff (s.deadline, close time plus grace) decides open, late period and closed. The page prints the
  // close time or the student's extension (s.shown_deadline), and the countdown runs to that time.
  const status = effectiveStatus(s.status, s.deadline, now, s.shown_deadline);
  const canSubmit = status === 'open' || status === 'grace';
  const shown = printedDeadline(s);
  const left = canSubmit ? timeLeftText(shown, now) : '';
  const progress = answeredText(s.questions_answered, s.questions_answerable);
  const allDone = progress !== null ? s.questions_answerable! > 0 && s.questions_answered === s.questions_answerable : s.submitted;
  return (
    <li className="card">
      <h2>{s.name}</h2>
      <p>
        <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>{' '}
        <span className={`badge ${allDone ? 'badge-done' : 'badge-todo'}`}>
          {progress ?? (s.submitted ? 'Submitted' : 'Not submitted')}
        </span>
      </p>
      <p>
        Deadline: <TimeText value={shown} timeZone={tz} />
        {left ? ` (${left})` : ''}
      </p>
      <div className="actions">
        {canSubmit ? (
          <Link className="button primary" to={`/s/${token}/sessions/${s.id}`}>
            {s.submitted ? 'Edit answers' : 'Answer'}
          </Link>
        ) : null}
        {s.published ? (
          <Link className="button" to={`/s/${token}/results/${s.id}`}>
            View results
          </Link>
        ) : null}
        {!canSubmit && !s.published ? <span className="hint">Results are not out yet.</span> : null}
      </div>
    </li>
  );
}
