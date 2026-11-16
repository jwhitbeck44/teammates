import { useState } from 'react';
import { allowedGiverTypes, allowedRecipientTypes, GIVER_TYPE_LABELS, RECIPIENT_TYPE_LABELS } from '../../../lib/recipients';
import { validateQuestion } from '../../../lib/validation';
import { applicableVisibilityTypes, normalizeVisibility } from '../../../lib/visibility';
import type { GiverType, QuestionDraft, RecipientType, VisibilityType } from '../../../lib/types';
import { cleanJson, TYPE_LABELS } from './draft';
import { DetailsEditor } from './DetailsEditors';
import { NumberField } from './fields';
import { VisibilityEditor } from './VisibilityEditor';

/** Re-fit visibility to a new path: drop types that do not apply, then apply the editor rules. */
function refit(d: QuestionDraft): QuestionDraft {
  const ok = new Set<VisibilityType>(applicableVisibilityTypes(d.giver_type, d.recipient_type));
  const keep = (l: VisibilityType[]) => l.filter((v) => ok.has(v));
  const lists = normalizeVisibility({
    show_responses_to: keep(d.show_responses_to),
    show_giver_name_to: keep(d.show_giver_name_to),
    show_recipient_name_to: keep(d.show_recipient_name_to),
  });
  return { ...d, ...lists };
}

export default function QuestionEditor({
  initial,
  isNew,
  warning,
  responseCount = 0,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: QuestionDraft;
  isNew: boolean;
  /** Text shown above the buttons when saving would delete responses (computed by the parent). */
  warning?: (d: QuestionDraft) => string | null;
  /** Number of answers already stored for this question (0 for a new one). */
  responseCount?: number;
  busy: boolean;
  error: string | null;
  onSave: (d: QuestionDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<QuestionDraft>(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const giverTypes = allowedGiverTypes(draft.type);
  const recipients = allowedRecipientTypes(draft.giver_type, draft.type);
  const limitable = draft.type !== 'contrib' && !['none', 'self', 'own_team'].includes(draft.recipient_type);
  const warn = warning ? warning(draft) : null;

  function setPath(giver: GiverType, recipient: RecipientType) {
    setDraft(refit({ ...draft, giver_type: giver, recipient_type: recipient }));
  }

  function changeGiver(g: GiverType) {
    const allowed = allowedRecipientTypes(g, draft.type);
    setPath(g, allowed.includes(draft.recipient_type) ? draft.recipient_type : allowed[0]);
  }

  function save() {
    const d = cleanJson(draft);
    const errs = validateQuestion(d);
    if (errs.length > 0) {
      setProblems(errs.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)));
      return;
    }
    setProblems([]);
    onSave(d);
  }

  return (
    <div className="ins-card">
      <h3>{isNew ? 'New' : 'Edit'} question: {TYPE_LABELS[draft.type]}</h3>
      <div className="ins-form">
        <label>
          Question
          <input type="text" value={draft.brief} onChange={(e) => setDraft({ ...draft, brief: e.target.value })} />
        </label>
        <label>
          More detail (optional)
          <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
      </div>

      <DetailsEditor draft={draft} onChange={setDraft} />

      <h3>Who answers about whom</h3>
      <div className="ins-row">
        <label>
          Giver
          <select value={draft.giver_type} onChange={(e) => changeGiver(e.target.value as GiverType)} disabled={giverTypes.length < 2}>
            {giverTypes.map((g) => <option key={g} value={g}>{GIVER_TYPE_LABELS[g]}</option>)}
          </select>
        </label>
        <label>
          Recipient
          <select value={draft.recipient_type} onChange={(e) => setPath(draft.giver_type, e.target.value as RecipientType)} disabled={recipients.length < 2}>
            {recipients.map((r) => <option key={r} value={r}>{RECIPIENT_TYPE_LABELS[r]}</option>)}
          </select>
        </label>
        {limitable && (
          <>
            <label>
              Number of recipients
              <select
                value={draft.max_recipients === null ? 'all' : 'some'}
                onChange={(e) => setDraft({ ...draft, max_recipients: e.target.value === 'all' ? null : 1 })}
              >
                <option value="all">Answer for all</option>
                <option value="some">Choose up to N</option>
              </select>
            </label>
            {draft.max_recipients !== null && (
              <NumberField label="N" value={draft.max_recipients} min={1} step={1} required onChange={(v) => setDraft({ ...draft, max_recipients: v ?? 1 })} />
            )}
          </>
        )}
      </div>

      <h3>Visibility</h3>
      <VisibilityEditor
        key={`${draft.giver_type}/${draft.recipient_type}`}
        type={draft.type}
        giver={draft.giver_type}
        recipient={draft.recipient_type}
        lists={draft}
        responseCount={responseCount}
        onChange={(l) => setDraft({ ...draft, ...l })}
      />

      {problems.length > 0 && (
        <div className="ins-error" role="alert">
          <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {error && <p className="ins-error" role="alert">{error}</p>}
      {warn && <p className="ins-notice">{warn}</p>}
      <div className="ins-actions">
        <button type="button" className="ins-primary" onClick={save} disabled={busy}>Save question</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
