import type { PayloadQuestion } from '../../lib/studentTypes';
import { describeVisibility } from '../../lib/visibility';
import type { Recipient } from '../../lib/types';
import AnswerField from '../answer/AnswerField';
import RecipientPicker from '../answer/RecipientPicker';
import {
  QuestionState,
  activeRecipients,
  isCapped,
  isSelfRecipient,
  rankLimit,
  toggleChosen,
} from '../answer/draft';
import {
  constsumRules,
  constsumTarget,
  contribTarget,
  contribTotal,
  emptyInput,
  parseNumber,
  rankRules,
  sumPoints,
} from '../answer/mapping';

export interface QErrors {
  general: string[];
  rows: Record<string, string[]>;
}

export type QStatus = 'saving' | 'unsaved' | 'saved' | 'empty';

export const STATUS_TEXT: Record<QStatus, string> = {
  saving: 'Saving...',
  unsaved: 'Not saved',
  saved: 'Saved',
  empty: 'No answer yet',
};

interface Props {
  question: PayloadQuestion;
  student?: { name: string; team: string; section: string };
  state: QuestionState;
  onChange: (next: QuestionState) => void;
  errors: QErrors | null;
  status: QStatus;
  readOnly: boolean;
  onSave?: () => void;
}

export default function QuestionBlock({ question: q, student, state, onChange, errors, status, readOnly, onSave }: Props) {
  const qid = `q-${q.id}`;
  const rows = activeRecipients(q, state);
  const capped = isCapped(q);
  const limit = rankLimit(q);
  const hasLists = q.show_responses_to !== undefined;
  const who = hasLists
    ? describeVisibility({
        show_responses_to: q.show_responses_to ?? [],
        show_giver_name_to: q.show_giver_name_to ?? [],
        show_recipient_name_to: q.show_recipient_name_to ?? [],
      })
    : [];
  const self = (r: Recipient) => isSelfRecipient(student, q, r);

  const setInput = (key: string, next: QuestionState['inputs'][string]) =>
    onChange({ ...state, inputs: { ...state.inputs, [key]: next } });

  // Question-wide totals
  let totalLine: { text: string; ok: boolean } | null = null;
  let rules: string[] = [];
  if (q.type === 'contrib' && q.details.isZeroSum) {
    const values = rows.map((r) => (state.inputs[r.recipient_key] as { value?: string } | undefined)?.value ?? '');
    const total = contribTotal(values);
    const target = contribTarget(rows.length);
    totalLine = {
      text: `Total: ${total}. Needs to be ${target} (100 x ${rows.length}). Equal share is 100 each.`,
      ok: total === target,
    };
  } else if (q.type === 'constsum_recipients') {
    const values = rows.map((r) => (state.inputs[r.recipient_key] as { points?: string } | undefined)?.points ?? '');
    const answered = values.filter((v) => parseNumber(v) !== null).length;
    const total = sumPoints(values);
    const target = constsumTarget(q.details, answered > 0 ? answered : rows.length);
    totalLine = { text: `Total: ${total} of ${target}`, ok: total === target };
    rules = constsumRules(q.details);
  } else if (q.type === 'rank_recipients') {
    rules = rankRules(q.details);
  }

  return (
    <section className="question" aria-labelledby={`${qid}-title`}>
      <div className="question-head">
        <h2 id={`${qid}-title`}>
          {q.number}. {q.brief}
        </h2>
        <span className={`status status-${status}`}>
          <span aria-hidden="true" className="status-mark">
            {status === 'saved' ? 'OK' : status === 'unsaved' ? '!' : status === 'saving' ? '...' : '-'}
          </span>{' '}
          {STATUS_TEXT[status]}
        </span>
      </div>
      {q.description ? <p className="description">{q.description}</p> : null}
      {who.length > 0 ? (
        <div className="who">
          <strong>Who can see your answer</strong>
          <ul>
            {who.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {rules.length > 0 ? <p className="hint">{rules.join(' ')}</p> : null}

      {q.recipients.length === 0 ? <p className="hint">There is nobody to answer for here.</p> : null}

      {capped ? (
        <RecipientPicker
          idPrefix={qid}
          recipients={q.recipients}
          chosen={state.chosen}
          max={q.max_recipients as number}
          disabled={readOnly}
          isSelf={self}
          onToggle={(key, on) => onChange({ ...state, chosen: toggleChosen(q, state.chosen, key, on) })}
        />
      ) : null}

      {rows.map((r, i) => {
        const key = r.recipient_key;
        const labelId = `${qid}-r${i}-label`;
        const input = state.inputs[key] ?? emptyInput(q.type, q.details as never);
        const rowErrors = errors?.rows[key] ?? [];
        const noName = key === 'none';
        return (
          <div key={key} className="recipient">
            {noName ? (
              <span id={labelId} className="sr-only">
                Your answer
              </span>
            ) : (
              <h3 id={labelId}>
                {r.display_name}
                {self(r) ? ' (you)' : ''}
              </h3>
            )}
            <AnswerField
              question={q}
              input={input}
              onChange={(next) => setInput(key, next)}
              idPrefix={`${qid}-r${i}`}
              labelId={labelId}
              disabled={readOnly}
              rankLimit={limit}
            />
            {!readOnly ? (
              <button
                type="button"
                className="link-button"
                aria-label={`Clear answer${noName ? '' : ` for ${r.display_name}`}`}
                onClick={() => setInput(key, emptyInput(q.type, q.details as never))}
              >
                Clear
              </button>
            ) : null}
            {rowErrors.map((m, j) => (
              <p key={j} className="field-error" role="alert">
                {m}
              </p>
            ))}
          </div>
        );
      })}

      {totalLine ? (
        <p className={`total ${totalLine.ok ? 'total-ok' : 'total-off'}`} aria-live="polite">
          {totalLine.text}
          {totalLine.ok ? ' (done)' : ''}
        </p>
      ) : null}

      {errors && errors.general.length > 0 ? (
        <div className="error-box" role="alert">
          <strong>Not saved: </strong>
          {errors.general.join(' ')}
        </div>
      ) : null}

      {!readOnly && onSave ? (
        <div className="actions">
          <button type="button" className="primary" onClick={onSave} disabled={status === 'saving'}>
            {status === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
