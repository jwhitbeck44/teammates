import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getCourse } from '../../api/instructor';
import { ErrorBox, Loading, Page, useCoursePerms, useLoad } from '../../components/instructor/ui';
import SessionsTab from '../../components/instructor/course/SessionsTab';
import StudentsTab from '../../components/instructor/course/StudentsTab';
import InstructorsTab from '../../components/instructor/course/InstructorsTab';
import SettingsTab from '../../components/instructor/course/SettingsTab';

const TABS = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'students', label: 'Students' },
  { id: 'instructors', label: 'Instructors' },
  { id: 'settings', label: 'Settings' },
] as const;

export default function CourseDetail() {
  const { courseId } = useParams<{ courseId: string }>();
  const [params] = useSearchParams();
  const course = useLoad(() => getCourse(courseId!), [courseId]);
  const perms = useCoursePerms(courseId);
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'sessions';
  const c = course.data;

  return (
    <Page title={c ? `${c.code}: ${c.name}` : 'Course'} crumbs={[{ to: '/', label: 'Courses' }, { label: c?.code ?? '...' }]}>
      <ErrorBox error={course.error} />
      {course.loading && !c && <Loading />}
      {c && (
        <>
          {c.archived_at && <p className="ins-notice">This course is archived.</p>}
          <nav className="ins-tabs">
            {TABS.map((t) => (
              <Link key={t.id} to={`/courses/${c.id}?tab=${t.id}`} className={t.id === tab ? 'ins-active' : ''}>
                {t.label}
              </Link>
            ))}
          </nav>
          {tab === 'sessions' && <SessionsTab course={c} can={perms.can} />}
          {tab === 'students' && <StudentsTab course={c} can={perms.can} />}
          {tab === 'instructors' && <InstructorsTab course={c} can={perms.can} />}
          {tab === 'settings' && <SettingsTab course={c} can={perms.can} onChanged={course.reload} />}
        </>
      )}
    </Page>
  );
}
