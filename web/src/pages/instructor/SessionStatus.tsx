import { Fragment, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getCourse,
  getSession,
  listEmailLog,
  listExtensions,
  listInstructors,
  listQuestions,
  listResponseMeta,
  listStudents,
  publishSession,
  removeExtension,
  saveExtension,
  sendReminder,
  unpublishSession,
} from '../../api/instructor';
import { buildNonSubmitterCsv } from '../../lib/csv';
import { errorMessage } from '../../lib/errors';
import { sortRoster } from '../../lib/recipients';
import { nonSubmitters, questionProgress, studentsWithUnanswered, submissionStatus } from '../../lib/results';
import { EMAIL_STATUSES, summarizeEmailLog } from '../../lib/emailLog';
import { formatInstant, isPublished, sessionStatus, studentDeadline, validateExtension } from '../../lib/time';
import { downloadText, ErrorBox, Loading, Page, safeFilename, useAction, useCoursePerms, useLoad } from '../../components/instructor/ui';
import { LocalDateTime } from '../../components/instructor/LocalDateTime';
import InstructorAnswers from '../../components/instructor/InstructorAnswers';

const STATUS_LABEL = { not_open: 'Not open yet', open: 'Open', grace: 'Grace period', closed: 'Closed' } as const;
const EMAIL_STATUS_LABEL = { sent: 'Sent', failed: 'Failed', skipped: 'Skipped', pending: 'Pending' } as const;

function progressText(p: { answerable: number; answered: number } | undefined): string {
  if (!p) return '';
  if (p.answerable === 0) return 'No questions';
  return `${p.answered} of ${p.answerable}`;
}

export default function SessionStatus() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const session = useLoad(() => getSession(sessionId!), [sessionId]);
  const courseId = session.data?.course_id;
  const course = useLoad(() => (courseId ? getCourse(courseId) : Promise.resolve(null)), [courseId]);
  const students = useLoad(() => (courseId ? listStudents(courseId) : Promise.resolve([])), [courseId]);
  const questions = useLoad(() => listQuestions(sessionId!), [sessionId]);
  const responses = useLoad(() => listResponseMeta(sessionId!), [sessionId]);
  const extensions = useLoad(() => listExtensions(sessionId!), [sessionId]);
  const instructors = useLoad(() => (courseId ? listInstructors(courseId) : Promise.resolve([])), [courseId]);
  const emailLog = useLoad(() => listEmailLog(sessionId!), [sessionId]);
  const perms = useCoursePerms(courseId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [copyToMe, setCopyToMe] = useState(false);
  const [extAt, setExtAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showInstructorForm, setShowInstructorForm] = useState(false);
  const publish = useAction();
  const remind = useAction();
  const ext = useAction();

  const s = session.data;
  const c = course.data;
  const tz = c?.time_zone ?? 'UTC';
  const now = Date.now();
  const roster = useMemo(() => sortRoster(students.data ?? []), [students.data]);
  const status = useMemo(() => submissionStatus(roster, responses.data ?? []), [roster, responses.data]);
  // Questions answered out of questions each student can answer (every question is optional: this informs).
  const progress = useMemo(
    () => questionProgress(questions.data ?? [], roster, instructors.data ?? [], responses.data ?? []),
    [questions.data, roster, instructors.data, responses.data],
  );
  const emails = useMemo(() => summarizeEmailLog(emailLog.data ?? []), [emailLog.data]);
  const extByStudent = useMemo(() => new Map((extensions.data ?? []).map((e) => [e.student_id, e.closes_at])), [extensions.data]);
  const canModify = perms.can('modify_sessions');
  const canSubmit = perms.can('submit');
  const hasInstructorQuestions = (questions.data ?? []).some((q) => q.giver_type === 'instructors');
  const submittedCount = roster.filter((r) => status.get(r.id)?.submitted).length;
  const completeCount = roster.filter((r) => {
    const p = progress.get(r.id);
    return p !== undefined && p.answerable > 0 && p.unanswered.length === 0;
  }).length;
  const published = s ? isPublished(s, now) : false;
  const sessionState = s ? sessionStatus(s, now) : 'closed';
  const visible = roster.filter((r) => !onlyMissing || !status.get(r.id)?.submitted);

  function reloadAll() {
    session.reload();
    responses.reload();
    extensions.reload();
    students.reload();
    emailLog.reload();
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function selectNonSubmitters() {
    setSelected(new Set(roster.filter((r) => !status.get(r.id)?.submitted).map((r) => r.id)));
  }

  function selectWithUnanswered() {
    setSelected(new Set(studentsWithUnanswered(roster, progress).map((r) => r.id)));
  }

  async function doPublish(on: boolean) {
    const msg = on
      ? 'Publish results? Students will be able to see the responses their visibility settings allow, and a published email is sent if enabled.'
      : 'Unpublish results? Students lose access to results until you publish again.';
    if (!window.confirm(msg)) return;
    if (await publish.run(() => (on ? publishSession(sessionId!) : unpublishSession(sessionId!)))) session.reload();
  }

  async function doRemind(kind: 'submit' | 'results') {
    setMessage(null);
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Send a ${kind === 'submit' ? 'submission' : 'results'} reminder email to ${ids.length} student${ids.length === 1 ? '' : 's'}?`)) return;
    remind.setError(null);
    try {
      const r = await sendReminder(sessionId!, ids, kind, copyToMe);
      setMessage(
        `Sent ${r.sent}, failed ${r.failed}, skipped ${r.skipped}` +
          (r.ignored > 0 ? `, ignored ${r.ignored} (their deadline has passed or they were not found)` : '') +
          (r.remaining > 0 ? `, ${r.remaining} not sent yet (try again)` : '') +
          '.' +
          (r.skipped > 0 && r.sent === 0 ? ' Email is not set up on this site, so nothing was sent.' : ''),
      );
    } catch (e) {
      remind.setError(e instanceof Error ? e.message : 'The reminder could not be sent.');
    }
  }

  async function applyExtension() {
    if (!s || !extAt) {
      ext.setError('Choose a date and time for the extended deadline.');
      return;
    }
    const code = validateExtension(s, extAt);
    if (code) {
      ext.setError(`${errorMessage(code)} The session closes ${formatInstant(s.closes_at, tz, { zoneName: true })}.`);
      return;
    }
    const ids = [...selected];
    if (ids.length === 0) {
      ext.setError('Select the students to extend first.');
      return;
    }
    if (await ext.run(async () => { for (const id of ids) await saveExtension(sessionId!, id, extAt); })) extensions.reload();
  }

  async function clearExtensions(ids: string[]) {
    if (ids.length === 0) return;
    if (await ext.run(async () => { for (const id of ids) await removeExtension(sessionId!, id); })) extensions.reload();
  }

  function downloadNonSubmitters() {
    const list = nonSubmitters(roster, responses.data ?? []);
    downloadText(safeFilename(c?.code ?? 'course', s?.name ?? 'session', 'non_submitters') + '.csv', buildNonSubmitterCsv(list));
  }

  const crumbs = [
    { to: '/', label: 'Courses' },
    { to: c ? `/courses/${c.id}` : undefined, label: c?.code ?? '...' },
    { label: s?.name ?? '...' },
  ];
  const loadError = session.error ?? course.error ?? students.error ?? responses.error ?? extensions.error ?? questions.error ?? instructors.error;

  return (
    <Page title={s ? `Status: ${s.name}` : 'Session status'} crumbs={crumbs} wide>
      <ErrorBox error={loadError} />
      {(session.loading || students.loading || responses.loading) && !s && <Loading />}
      {s && c && (
        <>
          <div className="ins-actions">
            <span className={`ins-tag ${sessionState}`}>{STATUS_LABEL[sessionState]}</span>
            {published && <span className="ins-tag published">Results published</span>}
            <span>
              Opens {formatInstant(s.opens_at, tz, { zoneName: true })}. Closes {formatInstant(s.closes_at, tz, { zoneName: true })}
              {s.grace_minutes > 0 ? `, grace ${s.grace_minutes} min` : ''}.
            </span>
          </div>
          <div className="ins-actions">
            {canModify && <Link className="ins-btn" to={`/sessions/${s.id}/edit`}>Edit session</Link>}
            <Link className="ins-btn" to={`/sessions/${s.id}/results`}>Results</Link>
            <button type="button" onClick={reloadAll}>Refresh</button>
            <button type="button" onClick={downloadNonSubmitters} disabled={roster.length === 0}>Download non-submitters CSV</button>
          </div>

          {canModify && (
            <div className="ins-card">
              <h3>Publishing</h3>
              <p>
                {published
                  ? `Results are visible to students${s.published_at ? ` (published ${formatInstant(s.published_at, tz, { zoneName: true })})` : ' by the visibility setting'}.`
                  : 'Results are not visible to students.'}
              </p>
              <ErrorBox error={publish.error} />
              <div className="ins-actions">
                {!published && <button type="button" className="ins-primary" onClick={() => void doPublish(true)} disabled={publish.busy}>Publish results</button>}
                {published && <button type="button" onClick={() => void doPublish(false)} disabled={publish.busy}>Unpublish results</button>}
              </div>
              {!published && sessionState === 'not_open' && <p className="ins-hint">A session cannot be published before it opens.</p>}
            </div>
          )}

          {hasInstructorQuestions && canSubmit && (
            <div className="ins-card">
              <h3>Questions for instructors</h3>
              <p className="ins-hint">This session has questions that instructors answer. Your answers are saved under your own name.</p>
              <button type="button" onClick={() => setShowInstructorForm((v) => !v)}>{showInstructorForm ? 'Hide' : 'Answer instructor questions'}</button>
              {showInstructorForm && <InstructorAnswers sessionId={s.id} />}
            </div>
          )}

          <h2>Students ({submittedCount} of {roster.length} have responded, {completeCount} have answered every question)</h2>
          {canModify && (
            <div className="ins-card">
              <div className="ins-actions">
                <strong>{selected.size} selected</strong>
                <button type="button" onClick={selectNonSubmitters}>Select non-submitters</button>
                <button type="button" onClick={selectWithUnanswered}>Select students with unanswered questions</button>
                <button type="button" onClick={() => setSelected(new Set(roster.map((r) => r.id)))}>Select all</button>
                <button type="button" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
              <div className="ins-actions">
                <button type="button" onClick={() => void doRemind('submit')} disabled={remind.busy || selected.size === 0 || sessionState === 'not_open'}>Send submission reminder</button>
                <button type="button" onClick={() => void doRemind('results')} disabled={remind.busy || selected.size === 0 || !published}>Send results reminder</button>
                <label className="ins-inline"><input type="checkbox" checked={copyToMe} onChange={(e) => setCopyToMe(e.target.checked)} /> Send me a copy</label>
              </div>
              <ErrorBox error={remind.error} />
              {message && <p className="ins-ok">{message}</p>}
              <div className="ins-actions">
                <span>Extended deadline for selected students:</span>
                <LocalDateTime value={null} timeZone={tz} onChange={setExtAt} label="" />
                <button type="button" onClick={() => void applyExtension()} disabled={ext.busy}>Set extension</button>
                <button type="button" onClick={() => void clearExtensions([...selected].filter((id) => extByStudent.has(id)))} disabled={ext.busy}>Remove extensions</button>
              </div>
              <p className="ins-hint">An extension must be later than the session close time. A student can submit until the later of their extension and the close time plus grace.</p>
              <ErrorBox error={ext.error} />
            </div>
          )}

          <label className="ins-inline"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Show only students who have not responded</label>
          <div className="ins-scroll">
            <table>
              <thead>
                <tr>
                  {canModify && <th></th>}
                  <th>Name</th>
                  <th>Email</th>
                  <th>Questions answered</th>
                  <th className="ins-num">Responses</th>
                  <th>Last updated</th>
                  <th>Deadline</th>
                  <th>Open as student</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const st = status.get(r.id);
                  const e = extByStudent.get(r.id);
                  const prev = visible[i - 1];
                  const newTeam = !prev || prev.section !== r.section || prev.team !== r.team;
                  return (
                    <Fragment key={r.id}>
                      {newTeam && <tr className="ins-subgroup"><td colSpan={canModify ? 8 : 7}>{r.section} / {r.team}</td></tr>}
                      <tr>
                        {canModify && <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} /></td>}
                        <td>{r.name}</td>
                        <td>{r.email}</td>
                        <td>{progressText(progress.get(r.id))}</td>
                        <td className="ins-num">{st?.count ?? 0}</td>
                        <td>{st?.last_updated ? formatInstant(st.last_updated, tz) : ''}</td>
                        <td>
                          {formatInstant(studentDeadline(s, e), tz)}
                          {e && <> <span className="ins-tag">extended</span>{canModify && <> <button type="button" className="ins-link" onClick={() => void clearExtensions([r.id])}>remove</button></>}</>}
                        </td>
                        <td className="ins-actions-cell">
                          {canModify && <Link to={`/sessions/${s.id}/moderate/${r.id}`}>Moderate</Link>}
                          {canModify && <Link to={`/sessions/${s.id}/preview/${r.id}`}>Preview</Link>}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="ins-hint">
            Questions answered counts the questions with at least one saved answer, out of the questions the student can
            answer. A question with nobody for the student to answer about (for example a teammates question in a team of
            one) is not counted. Every question is optional, so an unanswered question is not an error. "Select
            non-submitters" selects students with no saved answer at all. Responses counts the rows a student has saved.
            Times are in {tz}. Moderate lets you edit a student's answers, even after the deadline.
          </p>

          {canModify && (
            <div className="ins-card">
              <h3>Emails for this session</h3>
              <ErrorBox error={emailLog.error} />
              {emails.total === 0 ? (
                <p className="ins-muted ins-small">No emails yet.</p>
              ) : (
                <>
                  <table className="ins-stats">
                    <thead>
                      <tr><th>Email</th>{EMAIL_STATUSES.map((st) => <th key={st} className="ins-num">{EMAIL_STATUS_LABEL[st]}</th>)}</tr>
                    </thead>
                    <tbody>
                      {emails.byKind.map((k) => (
                        <tr key={k.kind}>
                          <td>{k.label}</td>
                          {EMAIL_STATUSES.map((st) => <td key={st} className="ins-num">{k.counts[st]}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {emails.failures.length > 0 && (
                    <>
                      <h4>Failed sends</h4>
                      <div className="ins-scroll">
                        <table>
                          <thead>
                            <tr><th>When</th><th>Email</th><th>Address</th><th>Error</th><th>Later sent</th></tr>
                          </thead>
                          <tbody>
                            {emails.failures.map((f, i) => (
                              <tr key={i}>
                                <td>{formatInstant(f.created_at, tz)}</td>
                                <td>{f.label}</td>
                                <td>{f.to_email}</td>
                                <td>{f.error}</td>
                                <td>{f.resolved ? 'Yes' : 'No'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              )}
              <p className="ins-hint">
                Each row of the log is one try. The automatic emails (session opened, closing soon, results published) are
                tried again on the next runs of the 15 minute timer after a failure, up to three tries per student.
                Skipped means email is not set up on this site, so nothing was sent and nothing is tried again.
              </p>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
