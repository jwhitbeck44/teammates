import { useState } from 'react';
import { inviteInstructor, listInstructors, removeInstructor, updateInstructor } from '../../../api/instructor';
import { INSTRUCTOR_ROLES, type Course, type CourseInstructor, type InstructorRole, type Permission } from '../../../lib/types';
import { ErrorBox, Loading, useAction, useLoad } from '../ui';

const ROLE_LABEL: Record<InstructorRole, string> = { coowner: 'Co-owner', manager: 'Manager', observer: 'Observer', tutor: 'Tutor' };
const ROLE_HELP: Record<InstructorRole, string> = {
  coowner: 'Everything, including editing and deleting the course and managing co-owners.',
  manager: 'Manage instructors (not co-owners), sessions, students and results.',
  observer: 'View results only.',
  tutor: 'View results and answer instructor questions.',
};

function Row({
  ins,
  isCoowner,
  canManage,
  coownerCount,
  onChanged,
}: {
  ins: CourseInstructor;
  isCoowner: boolean;
  canManage: boolean;
  coownerCount: number;
  onChanged: () => void;
}) {
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ins.display_name);
  const [shown, setShown] = useState(ins.is_displayed_to_students);
  // Only a co-owner may change or remove a co-owner (database rule). The last co-owner cannot go.
  const locked = !canManage || (ins.role === 'coowner' && !isCoowner);
  const lastCoowner = ins.role === 'coowner' && coownerCount <= 1;
  const roles = INSTRUCTOR_ROLES.filter((r) => isCoowner || r !== 'coowner');

  async function changeRole(role: InstructorRole) {
    if (await action.run(() => updateInstructor(ins.id, { role }))) onChanged();
  }
  async function save() {
    if (name.trim() === '') {
      action.setError('The display name is required.');
      return;
    }
    if (await action.run(() => updateInstructor(ins.id, { display_name: name.trim(), is_displayed_to_students: shown }))) {
      setEditing(false);
      onChanged();
    }
  }
  async function remove() {
    if (!window.confirm(`Remove ${ins.display_name} (${ins.email}) from this course? Responses they gave are deleted.`)) return;
    if (await action.run(() => removeInstructor(ins.id))) onChanged();
  }

  return (
    <tr>
      <td>
        {editing ? (
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        ) : (
          ins.display_name
        )}
        <ErrorBox error={action.error} />
      </td>
      <td>{ins.email}</td>
      <td>
        {locked || lastCoowner ? (
          <span title={lastCoowner ? 'A course must keep at least one co-owner.' : undefined}>{ROLE_LABEL[ins.role]}</span>
        ) : (
          <select value={ins.role} onChange={(e) => void changeRole(e.target.value as InstructorRole)} disabled={action.busy} aria-label={`Role of ${ins.display_name}`}>
            {roles.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        )}
      </td>
      <td>
        {editing ? (
          <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} aria-label="Shown to students" />
        ) : ins.is_displayed_to_students ? 'Yes' : 'No'}
      </td>
      <td>{ins.user_id ? 'Joined' : 'Invited'}</td>
      <td className="ins-actions-cell">
        {!locked && !editing && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
        {editing && <button type="button" className="ins-primary" onClick={() => void save()} disabled={action.busy}>Save</button>}
        {editing && <button type="button" onClick={() => { setEditing(false); setName(ins.display_name); setShown(ins.is_displayed_to_students); }}>Cancel</button>}
        {!locked && !lastCoowner && <button type="button" className="ins-danger" onClick={() => void remove()} disabled={action.busy}>Remove</button>}
      </td>
    </tr>
  );
}

export default function InstructorsTab({ course, can }: { course: Course; can: (p: Permission) => boolean }) {
  const list = useLoad(() => listInstructors(course.id), [course.id]);
  const canManage = can('modify_instructors');
  const isCoowner = can('modify_course');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<InstructorRole>('tutor');
  const [shown, setShown] = useState(true);
  const action = useAction();
  const coownerCount = (list.data ?? []).filter((i) => i.role === 'coowner').length;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      action.setError('Enter a valid email address.');
      return;
    }
    if (displayName.trim() === '') {
      action.setError('Enter a display name.');
      return;
    }
    const ok = await action.run(() =>
      inviteInstructor(course.id, { email: email.trim().toLowerCase(), display_name: displayName.trim(), role, is_displayed_to_students: shown }),
    );
    if (ok) {
      setEmail('');
      setDisplayName('');
      list.reload();
    }
  }

  return (
    <div>
      <ErrorBox error={list.error} />
      {list.loading && !list.data && <Loading />}
      {list.data && (
        <div className="ins-scroll">
          <table>
            <thead>
              <tr>
                <th>Display name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Shown to students</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((i) => (
                <Row key={i.id} ins={i} isCoowner={isCoowner} canManage={canManage} coownerCount={coownerCount} onChanged={list.reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ins-hint">
        An invited person is linked to the course when they sign in (or create an account) with the invited email address.
        No email is sent: tell them to sign in at this site.
      </p>
      {canManage && (
        <form className="ins-card ins-form" onSubmit={invite}>
          <h3>Invite an instructor</h3>
          <div className="ins-row">
            <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>Display name<input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as InstructorRole)}>
                {INSTRUCTOR_ROLES.filter((r) => isCoowner || r !== 'coowner').map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="ins-hint">{ROLE_HELP[role]}</p>
          <label className="ins-inline">
            <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} /> Shown to students (can be the recipient of feedback)
          </label>
          <ErrorBox error={action.error} />
          <div><button type="submit" className="ins-primary" disabled={action.busy}>Invite</button></div>
        </form>
      )}
    </div>
  );
}
