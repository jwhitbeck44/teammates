import type { RankRecipientsDetails } from '../../lib/types';
import { rankChoices } from './mapping';
import type { InputOf, InputProps } from './props';

/** One rank select for one recipient. `limit` is the highest rank offered. */
export default function RankRecipientInput({
  idPrefix,
  labelId,
  input,
  onChange,
  disabled,
  limit,
}: InputProps<InputOf<'rank_recipients'>, RankRecipientsDetails> & { limit: number }) {
  return (
    <select
      id={`${idPrefix}-rank`}
      aria-labelledby={labelId}
      value={input.rank}
      disabled={disabled}
      onChange={(e) => onChange({ ...input, rank: e.target.value })}
    >
      <option value="">No rank</option>
      {rankChoices(limit).map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}
