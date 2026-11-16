import type { AnswerInput } from './mapping';

/** Props shared by the per-type inputs. One input component renders the answer for one recipient. */
export interface InputProps<I extends AnswerInput, D> {
  /** Unique prefix for element ids and radio group names. */
  idPrefix: string;
  /** Id of the element that names this answer (the recipient heading). */
  labelId: string;
  details: D;
  input: I;
  onChange: (next: I) => void;
  disabled?: boolean;
}

export type InputOf<T extends AnswerInput['type']> = Extract<AnswerInput, { type: T }>;
