import { useParams } from 'react-router-dom';
import StudentView from '../../components/instructor/StudentView';

export default function SessionModerate() {
  const { sessionId, studentId } = useParams<{ sessionId: string; studentId: string }>();
  return <StudentView sessionId={sessionId!} studentId={studentId!} mode="moderate" />;
}
