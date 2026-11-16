import type { ConstsumRecipientsDetails } from '../../lib/types';
import type { InputOf, InputProps } from './props';

/** One number box for one recipient. The running total lives in the question block. */
export default function ConstsumRecipientInput({ idPrefix, labelId, input, onChange, disabled }: InputProps<InputOf<'constsum_recipients'>, ConstsumRecipientsDetails>) {
  return (
    <input
      id={`${idPrefix}-pts`}
      type="number"
      inputMode="numeric"
      step={1}
      className="num"
      aria-labelledby={labelId}
      value={input.points}
      disabled={disabled}
      onChange={(e) => onChange({ ...input, points: e.target.value })}
    />
  );
}
