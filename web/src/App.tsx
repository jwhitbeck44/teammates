import { Navigate, Route, Routes } from 'react-router-dom';
import Login from './pages/Login';
import Recover from './pages/Recover';
import InstructorHome from './pages/instructor/Home';
import CourseDetail from './pages/instructor/CourseDetail';
import CourseEnroll from './pages/instructor/CourseEnroll';
import SessionEdit from './pages/instructor/SessionEdit';
import SessionStatus from './pages/instructor/SessionStatus';
import SessionResults from './pages/instructor/SessionResults';
import SessionPreview from './pages/instructor/SessionPreview';
import SessionModerate from './pages/instructor/SessionModerate';
import StudentPortal from './pages/student/StudentPortal';
import StudentSubmit from './pages/student/StudentSubmit';
import StudentResults from './pages/student/StudentResults';

// Route table only. Pages are filled in by later build steps.
// CourseDetail renders the tabs: sessions, students, instructors, settings.
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<InstructorHome />} />
      <Route path="/courses/:courseId" element={<CourseDetail />} />
      <Route path="/courses/:courseId/enroll" element={<CourseEnroll />} />
      <Route path="/sessions/:sessionId/edit" element={<SessionEdit />} />
      <Route path="/sessions/:sessionId/status" element={<SessionStatus />} />
      <Route path="/sessions/:sessionId/results" element={<SessionResults />} />
      <Route path="/sessions/:sessionId/preview/:studentId" element={<SessionPreview />} />
      <Route path="/sessions/:sessionId/moderate/:studentId" element={<SessionModerate />} />
      <Route path="/s/:token" element={<StudentPortal />} />
      <Route path="/s/:token/sessions/:sessionId" element={<StudentSubmit />} />
      <Route path="/s/:token/results/:sessionId" element={<StudentResults />} />
      <Route path="/recover" element={<Recover />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
