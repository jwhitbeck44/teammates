import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { createCourse, listMyCourses, type CourseWithRole } from '../../api/instructor';
import { ErrorBox, Loading, Page, useAction, useLoad } from '../../components/instructor/ui';
import { TimeZoneSelect } from '../../components/instructor/TimeZoneSelect';
import { INSTRUCTOR_ROLES } from '../../lib/types';

const ROLE_LABEL: Record<(typeof INSTRUCTOR_ROLES)[number], string> = {
  coowner: 'Co-owner',
  manager: 'Manager',
  observer: 'Observer',
  tutor: 'Tutor',
};

function CourseTable({ courses }: { courses: CourseWithRole[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Code</th>
          <th>Name</th>
          <th>Institute</th>
          <th>Time zone</th>
          <th>Your role</th>
        </tr>
      </thead>
      <tbody>
        {courses.map((c) => (
          <tr key={c.id}>
            <td><Link to={`/courses/${c.id}`}>{c.code}</Link></td>
            <td>{c.name}</td>
            <td>{c.institute ?? ''}</td>
            <td>{c.time_zone}</td>
            <td>{c.role ? ROLE_LABEL[c.role] : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function InstructorHome() {
  const { user } = useAuth();
  const courses = useLoad(() => listMyCourses(user!.id), [user?.id]);
  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [institute, setInstitute] = useState('');
  const [tz, setTz] = useState('America/Denver');
  const action = useAction();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (code.trim() === '' || name.trim() === '') {
      action.setError('Course code and name are required.');
      return;
    }
    const ok = await action.run(() =>
      createCourse({ code: code.trim(), name: name.trim(), institute: institute.trim() || null, time_zone: tz }),
    );
    if (ok) {
      setShowForm(false);
      setCode('');
      setName('');
      setInstitute('');
      courses.reload();
    }
  }

  const list = courses.data ?? [];
  const active = list.filter((c) => c.archived_at === null);
  const archived = list.filter((c) => c.archived_at !== null);

  return (
    <Page title="Your courses">
      <ErrorBox error={courses.error} />
      {courses.loading && !courses.data && <Loading />}
      {courses.data && active.length === 0 && (
        <p className="ins-muted">You do not teach any active courses yet.</p>
      )}
      {active.length > 0 && <CourseTable courses={active} />}

      <div className="ins-actions">
        <button type="button" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'Create a course'}</button>
      </div>
      {showForm && (
        <form onSubmit={create} className="ins-card ins-form">
          <h3>New course</h3>
          <div className="ins-row">
            <label>Course code<input type="text" value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <label>Course name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          </div>
          <div className="ins-row">
            <label>Institute (optional)<input type="text" value={institute} onChange={(e) => setInstitute(e.target.value)} /></label>
            <label>Time zone<TimeZoneSelect value={tz} onChange={setTz} /></label>
          </div>
          <p className="ins-hint">Session times are shown and entered in the course time zone.</p>
          <ErrorBox error={action.error} />
          {action.denied && (
            <p className="ins-notice">
              Your account is not on the list of people who may create courses, and you have no course invitations.
              Ask the person who runs this site to add your email address ({user?.email}), or ask a course owner to invite you.
            </p>
          )}
          <button type="submit" className="ins-primary" disabled={action.busy}>Create course</button>
        </form>
      )}

      {archived.length > 0 && (
        <>
          <h2>Archived courses</h2>
          <CourseTable courses={archived} />
        </>
      )}
      {courses.data && list.length === 0 && (
        <p className="ins-notice">
          If you expected to see a course here, ask a course owner to invite {user?.email}. Invitations are matched by email
          address when you sign in. Creating your own course needs your address to be on the site's allowlist.
        </p>
      )}
    </Page>
  );
}
