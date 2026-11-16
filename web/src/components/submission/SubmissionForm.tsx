import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PayloadQuestion, StudentSessionPayload } from '../../lib/studentTypes';
import { validateAnswers } from '../../lib/validation';
import { mapRpcError } from '../../lib/studentView';
import { ValidationError } from '../../lib/errors';
import {
  QuestionState,
  asValidationQuestion,
  buildSubmission,
  initState,
  signature,
} from '../answer/draft';
import QuestionBlock, { QErrors, QStatus } from './QuestionBlock';

export interface SubmissionFormProps {
  payload: StudentSessionPayload;
  readOnly?: boolean;
  onSaveQuestion?: (
    questionId: string,
    answers: { recipient_key: string; answer: unknown; giver_comment?: string | null }[],
  ) => Promise<void>;
  banner?: ReactNode;
}

type Maps<T> = Record<string, T>;

/** Group validation or server errors by row. Question-wide errors go to `general`. */
export function toQErrors(list: { message: string; recipient_key?: string | null }[]): QErrors {
  const out: QErrors = { general: [], rows: {} };
  for (const e of list) {
    if (e.recipient_key) (out.rows[e.recipient_key] ??= []).push(e.message);
    else if (!out.general.includes(e.message)) out.general.push(e.message);
  }
  if (Object.keys(out.rows).length > 0 && out.general.length === 0) out.general.push('Fix the problems marked below.');
  return out;
}

export function validationToQErrors(list: ValidationError[]): QErrors {
  return toQErrors(list);
}

/**
 * The whole session as one form: instructions, then every question with its recipients, inputs,
 * a Save button and a saved or unsaved state. State is created from `payload` when the form
 * mounts; give the form a new `key` if the payload should be replaced.
 */
export function SubmissionForm({ payload, readOnly = false, onSaveQuestion, banner }: SubmissionFormProps) {
  const questions = payload.questions;
  const [states, setStates] = useState<Maps<QuestionState>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, initState(q)])),
  );
  const [savedSig, setSavedSig] = useState<Maps<string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, signature(q, initState(q))])),
  );
  const [saving, setSaving] = useState<Maps<boolean>>({});
  const [errors, setErrors] = useState<Maps<QErrors | null>>({});
  const [summary, setSummary] = useState('');

  const statesRef = useRef(states);
  statesRef.current = states;
  const sigRef = useRef(savedSig);
  sigRef.current = savedSig;

  const canSave = !readOnly && onSaveQuestion !== undefined;

  const statusOf = useCallback(
    (q: PayloadQuestion): QStatus => {
      if (saving[q.id]) return 'saving';
      const dirty = signature(q, states[q.id]) !== savedSig[q.id];
      if (dirty) return 'unsaved';
      return savedSig[q.id] !== '[]' ? 'saved' : 'empty';
    },
    [saving, states, savedSig],
  );

  const dirtyCount = useMemo(
    () => questions.filter((q) => signature(q, states[q.id]) !== savedSig[q.id]).length,
    [questions, states, savedSig],
  );

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!canSave || dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [canSave, dirtyCount]);

  /** Validate and save one question. Resolves true when saved. */
  const saveQuestion = useCallback(
    async (q: PayloadQuestion): Promise<boolean> => {
      if (!onSaveQuestion) return false;
      const state = statesRef.current[q.id];
      const submission = buildSubmission(q, state);
      const problems = validateAnswers(asValidationQuestion(q), q.recipients, submission);
      if (problems.length > 0) {
        setErrors((e) => ({ ...e, [q.id]: toQErrors(problems) }));
        return false;
      }
      setSaving((s) => ({ ...s, [q.id]: true }));
      setErrors((e) => ({ ...e, [q.id]: null }));
      try {
        await onSaveQuestion(q.id, submission);
        setSavedSig((s) => ({ ...s, [q.id]: JSON.stringify(submission) }));
        return true;
      } catch (err) {
        const mapped = mapRpcError(err);
        setErrors((e) => ({ ...e, [q.id]: toQErrors([
            {
              message: mapped.message,
              recipient_key: submission.some((r) => r.recipient_key === mapped.recipient_key) ? mapped.recipient_key : null,
            },
          ]) }));
        return false;
      } finally {
        setSaving((s) => ({ ...s, [q.id]: false }));
      }
    },
    [onSaveQuestion],
  );

  const saveAll = async () => {
    setSummary('');
    let saved = 0;
    let failed = 0;
    for (const q of questions) {
      if (signature(q, statesRef.current[q.id]) === sigRef.current[q.id]) continue;
      if (await saveQuestion(q)) saved += 1;
      else failed += 1;
    }
    if (saved === 0 && failed === 0) setSummary('Nothing to save.');
    else
      setSummary(
        `${saved} saved.${failed > 0 ? ` ${failed} not saved: see the questions marked "Not saved".` : ''}`,
      );
  };

  return (
    <div className="submission">
      {banner}
      {payload.session.instructions.trim() !== '' ? (
        <section className="instructions" aria-label="Instructions">
          <h2>Instructions</h2>
          <p className="pre">{payload.session.instructions}</p>
        </section>
      ) : null}

      {questions.length === 0 ? <p>There are no questions for you in this session.</p> : null}

      {questions.map((q) => (
        <QuestionBlock
          key={q.id}
          question={q}
          student={payload.student}
          state={states[q.id]}
          onChange={(next) => {
            setStates((s) => ({ ...s, [q.id]: next }));
            setSummary('');
          }}
          errors={errors[q.id] ?? null}
          status={statusOf(q)}
          readOnly={!canSave}
          onSave={canSave ? () => void saveQuestion(q) : undefined}
        />
      ))}

      {canSave && questions.length > 0 ? (
        <div className="save-bar">
          <div className="save-bar-text" role="status">
            {summary || (dirtyCount > 0 ? `${dirtyCount} not saved` : 'All saved')}
          </div>
          <button type="button" className="primary" onClick={() => void saveAll()} disabled={Object.values(saving).some(Boolean)}>
            Save all
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default SubmissionForm;
