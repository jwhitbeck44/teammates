import type { ContribDetails } from '../../lib/types';
import { contribOptions } from './mapping';
import type { InputOf, InputProps } from './props';

/** One select for one team member. The running total lives in the question block. */
export default function ContribInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'contrib'>, ContribDetails>) {
  return (
    <select
      id={`${idPrefix}-contrib`}
      aria-labelledby={labelId}
      value={input.value}
      disabled={disabled}
      onChange={(e) => onChange({ ...input, value: e.target.value })}
    >
      <option value="">Choose</option>
      {contribOptions(details.isNotSureAllowed).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
