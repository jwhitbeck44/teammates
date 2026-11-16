import { useParams } from 'react-router-dom';
import StudentView from '../../components/instructor/StudentView';

export default function SessionPreview() {
  const { sessionId, studentId } = useParams<{ sessionId: string; studentId: string }>();
  return <StudentView sessionId={sessionId!} studentId={studentId!} mode="preview" />;
}
