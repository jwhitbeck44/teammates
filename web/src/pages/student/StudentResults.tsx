import { Link, useParams } from 'react-router-dom';
import { studentGetResults } from '../../api/student';
import type { ResultsQuestion } from '../../api/student';
import { ErrorMessage, Loading, Page, useLoad } from '../../components/common';
import { answerText } from '../../lib/answerText';
import { contribSummaryLines, groupResults, isInvalidToken, resultRowTitle } from '../../lib/studentView';
import InvalidLink from './InvalidLink';

export default function StudentResults() {
  const { token = '', sessionId = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => studentGetResults(token, sessionId), [token, sessionId]);
  const back = (
    <p>
      <Link to={`/s/${token}`}>Back to your sessions</Link>
    </p>
  );

  if (loading) return <Page title="Results"><Loading /></Page>;
  if (error && isInvalidToken(error)) return <InvalidLink />;
  if (error?.code === 'not_published') {
    return (
      <Page title="Results are not out yet">
        <p>Your instructor has not published results for this session. Check back later.</p>
        {back}
      </Page>
    );
  }
  if (error || !data) {
    return (
      <Page title="Results">
        <ErrorMessage>{error?.message ?? 'Could not load.'}</ErrorMessage>
        <p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </p>
        {back}
      </Page>
    );
  }

  return (
    <Page title={data.session.name} subtitle={`Results for ${data.student.name}, ${data.course.name}`}>
      {back}
      {data.questions.length === 0 ? <p>There is nothing to show you for this session.</p> : null}
      {data.questions.map((q) => (
        <ResultQuestion key={q.id} q={q} />
      ))}
    </Page>
  );
}

function ResultQuestion({ q }: { q: ResultsQuestion }) {
  const groups = groupResults(q.responses);
  return (
    <section className="question" aria-labelledby={`rq-${q.id}`}>
      <h2 id={`rq-${q.id}`}>
        {q.number}. {q.brief}
      </h2>
      {q.description ? <p className="description">{q.description}</p> : null}

      {q.contrib
        ? contribSummaryLines(q.contrib).map((block) => (
            <div key={block.heading} className="result-group">
              <h3>{block.heading}</h3>
              {block.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          ))
        : null}

      {groups.map((g) => (
        <div key={g.id} className="result-group">
          <h3>{g.title}</h3>
          <ul className="plain-list">
            {g.rows.map((r, i) => (
              <li key={i} className="result-row">
                <p className="row-title">{resultRowTitle(g.id, r)}</p>
                <p className="answer pre">{answerText({ type: q.type, details: q.details }, r.answer)}</p>
                {r.giver_comment ? <p className="comment pre">Comment: {r.giver_comment}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
