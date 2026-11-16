import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { enrollStudents, getCourse, listStudents, type EnrollResult } from '../../api/instructor';
import { parseRosterCsv, ROSTER_HEADER } from '../../lib/csv';
import { errorMessage } from '../../lib/errors';
import { ErrorBox, Loading, Page, useAction, useCoursePerms, useLoad } from '../../components/instructor/ui';

export default function CourseEnroll() {
  const { courseId } = useParams<{ courseId: string }>();
  const course = useLoad(() => getCourse(courseId!), [courseId]);
  const students = useLoad(() => listStudents(courseId!), [courseId]);
  const perms = useCoursePerms(courseId);
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ res: EnrollResult; sentRows: number[] } | null>(null);
  const action = useAction();

  const existing = students.data ?? [];
  const parsed = useMemo(() => (text.trim() === '' ? null : parseRosterCsv(text, { existing })), [text, existing]);
  const existingEmails = useMemo(() => new Set(existing.map((s) => s.email)), [existing]);
  const errorsByRow = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const e of parsed?.errors ?? []) m.set(e.row, [...(m.get(e.row) ?? []), `${e.field ? e.field + ': ' : ''}${e.message}`]);
    return m;
  }, [parsed]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setText(await f.text());
    setResult(null);
    e.target.value = '';
  }

  async function enroll() {
    if (!parsed || parsed.valid.length === 0) return;
    const rows = parsed.valid.map((r) => ({ section: r.section, team: r.team, name: r.name, email: r.email, comments: r.comments || null }));
    const sentRows = parsed.valid.map((r) => r.row);
    let res: EnrollResult | null = null;
    const ok = await action.run(async () => {
      res = await enrollStudents(courseId!, rows);
    });
    if (ok && res) {
      setResult({ res, sentRows });
      if ((res as EnrollResult).errors.length === 0) setText('');
      students.reload();
    }
  }

  const canModify = perms.can('modify_students');
  const crumbs = [
    { to: '/', label: 'Courses' },
    { to: `/courses/${courseId}?tab=students`, label: course.data?.code ?? '...' },
    { label: 'Enroll' },
  ];

  return (
    <Page title="Enroll students" crumbs={crumbs}>
      <ErrorBox error={course.error ?? students.error} />
      {(course.loading || perms.loading) && <Loading />}
      {!perms.loading && !canModify && <p className="ins-notice">You do not have permission to enroll students in this course.</p>}
      {canModify && (
        <>
          <p>
            Paste rows or upload a CSV file with the columns <strong>{ROSTER_HEADER.join(', ')}</strong> (a header row is
            optional). Only Name and Email are required; an empty Section or Team becomes "Default Section" or "Default
            Team". A student whose email is already in the course is updated.
          </p>
          <textarea
            rows={10}
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
            placeholder={'Section,Team,Name,Email,Comments\nA,Team 1,Ada Lovelace,ada@example.edu,'}
            aria-label="Roster rows"
          />
          <div className="ins-actions">
            <label className="ins-btn">
              Upload CSV file
              <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => void onFile(e)} hidden />
            </label>
            <Link className="ins-btn" to={`/courses/${courseId}?tab=students`}>Back to students</Link>
          </div>

          {parsed && (
            <>
              <h2>Preview</h2>
              <p>
                {parsed.rows.length} rows, {parsed.valid.length} valid, {parsed.errors.length > 0 ? `${new Set(parsed.errors.map((e) => e.row)).size} with errors` : 'no errors'}.
              </p>
              {errorsByRow.has(0) && <ErrorBox error={errorsByRow.get(0)!.join(' ')} />}
              <div className="ins-scroll">
                <table>
                  <thead>
                    <tr><th className="ins-num">Row</th><th>Section</th><th>Team</th><th>Name</th><th>Email</th><th>Comments</th><th>Result</th></tr>
                  </thead>
                  <tbody>
                    {parsed.rows.map((r) => {
                      const errs = errorsByRow.get(r.row);
                      return (
                        <tr key={r.row} className={errs ? 'ins-bad' : undefined}>
                          <td className="ins-num">{r.row}</td>
                          <td>{r.section}</td>
                          <td>{r.team}</td>
                          <td>{r.name}</td>
                          <td>{r.email}</td>
                          <td>{r.comments}</td>
                          <td>{errs ? errs.join('; ') : existingEmails.has(r.email) ? 'Update' : 'New'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ErrorBox error={action.error} />
              <div className="ins-actions">
                <button type="button" className="ins-primary" onClick={() => void enroll()} disabled={action.busy || parsed.valid.length === 0}>
                  Enroll {parsed.valid.length} {parsed.valid.length === 1 ? 'student' : 'students'}
                </button>
                {parsed.errors.length > 0 && <span className="ins-muted">Rows with errors are skipped.</span>}
              </div>
            </>
          )}

          {result && (
            <div className={result.res.errors.length === 0 ? 'ins-ok' : 'ins-error'}>
              {result.res.errors.length === 0 ? (
                <p>Done: {result.res.created} created, {result.res.updated} updated.</p>
              ) : (
                <>
                  <p>Nobody was enrolled. The server found these problems (it saves all rows or none):</p>
                  <ul>
                    {result.res.errors.map((e, i) => (
                      <li key={i}>Row {result.sentRows[e.row - 1] ?? e.row}: {errorMessage(e.code)}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
