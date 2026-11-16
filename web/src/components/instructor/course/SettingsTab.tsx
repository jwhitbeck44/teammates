import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteCourse, updateCourse } from '../../../api/instructor';
import type { Course, Permission } from '../../../lib/types';
import { ErrorBox, useAction } from '../ui';
import { TimeZoneSelect } from '../TimeZoneSelect';

export default function SettingsTab({ course, can, onChanged }: { course: Course; can: (p: Permission) => boolean; onChanged: () => void }) {
  const navigate = useNavigate();
  const canEdit = can('modify_course');
  const [code, setCode] = useState(course.code);
  const [name, setName] = useState(course.name);
  const [institute, setInstitute] = useState(course.institute ?? '');
  const [tz, setTz] = useState(course.time_zone);
  const [typed, setTyped] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const archive = useAction();
  const del = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (code.trim() === '' || name.trim() === '') {
      save.setError('Course code and name are required.');
      return;
    }
    if (await save.run(() => updateCourse(course.id, { code: code.trim(), name: name.trim(), institute: institute.trim() || null, time_zone: tz }))) {
      setSaved(true);
      onChanged();
    }
  }

  async function toggleArchive() {
    if (await archive.run(() => updateCourse(course.id, { archived_at: course.archived_at ? null : new Date().toISOString() }))) onChanged();
  }

  async function remove() {
    if (await del.run(() => deleteCourse(course.id))) navigate('/', { replace: true });
  }

  if (!canEdit) {
    return (
      <div>
        <p className="ins-muted">Only a co-owner can change course settings.</p>
        <table>
          <tbody>
            <tr><th>Code</th><td>{course.code}</td></tr>
            <tr><th>Name</th><td>{course.name}</td></tr>
            <tr><th>Institute</th><td>{course.institute ?? ''}</td></tr>
            <tr><th>Time zone</th><td>{course.time_zone}</td></tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <form className="ins-form" onSubmit={submit}>
        <div className="ins-row">
          <label>Course code<input type="text" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <label>Course name<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <div className="ins-row">
          <label>Institute<input type="text" value={institute} onChange={(e) => setInstitute(e.target.value)} /></label>
          <label>Time zone<TimeZoneSelect value={tz} onChange={setTz} /></label>
        </div>
        {tz !== course.time_zone && (
          <p className="ins-hint">Changing the time zone does not move existing session times; it changes how they are shown.</p>
        )}
        <ErrorBox error={save.error} />
        {saved && <p className="ins-ok">Saved.</p>}
        <button type="submit" className="ins-primary" disabled={save.busy}>Save</button>
      </form>

      <h2>Archive</h2>
      <p className="ins-hint">An archived course moves to the bottom of your course list. Nothing is deleted and students keep their links.</p>
      <ErrorBox error={archive.error} />
      <button type="button" onClick={() => void toggleArchive()} disabled={archive.busy}>
        {course.archived_at ? 'Unarchive course' : 'Archive course'}
      </button>

      <h2>Delete course</h2>
      <p className="ins-hint">
        Deletes the course with all its students, sessions, questions and responses. This cannot be undone.
        Type the course code ({course.code}) to confirm.
      </p>
      <div className="ins-actions">
        <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the course code to confirm" />
        <button type="button" className="ins-danger" disabled={typed !== course.code || del.busy} onClick={() => void remove()}>
          Delete this course
        </button>
      </div>
      <ErrorBox error={del.error} />
    </div>
  );
}
