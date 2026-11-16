import { getInstructorSubmission, instructorSubmit, type AnswerRows } from '../../api/instructor';
import SubmissionForm from '../submission/SubmissionForm';
import { ErrorBox, Loading, useLoad } from './ui';

/** The signed-in instructor's own answers to the instructor-giver questions of a session. */
export default function InstructorAnswers({ sessionId }: { sessionId: string }) {
  const payload = useLoad(() => getInstructorSubmission(sessionId), [sessionId]);
  if (payload.loading && !payload.data) return <Loading />;
  if (payload.error) return <ErrorBox error={payload.error} />;
  if (!payload.data) return null;
  return (
    <SubmissionForm
      payload={payload.data}
      onSaveQuestion={async (questionId: string, answers: AnswerRows[]) => {
        await instructorSubmit(sessionId, questionId, answers);
      }}
    />
  );
}
