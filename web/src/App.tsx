import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SiteFooter, SiteHeader } from './components/common/Brand';
import { AuthProvider } from './auth/AuthContext';
import RequireAuth from './auth/RequireAuth';
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

// CourseDetail renders the tabs: sessions, students, instructors, settings (?tab=...).
// Instructor routes need a signed-in user; student routes (/s/...) and /recover never do.
const guard = (el: ReactElement) => <RequireAuth>{el}</RequireAuth>;

// Instructor pages draw their own black bar (components/instructor/ui.tsx); the others get SiteHeader.
const OWN_HEADER = /^\/($|courses\/|sessions\/)/;

export default function App() {
  const { pathname } = useLocation();
  return (
    <AuthProvider>
      {OWN_HEADER.test(pathname) ? null : <SiteHeader />}
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={guard(<InstructorHome />)} />
        <Route path="/courses/:courseId" element={guard(<CourseDetail />)} />
        <Route path="/courses/:courseId/enroll" element={guard(<CourseEnroll />)} />
        <Route path="/sessions/:sessionId/edit" element={guard(<SessionEdit />)} />
        <Route path="/sessions/:sessionId/status" element={guard(<SessionStatus />)} />
        <Route path="/sessions/:sessionId/results" element={guard(<SessionResults />)} />
        <Route path="/sessions/:sessionId/preview/:studentId" element={guard(<SessionPreview />)} />
        <Route path="/sessions/:sessionId/moderate/:studentId" element={guard(<SessionModerate />)} />
        <Route path="/s/:token" element={<StudentPortal />} />
        <Route path="/s/:token/sessions/:sessionId" element={<StudentSubmit />} />
        <Route path="/s/:token/results/:sessionId" element={<StudentResults />} />
        <Route path="/recover" element={<Recover />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <SiteFooter />
    </AuthProvider>
  );
}
