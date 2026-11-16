import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { studentGetSession, studentSubmit } from '../../api/student';
import type { StudentSessionPayload } from '../../api/student';
import { ErrorMessage, Loading, Page, TimeText, useLoad, useNow } from '../../components/common';
import SubmissionForm from '../../components/submission/SubmissionForm';
import { isInvalidToken, timeLeftText } from '../../lib/studentView';
import { toMs } from '../../lib/time';
import InvalidLink from './InvalidLink';

export default function StudentSubmit() {
  const { token = '', sessionId = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => studentGetSession(token, sessionId), [token, sessionId]);
  const [closedByServer, setClosedByServer] = useState(false);
  const back = (
    <p>
      <Link to={`/s/${token}`}>Back to your sessions</Link>
    </p>
  );

  if (loading) return <Page title="Loading"><Loading /></Page>;
  if (error && isInvalidToken(error)) return <InvalidLink />;
  if (error?.code === 'not_open_yet') {
    return (
      <Page title="Not open yet">
        <p>This session is not open yet. Check back later.</p>
        {back}
      </Page>
    );
  }
  if (error || !data) {
    return (
      <Page title="Could not load">
        <ErrorMessage>{error?.message ?? 'Could not load.'}</ErrorMessage>
        <p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </p>
        {back}
      </Page>
    );
  }

  const closed = data.session.status === 'closed' || closedByServer;
  return (
    <Page title={data.session.name} subtitle={data.course.name}>
      {back}
      <SubmissionForm
        key={data.session.id}
        payload={data}
        readOnly={closed}
        banner={<DeadlineBanner payload={data} closed={closed} />}
        onSaveQuestion={async (questionId, answers) => {
          try {
            await studentSubmit(token, sessionId, questionId, answers);
          } catch (e) {
            if ((e as { code?: string }).code === 'deadline_passed') setClosedByServer(true);
            throw e;
          }
        }}
      />
    </Page>
  );
}

function DeadlineBanner({ payload, closed }: { payload: StudentSessionPayload; closed: boolean }) {
  const now = useNow();
  const { session, course } = payload;
  const left = timeLeftText(session.deadline, now);
  const pastOnMyClock = toMs(now) >= toMs(session.deadline);
  return (
    <div className={`banner${closed ? ' banner-closed' : ''}`}>
      <p>
        <strong>Deadline:</strong> <TimeText value={session.deadline} timeZone={course.time_zone} />
        {left ? ` (${left})` : ''}
      </p>
      {closed ? (
        <p>
          <strong>Closed.</strong> You can see your answers but not change them.
        </p>
      ) : session.status === 'grace' ? (
        <p>
          <strong>Late period.</strong> The session has closed. Save now.
        </p>
      ) : pastOnMyClock ? (
        <p>The deadline looks passed. Saving may be refused.</p>
      ) : (
        <p>Save each question. You can come back and edit until the deadline.</p>
      )}
    </div>
  );
}
