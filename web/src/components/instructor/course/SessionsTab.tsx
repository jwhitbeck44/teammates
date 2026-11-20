import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { copySession, createSession, deleteSession, listSessions, listStudents, listSubmitters } from '../../../api/instructor';
import { defaultSessionTimes, formatInstant, isPublished, sessionStatus } from '../../../lib/time';
import { getTemplate, listTemplates, type TemplateId } from '../../../lib/templates';
import type { Course, Permission } from '../../../lib/types';
import { ErrorBox, Loading, useAction, useLoad } from '../ui';

const STATUS_LABEL = { not_open: 'Not open yet', open: 'Open', grace: 'Grace period', closed: 'Closed' } as const;

function NewSession({ course, onCancel }: { course: Course; onCancel: () => void }) {
  const navigate = useNavigate();
  const templates = listTemplates();
  const [template, setTemplate] = useState<TemplateId>('point_based');
  const [name, setName] = useState('');
  const action = useAction();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const t = getTemplate(template);
    const times = defaultSessionTimes(course.time_zone);
    let id = '';
    const ok = await action.run(async () => {
      const s = await createSession(
        course.id,
        {
          name: name.trim() || t.sessionName,
          instructions: '',
          opens_at: times.opens,
          closes_at: times.closes,
          grace_minutes: 15,
          results_visibility: 'later',
          results_visible_at: null,
          closing_email_enabled: true,
          published_email_enabled: true,
        },
        t.questions,
      );
      id = s.id;
    });
    if (ok) navigate(`/sessions/${id}/edit`);
  }

  return (
    <form className="ins-card ins-form" onSubmit={create}>
      <h3>New session</h3>
      <label>
        Start from
        <select value={template} onChange={(e) => setTemplate(e.target.value as TemplateId)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </label>
      <label>
        Session name
        <input type="text" value={name} placeholder={getTemplate(template).sessionName} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="ins-hint">Open and close times can be set on the next page.</p>
      <ErrorBox error={action.error} />
      <div className="ins-actions">
        <button type="submit" className="ins-primary" disabled={action.busy}>Create and edit</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function SessionsTab({ course, can }: { course: Course; can: (p: Permission) => boolean }) {
  const sessions = useLoad(() => listSessions(course.id), [course.id]);
  const students = useLoad(() => listStudents(course.id), [course.id]);
  const ids = (sessions.data ?? []).map((s) => s.id).join(',');
  const submitters = useLoad(() => listSubmitters(ids ? ids.split(',') : []), [ids]);
  const [showNew, setShowNew] = useState(false);
  const action = useAction();
  const now = Date.now();
  const tz = course.time_zone;
  const total = students.data?.length ?? 0;
  const canModify = can('modify_sessions');

  async function copy(id: string, name: string) {
    const newName = window.prompt(
      'Name for the copy. The copy gets new times, like a new session: it opens tomorrow at 8:00 AM and closes in eight days at 11:59 PM. You can change them after.',
      `${name} (copy)`,
    );
    if (!newName || newName.trim() === '') return;
    if (await action.run(() => copySession(id, newName.trim(), null))) sessions.reload();
  }

  async function remove(id: string) {
    if (await action.run(() => deleteSession(id))) sessions.reload();
  }

  return (
    <div>
      <ErrorBox error={sessions.error} />
      <ErrorBox error={action.error} />
      {canModify && (
        <div className="ins-actions">
          <button type="button" onClick={() => setShowNew((v) => !v)}>New session</button>
        </div>
      )}
      {showNew && <NewSession course={course} onCancel={() => setShowNew(false)} />}
      {sessions.loading && !sessions.data && <Loading />}
      {sessions.data && sessions.data.length === 0 && <p className="ins-muted">No sessions yet.</p>}
      {sessions.data && sessions.data.length > 0 && (
        <div className="ins-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Opens</th>
                <th>Closes</th>
                <th className="ins-num">Submitted</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((s) => {
                const st = sessionStatus(s, now);
                const pub = isPublished(s, now);
                const done = submitters.data?.get(s.id)?.size;
                return (
                  <tr key={s.id}>
                    <td><Link to={`/sessions/${s.id}/status`}>{s.name}</Link></td>
                    <td>
                      <span className={`ins-tag ${st}`}>{STATUS_LABEL[st]}</span>{' '}
                      {pub && <span className="ins-tag published">Results published</span>}
                    </td>
                    <td>{formatInstant(s.opens_at, tz, { zoneName: true })}</td>
                    <td>{formatInstant(s.closes_at, tz, { zoneName: true })}{s.grace_minutes > 0 ? ` (+${s.grace_minutes} min grace)` : ''}</td>
                    <td className="ins-num">{submitters.data ? `${done ?? 0} / ${total}` : ''}</td>
                    <td className="ins-actions-cell">
                      {canModify && <Link className="ins-btn" to={`/sessions/${s.id}/edit`}>Edit</Link>}
                      <Link className="ins-btn" to={`/sessions/${s.id}/status`}>Status</Link>
                      <Link className="ins-btn" to={`/sessions/${s.id}/results`}>Results</Link>
                      {canModify && <button type="button" onClick={() => void copy(s.id, s.name)} disabled={action.busy}>Copy</button>}
                      {canModify && (
                        <button
                          type="button"
                          className="ins-danger"
                          disabled={action.busy}
                          onClick={() => {
                            if (window.confirm(`Delete "${s.name}"? Its questions and all responses are deleted too. This cannot be undone.`)) void remove(s.id);
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="ins-hint">Times are shown in {tz}. Submitted counts students with at least one response.</p>
    </div>
  );
}
