import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  contribResults,
  getCourse,
  getSession,
  listInstructors,
  listQuestions,
  listResponses,
  listStudents,
  type ContribResultStudent,
} from '../../api/instructor';
import { answerText, NO_RESPONSE_TEXT } from '../../lib/answerText';
import { buildResultsCsv, type ResultsResponse } from '../../lib/csv';
import { contribPointToText } from '../../lib/contrib';
import {
  buildResultsQuestions,
  groupBy,
  nonSubmitters,
  SECTION_MODE_LABELS,
  toStatResponses,
  type SectionMode,
} from '../../lib/results';
import { questionStats } from '../../lib/stats';
import { downloadText, ErrorBox, Loading, Page, safeFilename, useLoad } from '../../components/instructor/ui';
import { StatsTable } from '../../components/instructor/StatsTable';
import type { Question } from '../../lib/types';

type View = 'question' | 'giver' | 'recipient';

interface Item extends ResultsResponse {
  q: Question;
}

function ContribTable({ rows }: { rows: ContribResultStudent[] }) {
  if (rows.length === 0) return <p className="ins-muted ins-small">No statistics for this question yet.</p>;
  return (
    <div className="ins-scroll">
      <p className="ins-hint">
        CC is what the student claimed for themselves. PC is the team's average view of the student, excluding their own
        rating. An equal share is 100.
      </p>
      <table className="ins-stats">
        <thead>
          <tr><th>Team</th><th>Name</th><th>Email</th><th>CC</th><th>PC</th><th>Diff</th><th>Ratings received</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.student_id}>
              <td>{r.team}</td>
              <td>{r.name}</td>
              <td>{r.email}</td>
              <td>{contribPointToText(r.claimed)}</td>
              <td>{contribPointToText(r.perceived)}</td>
              <td>{contribPointToText(r.diff)}</td>
              <td>{r.ratings_received.length === 0 ? 'N/A' : r.ratings_received.map(contribPointToText).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SessionResults() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const session = useLoad(() => getSession(sessionId!), [sessionId]);
  const courseId = session.data?.course_id;
  const course = useLoad(() => (courseId ? getCourse(courseId) : Promise.resolve(null)), [courseId]);
  const students = useLoad(() => (courseId ? listStudents(courseId) : Promise.resolve([])), [courseId]);
  const instructors = useLoad(() => (courseId ? listInstructors(courseId) : Promise.resolve([])), [courseId]);
  const questions = useLoad(() => listQuestions(sessionId!), [sessionId]);
  const responses = useLoad(() => listResponses(sessionId!), [sessionId]);
  const contribIds = (questions.data ?? []).filter((q) => q.type === 'contrib').map((q) => q.id);
  const contrib = useLoad(
    async () => new Map(await Promise.all(contribIds.map(async (id) => [id, await contribResults(id)] as const))),
    [contribIds.join(',')],
  );

  const [view, setView] = useState<View>('question');
  const [section, setSection] = useState('');
  const [mode, setMode] = useState<SectionMode>('either');
  const [showStats, setShowStats] = useState(true);
  const [showMissing, setShowMissing] = useState(false);

  const s = session.data;
  const c = course.data;
  const roster = students.data ?? [];
  const ins = instructors.data ?? [];
  const qs = questions.data ?? [];
  const rows = responses.data ?? [];
  const sections = useMemo(() => [...new Set(roster.map((r) => r.section))].sort(), [roster]);

  const built = useMemo(
    () => buildResultsQuestions(qs, rows, roster, ins, { includeMissing: showMissing, section: section || null, sectionMode: mode }),
    [qs, rows, roster, ins, showMissing, section, mode],
  );
  const qByNumber = useMemo(() => new Map(qs.map((q) => [q.number, q])), [qs]);
  const items: Item[] = useMemo(
    () => built.flatMap((bq) => bq.responses.map((r) => ({ ...r, q: qByNumber.get(bq.number)! }))),
    [built, qByNumber],
  );
  const missingNames = useMemo(() => nonSubmitters(roster, rows), [roster, rows]);

  function download() {
    const csvQuestions = buildResultsQuestions(qs, rows, roster, ins, { includeMissing: showMissing, section: section || null, sectionMode: mode });
    const text = buildResultsCsv(csvQuestions, {
      includeStats: true,
      indicateMissing: true,
      sectionName: section || undefined,
      sectionDetail: section ? SECTION_MODE_LABELS[mode] : undefined,
    });
    downloadText(safeFilename(c?.code ?? 'course', s?.name ?? 'session', 'results') + '.csv', text);
  }

  const cell = (it: ResultsResponse & { q: Question }) =>
    it.answer === null ? <em>{NO_RESPONSE_TEXT}</em> : answerText(it.q, it.answer);
  const trClass = (it: ResultsResponse) => (it.answer === null ? 'ins-missing' : undefined);

  const crumbs = [
    { to: '/', label: 'Courses' },
    { to: c ? `/courses/${c.id}` : undefined, label: c?.code ?? '...' },
    { to: s ? `/sessions/${s.id}/status` : undefined, label: s?.name ?? '...' },
    { label: 'Results' },
  ];
  const loadError = session.error ?? course.error ?? students.error ?? instructors.error ?? questions.error ?? responses.error ?? contrib.error;
  const loading = (session.loading || responses.loading || questions.loading || students.loading) && !s;

  return (
    <Page title={s ? `Results: ${s.name}` : 'Results'} crumbs={crumbs} wide>
      <ErrorBox error={loadError} />
      {loading && <Loading />}
      {s && c && (
        <>
          <div className="ins-card">
            <div className="ins-row">
              <label>
                View
                <select value={view} onChange={(e) => setView(e.target.value as View)}>
                  <option value="question">By question</option>
                  <option value="giver">By giver</option>
                  <option value="recipient">By recipient</option>
                </select>
              </label>
              <label>
                Section
                <select value={section} onChange={(e) => setSection(e.target.value)}>
                  <option value="">All sections</option>
                  {sections.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
              {section && (
                <label>
                  Match
                  <select value={mode} onChange={(e) => setMode(e.target.value as SectionMode)}>
                    {(Object.keys(SECTION_MODE_LABELS) as SectionMode[]).map((m) => <option key={m} value={m}>{SECTION_MODE_LABELS[m]}</option>)}
                  </select>
                </label>
              )}
              <label className="ins-inline"><input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} /> Show statistics</label>
              <label className="ins-inline"><input type="checkbox" checked={showMissing} onChange={(e) => setShowMissing(e.target.checked)} /> Show missing responses</label>
              <button type="button" onClick={download}>Download CSV</button>
              <Link className="ins-btn" to={`/sessions/${s.id}/status`}>Status</Link>
            </div>
            <p className="ins-hint">
              This is what instructors see: every name and response. Students see only what each question's visibility
              allows. {rows.length} responses in total.
            </p>
          </div>

          {view === 'question' &&
            built.map((bq) => {
              const q = qByNumber.get(bq.number)!;
              const real = bq.responses.filter((r) => r.answer !== null);
              const stats = showStats && q.type !== 'text' && q.type !== 'contrib'
                ? questionStats(q.type, q.details, toStatResponses(real))
                : null;
              const crows = (contrib.data?.get(q.id) ?? []).filter((r) => !section || r.section === section);
              return (
                <section key={q.id} className="ins-card">
                  <h3>Question {q.number}: {q.brief}</h3>
                  {q.description && <p className="ins-hint">{q.description}</p>}
                  {showStats && q.type === 'contrib' && <ContribTable rows={crows} />}
                  {showStats && q.type !== 'text' && q.type !== 'contrib' && <StatsTable stats={stats} />}
                  <div className="ins-scroll">
                    <table>
                      <thead>
                        <tr><th>Giver team</th><th>Giver</th><th>Recipient team</th><th>Recipient</th><th>Response</th><th>Giver comment</th></tr>
                      </thead>
                      <tbody>
                        {[...bq.responses]
                          .sort((a, b) => cmp(a.giver.team, b.giver.team) || cmp(a.giver.name, b.giver.name) || cmp(a.recipient.team, b.recipient.team) || cmp(a.recipient.name, b.recipient.name))
                          .map((r, i) => (
                            <tr key={i} className={trClass(r)}>
                              <td>{r.giver.team}</td>
                              <td>{r.giver.name}</td>
                              <td>{r.recipient.team}</td>
                              <td>{r.recipient.name}</td>
                              <td>{cell({ ...r, q })}</td>
                              <td>{r.giver_comment ?? ''}</td>
                            </tr>
                          ))}
                        {bq.responses.length === 0 && <tr><td colSpan={6} className="ins-muted">No responses.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}

          {view !== 'question' &&
            groupBy(items, view).map((g) => (
              <section key={g.key} className="ins-card">
                <h3>{g.name}{g.team ? ` (${g.team})` : ''}</h3>
                <div className="ins-scroll">
                  <table>
                    <thead>
                      <tr><th className="ins-num">Q</th><th>Question</th><th>{view === 'giver' ? 'Recipient' : 'Giver'}</th><th>Response</th><th>Giver comment</th></tr>
                    </thead>
                    <tbody>
                      {[...g.items]
                        .sort((a, b) => a.q.number - b.q.number || cmp((view === 'giver' ? a.recipient : a.giver).name, (view === 'giver' ? b.recipient : b.giver).name))
                        .map((it, i) => {
                          const other = view === 'giver' ? it.recipient : it.giver;
                          return (
                            <tr key={i} className={trClass(it)}>
                              <td className="ins-num">{it.q.number}</td>
                              <td>{it.q.brief}</td>
                              <td>{other.name}{other.team ? ` (${other.team})` : ''}</td>
                              <td>{cell(it)}</td>
                              <td>{it.giver_comment ?? ''}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          {view !== 'question' && items.length === 0 && <p className="ins-muted">No responses.</p>}

          <h2>Students who have not responded to any question ({missingNames.length})</h2>
          {missingNames.length === 0 ? (
            <p className="ins-muted">Everyone has responded.</p>
          ) : (
            <p>{missingNames.map((m) => `${m.name} (${m.team})`).join(', ')}</p>
          )}
          <p className="ins-hint">Section filter applies to the response tables and CSV, not to this list.</p>
        </>
      )}
    </Page>
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
