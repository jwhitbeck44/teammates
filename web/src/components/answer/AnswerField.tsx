import type { PayloadQuestion } from '../../lib/studentTypes';
import type { AnswerInput } from './mapping';
import TextInput from './TextInput';
import McqInput from './McqInput';
import MsqInput from './MsqInput';
import NumscaleInput from './NumscaleInput';
import ConstsumOptionsInput from './ConstsumOptionsInput';
import ConstsumRecipientInput from './ConstsumRecipientInput';
import ContribInput from './ContribInput';
import RubricInput from './RubricInput';
import RankOptionsInput from './RankOptionsInput';
import RankRecipientInput from './RankRecipientInput';

export interface AnswerFieldProps {
  question: PayloadQuestion;
  input: AnswerInput;
  onChange: (next: AnswerInput) => void;
  idPrefix: string;
  labelId: string;
  disabled?: boolean;
  /** Highest rank offered for rank_recipients. */
  rankLimit: number;
}

/** The input for one recipient of one question, chosen by question type. */
export default function AnswerField({ question: q, input, onChange, idPrefix, labelId, disabled, rankLimit }: AnswerFieldProps) {
  const common = { idPrefix, labelId, disabled };
  // The type check on `input` keeps a stale input of another type from rendering wrongly.
  if (input.type !== q.type) return null;
  switch (q.type) {
    case 'text':
      return <TextInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'mcq':
      return <McqInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'msq':
      return <MsqInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'numscale':
      return <NumscaleInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'constsum_options':
      return <ConstsumOptionsInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'constsum_recipients':
      return <ConstsumRecipientInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'contrib':
      return <ContribInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'rubric':
      return <RubricInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'rank_options':
      return <RankOptionsInput {...common} details={q.details} input={input as never} onChange={onChange} />;
    case 'rank_recipients':
      return <RankRecipientInput {...common} details={q.details} input={input as never} onChange={onChange} limit={rankLimit} />;
  }
}
