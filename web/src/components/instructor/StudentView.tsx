import { Link } from 'react-router-dom';
import { getCourse, getPreview, getSession, instructorModerate, type AnswerRows } from '../../api/instructor';
import SubmissionForm from '../submission/SubmissionForm';
import { ErrorBox, Loading, Page, useLoad } from './ui';

/**
 * Shared page body for moderating and previewing one student's submission.
 * `instructor_preview` returns the student's own payload with their saved answers, ignoring open and close times.
 */
export default function StudentView({ sessionId, studentId, mode }: { sessionId: string; studentId: string; mode: 'moderate' | 'preview' }) {
  const payload = useLoad(() => getPreview(sessionId, studentId), [sessionId, studentId]);
  const session = useLoad(() => getSession(sessionId), [sessionId]);
  const courseId = session.data?.course_id;
  const course = useLoad(() => (courseId ? getCourse(courseId) : Promise.resolve(null)), [courseId]);
  const p = payload.data;
  const name = p?.student?.name ?? 'the student';
  const other = mode === 'moderate' ? 'preview' : 'moderate';

  const crumbs = [
    { to: '/', label: 'Courses' },
    { to: courseId ? `/courses/${courseId}` : undefined, label: course.data?.code ?? '...' },
    { to: `/sessions/${sessionId}/status`, label: session.data?.name ?? '...' },
    { label: mode === 'moderate' ? 'Moderate' : 'Preview' },
  ];

  const banner = (
    <div className={mode === 'moderate' ? 'ins-notice' : 'ins-ok'}>
      {mode === 'moderate' ? (
        <strong>You are editing {name}'s answers.</strong>
      ) : (
        <strong>Preview: this is what {name} sees. Nothing can be saved here.</strong>
      )}{' '}
      {mode === 'moderate' ? 'Saved answers are marked as changed by you. The deadline does not apply to you. ' : ''}
      <Link to={`/sessions/${sessionId}/${other}/${studentId}`}>{mode === 'moderate' ? 'Open the read-only preview' : 'Moderate instead'}</Link>
      {' | '}
      <Link to={`/sessions/${sessionId}/status`}>Back to status</Link>
    </div>
  );

  return (
    <Page title={mode === 'moderate' ? `Moderate: ${name}` : `Preview: ${name}`} crumbs={crumbs}>
      <ErrorBox error={payload.error} />
      {payload.loading && !p && <Loading />}
      {p && (
        <SubmissionForm
          key={`${sessionId}/${studentId}`}
          payload={p}
          readOnly={mode === 'preview'}
          banner={banner}
          onSaveQuestion={
            mode === 'moderate'
              ? async (questionId: string, answers: AnswerRows[]) => {
                  await instructorModerate(sessionId, questionId, studentId, answers);
                }
              : undefined
          }
        />
      )}
    </Page>
  );
}
