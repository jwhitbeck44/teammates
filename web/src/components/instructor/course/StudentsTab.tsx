import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteStudent, listStudentLinks, studentHasResponses, listStudents, regenerateStudentToken, updateStudent } from '../../../api/instructor';
import { buildStudentLinksCsv, studentLink } from '../../../lib/csv';
import { errorMessage } from '../../../lib/errors';
import { sortRoster } from '../../../lib/recipients';
import type { Course, Permission, Student } from '../../../lib/types';
import { validateStudentFields } from '../../../lib/validation';
import { appBaseUrl, downloadText, ErrorBox, Loading, safeFilename, useAction, useLoad } from '../ui';

function EditRow({ student, onDone, onCancel }: { student: Student; onDone: () => void; onCancel: () => void }) {
  const [v, setV] = useState({
    section: student.section,
    team: student.team,
    name: student.name,
    email: student.email,
    comments: student.comments ?? '',
  });
  const action = useAction();
  const [hasResponses, setHasResponses] = useState(false);
  useEffect(() => {
    let active = true;
    void studentHasResponses(student.id).then((b) => { if (active) setHasResponses(b); });
    return () => { active = false; };
  }, [student.id]);
  const teamChanged = v.team.trim() !== student.team || v.section.trim() !== student.section;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });

  async function save() {
    const clean = {
      section: v.section.trim().replace(/\s+/g, ' '),
      team: v.team.trim().replace(/\s+/g, ' '),
      name: v.name.trim().replace(/\s+/g, ' '),
      email: v.email.trim().toLowerCase(),
      comments: v.comments.trim(),
    };
    const problems = validateStudentFields(clean);
    if (problems.length > 0) {
      action.setError(`${problems[0].field}: ${errorMessage(problems[0].code)}`);
      return;
    }
    if (await action.run(() => updateStudent(student.id, { ...clean, comments: clean.comments || null }))) onDone();
  }

  return (
    <tr>
      <td colSpan={6}>
        <div className="ins-row">
          <label>Section<input type="text" value={v.section} onChange={set('section')} /></label>
          <label>Team<input type="text" value={v.team} onChange={set('team')} /></label>
          <label>Name<input type="text" value={v.name} onChange={set('name')} /></label>
          <label>Email<input type="text" value={v.email} onChange={set('email')} /></label>
          <label>Comments<input type="text" value={v.comments} onChange={set('comments')} /></label>
          <button type="button" className="ins-primary" onClick={() => void save()} disabled={action.busy}>Save</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
        {teamChanged && hasResponses && (
          <p className="ins-notice">
            This student already has responses. After the change they see only the earlier responses that were addressed to
            or given by them, plus new ones for the new team. Earlier responses stay with the old team, and results by team
            in old sessions keep the old team.
          </p>
        )}
        <ErrorBox error={action.error} />
      </td>
    </tr>
  );
}

export default function StudentsTab({ course, can }: { course: Course; can: (p: Permission) => boolean }) {
  const students = useLoad(() => listStudents(course.id), [course.id]);
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const action = useAction();
  const canModify = can('modify_students');
  // Private links are only fetched for roles that may see them (modify_students).
  const links = useLoad(() => (canModify ? listStudentLinks(course.id) : Promise.resolve([])), [course.id, canModify]);
  const tokenOf = new Map((links.data ?? []).map((l) => [l.student_id, l.token]));
  const roster = sortRoster(students.data ?? []);

  async function regenerate(s: Student) {
    if (!window.confirm(`Make a new link for ${s.name}? The old link stops working.`)) return;
    if (await action.run(() => regenerateStudentToken(s.id))) links.reload();
  }

  async function remove(s: Student) {
    if (!window.confirm(`Delete ${s.name}? Responses this student gave or received are deleted too. This cannot be undone.`)) return;
    if (await action.run(() => deleteStudent(s.id))) students.reload();
  }

  async function copyLink(s: Student) {
    const token = tokenOf.get(s.id);
    if (!token) return;
    try {
      await navigator.clipboard.writeText(studentLink(appBaseUrl(), token));
      setCopied(s.id);
      setTimeout(() => setCopied((c) => (c === s.id ? null : c)), 2000);
    } catch {
      window.prompt('Copy this link', studentLink(appBaseUrl(), token));
    }
  }

  function downloadLinks() {
    downloadText(safeFilename(course.code, 'student_links') + '.csv', buildStudentLinksCsv(links.data ?? [], appBaseUrl()));
  }

  let lastSection = '';
  let lastTeam = '';
  return (
    <div>
      <ErrorBox error={students.error} />
      <ErrorBox error={links.error} />
      <ErrorBox error={action.error} />
      <div className="ins-actions">
        {canModify && <Link className="ins-btn" to={`/courses/${course.id}/enroll`}>Enroll students</Link>}
        {canModify && (
          <button type="button" onClick={downloadLinks} disabled={roster.length === 0 || !links.data}>Download student links CSV</button>
        )}
        <span className="ins-muted">{roster.length} students</span>
      </div>
      {canModify && (
        <p className="ins-hint">
          The links CSV holds every student's private link. Treat it like a list of passwords: anyone with a link can
          submit as that student.
        </p>
      )}
      {students.loading && !students.data && <Loading />}
      {students.data && roster.length === 0 && <p className="ins-muted">No students yet.</p>}
      {roster.length > 0 && (
        <div className="ins-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Comments</th>
                {canModify && <th>Link</th>}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((s) => {
                const newSection = s.section !== lastSection;
                const newTeam = newSection || s.team !== lastTeam;
                lastSection = s.section;
                lastTeam = s.team;
                return (
                  <Fragment key={s.id}>
                    {newSection && (
                      <tr className="ins-group"><td colSpan={5}>Section: {s.section}</td></tr>
                    )}
                    {newTeam && (
                      <tr className="ins-subgroup"><td colSpan={5}>Team: {s.team}</td></tr>
                    )}
                    {editing === s.id ? (
                      <EditRow student={s} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); students.reload(); }} />
                    ) : (
                      <tr>
                        <td>{s.name}</td>
                        <td>{s.email}</td>
                        <td>{s.comments ?? ''}</td>
                        {canModify && (
                          <td><button type="button" className="ins-link" onClick={() => void copyLink(s)} disabled={!tokenOf.has(s.id)}>{copied === s.id ? 'Copied' : 'Copy link'}</button></td>
                        )}
                        <td className="ins-actions-cell">
                          {canModify && <button type="button" onClick={() => setEditing(s.id)}>Edit</button>}
                          {canModify && <button type="button" onClick={() => void regenerate(s)} disabled={action.busy}>New link</button>}
                          {canModify && <button type="button" className="ins-danger" onClick={() => void remove(s)} disabled={action.busy}>Delete</button>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
