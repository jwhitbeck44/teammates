import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addQuestion,
  countResponsesByQuestion,
  deleteQuestion,
  getCourse,
  getSession,
  listQuestions,
  listStudents,
  renumberQuestions,
  updateQuestion,
} from '../../api/instructor';
import { RECIPIENT_TYPE_LABELS, GIVER_TYPE_LABELS, sortRoster } from '../../lib/recipients';
import { QUESTION_TYPES, type Question, type QuestionDraft, type QuestionType } from '../../lib/types';
import { visibilityLabel } from '../../lib/visibility';
import { ErrorBox, Loading, Page, useAction, useCoursePerms, useLoad } from '../../components/instructor/ui';
import SessionSettings from '../../components/instructor/SessionSettings';
import QuestionEditor from '../../components/instructor/questions/QuestionEditor';
import { changeDeletesResponses, cleanJson, defaultDraft, TYPE_LABELS } from '../../components/instructor/questions/draft';

type Editing = { kind: 'new'; draft: QuestionDraft } | { kind: 'edit'; id: string };

function toDraft(q: Question): QuestionDraft {
  const { id: _i, session_id: _s, ...rest } = q;
  void _i;
  void _s;
  return cleanJson(rest) as QuestionDraft;
}

export default function SessionEdit() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const session = useLoad(() => getSession(sessionId!), [sessionId]);
  const courseId = session.data?.course_id;
  const course = useLoad(() => (courseId ? getCourse(courseId) : Promise.resolve(null)), [courseId]);
  const perms = useCoursePerms(courseId);
  const questions = useLoad(() => listQuestions(sessionId!), [sessionId]);
  const counts = useLoad(() => countResponsesByQuestion(sessionId!), [sessionId, questions.data]);
  const students = useLoad(() => (courseId ? listStudents(courseId) : Promise.resolve([])), [courseId]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [newType, setNewType] = useState<QuestionType>('text');
  const [previewStudent, setPreviewStudent] = useState('');
  const action = useAction();
  const saveAction = useAction();

  const s = session.data;
  const c = course.data;
  const qs = questions.data ?? [];
  const canModify = perms.can('modify_sessions');
  const responseCount = (id: string) => counts.data?.get(id) ?? 0;
  const numbers = new Map(qs.map((q) => [q.id, q.number]));

  async function reloadAll() {
    questions.reload();
  }

  async function onSave(d: QuestionDraft) {
    if (!editing) return;
    if (editing.kind === 'edit') {
      const q = qs.find((x) => x.id === editing.id)!;
      const n = responseCount(q.id);
      if (n > 0 && changeDeletesResponses(toDraft(q), d)) {
        if (!window.confirm(`This change deletes the ${n} existing response${n === 1 ? '' : 's'} to this question. Continue?`)) return;
      }
      if (await saveAction.run(() => updateQuestion(q.id, { ...d, number: q.number }))) {
        setEditing(null);
        await reloadAll();
      }
    } else {
      const next = Math.max(0, ...qs.map((q) => q.number)) + 1;
      if (await saveAction.run(() => addQuestion(sessionId!, { ...d, number: next }))) {
        setEditing(null);
        await reloadAll();
      }
    }
  }

  async function move(i: number, d: -1 | 1) {
    const order = qs.map((q) => q.id);
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    if (await action.run(() => renumberQuestions(order, numbers))) await reloadAll();
  }

  async function remove(q: Question) {
    const n = responseCount(q.id);
    const msg = `Delete question ${q.number}?${n > 0 ? ` Its ${n} response${n === 1 ? '' : 's'} will be deleted too.` : ''} This cannot be undone.`;
    if (!window.confirm(msg)) return;
    const ok = await action.run(async () => {
      await deleteQuestion(q.id);
      const rest = qs.filter((x) => x.id !== q.id).map((x) => x.id);
      await renumberQuestions(rest, numbers);
    });
    if (ok) await reloadAll();
  }

  async function duplicate(q: Question, i: number) {
    const ok = await action.run(async () => {
      const next = Math.max(0, ...qs.map((x) => x.number)) + 1;
      const copy = await addQuestion(sessionId!, { ...toDraft(q), number: next });
      const order = qs.map((x) => x.id);
      order.splice(i + 1, 0, copy.id);
      await renumberQuestions(order, new Map([...numbers, [copy.id, next]]));
    });
    if (ok) await reloadAll();
  }

  const crumbs = [
    { to: '/', label: 'Courses' },
    { to: c ? `/courses/${c.id}` : undefined, label: c?.code ?? '...' },
    { label: s?.name ?? '...' },
  ];

  return (
    <Page title={s ? `Edit session: ${s.name}` : 'Edit session'} crumbs={crumbs}>
      <ErrorBox error={session.error ?? course.error} />
      {(session.loading || perms.loading) && !s && <Loading />}
      {s && c && !perms.loading && !canModify && (
        <p className="ins-notice">You do not have permission to edit this session. <Link to={`/sessions/${s.id}/results`}>View results</Link></p>
      )}
      {s && c && canModify && (
        <>
          <div className="ins-actions">
            <Link className="ins-btn" to={`/sessions/${s.id}/status`}>Status and publishing</Link>
            <Link className="ins-btn" to={`/sessions/${s.id}/results`}>Results</Link>
            <span>Preview as a student:</span>
            <select value={previewStudent} onChange={(e) => setPreviewStudent(e.target.value)} aria-label="Student to preview">
              <option value="">Choose a student</option>
              {sortRoster(students.data ?? []).map((st) => (
                <option key={st.id} value={st.id}>{st.team}: {st.name}</option>
              ))}
            </select>
            <button type="button" disabled={!previewStudent} onClick={() => navigate(`/sessions/${s.id}/preview/${previewStudent}`)}>Preview</button>
          </div>

          <h2>Settings</h2>
          <SessionSettings session={s} timeZone={c.time_zone} onSaved={session.reload} />

          <h2>Questions</h2>
          <ErrorBox error={questions.error ?? action.error} />
          {questions.loading && !questions.data && <Loading />}
          {questions.data && qs.length === 0 && <p className="ins-muted">No questions yet.</p>}
          {qs.map((q, i) =>
            editing?.kind === 'edit' && editing.id === q.id ? (
              <QuestionEditor
                key={q.id}
                initial={toDraft(q)}
                isNew={false}
                busy={saveAction.busy}
                error={saveAction.error}
                warning={(d) => {
                  const n = responseCount(q.id);
                  return n > 0 && changeDeletesResponses(toDraft(q), d)
                    ? `This change will delete the ${n} existing response${n === 1 ? '' : 's'} to this question.`
                    : null;
                }}
                onSave={(d) => void onSave(d)}
                onCancel={() => { setEditing(null); saveAction.setError(null); }}
              />
            ) : (
              <div className="ins-card" key={q.id}>
                <div className="ins-qhead">
                  <div>
                    <strong>{q.number}. {q.brief}</strong>
                    <div className="ins-hint">
                      {TYPE_LABELS[q.type]}. {GIVER_TYPE_LABELS[q.giver_type]} about: {RECIPIENT_TYPE_LABELS[q.recipient_type]}
                      {q.max_recipients !== null ? ` (up to ${q.max_recipients})` : ''}.
                    </div>
                    <div className="ins-hint">Visibility: {visibilityLabel(q)}. Responses so far: {counts.data ? responseCount(q.id) : '...'}.</div>
                  </div>
                  <div className="ins-actions-cell">
                    <button type="button" onClick={() => { saveAction.setError(null); setEditing({ kind: 'edit', id: q.id }); }}>Edit</button>
                    <button type="button" onClick={() => void move(i, -1)} disabled={i === 0 || action.busy} aria-label="Move up">Up</button>
                    <button type="button" onClick={() => void move(i, 1)} disabled={i === qs.length - 1 || action.busy} aria-label="Move down">Down</button>
                    <button type="button" onClick={() => void duplicate(q, i)} disabled={action.busy}>Duplicate</button>
                    <button type="button" className="ins-danger" onClick={() => void remove(q)} disabled={action.busy}>Delete</button>
                  </div>
                </div>
              </div>
            ),
          )}

          {editing?.kind === 'new' ? (
            <QuestionEditor
              initial={editing.draft}
              isNew
              busy={saveAction.busy}
              error={saveAction.error}
              onSave={(d) => void onSave(d)}
              onCancel={() => { setEditing(null); saveAction.setError(null); }}
            />
          ) : (
            <div className="ins-actions">
              <select value={newType} onChange={(e) => setNewType(e.target.value as QuestionType)} aria-label="Question type">
                {QUESTION_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
              <button
                type="button"
                onClick={() => {
                  saveAction.setError(null);
                  setEditing({ kind: 'new', draft: defaultDraft(newType, Math.max(0, ...qs.map((q) => q.number)) + 1) });
                }}
              >
                Add question
              </button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
