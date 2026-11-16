import type { QuestionStats } from '../../lib/stats';
import { statsRows } from '../../lib/csv';

/** Statistics block of one question as a table, built from the same rows the CSV uses. */
export function StatsTable({ stats }: { stats: QuestionStats | null }) {
  const rows = statsRows(stats);
  if (rows.length === 0) return <p className="ins-muted ins-small">No statistics for this question yet.</p>;
  // Rows with one cell are explanatory notes; the first row with several cells is the header.
  const headerIndex = rows.findIndex((r) => r.length > 1);
  const notes = rows.slice(0, Math.max(0, headerIndex)).filter((r) => r.length === 1);
  const header = headerIndex >= 0 ? rows[headerIndex] : [];
  const body = headerIndex >= 0 ? rows.slice(headerIndex + 1) : [];
  const width = Math.max(header.length, ...body.map((r) => r.length));
  return (
    <div className="ins-scroll">
      {notes.map((n, i) => <p key={i} className="ins-hint">{n[0]}</p>)}
      <table className="ins-stats">
        <thead>
          <tr>{header.map((h, i) => <th key={i}>{h}</th>)}{Array.from({ length: Math.max(0, width - header.length) }).map((_, i) => <th key={`x${i}`}></th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
