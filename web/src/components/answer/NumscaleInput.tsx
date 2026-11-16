import type { NumscaleDetails } from '../../lib/types';
import type { InputOf, InputProps } from './props';

export default function NumscaleInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'numscale'>, NumscaleDetails>) {
  return (
    <div>
      <input
        id={`${idPrefix}-num`}
        type="number"
        inputMode="decimal"
        aria-labelledby={labelId}
        aria-describedby={`${idPrefix}-hint`}
        min={details.min}
        max={details.max}
        step={details.step}
        value={input.value}
        disabled={disabled}
        className="num"
        onChange={(e) => onChange({ ...input, value: e.target.value })}
      />
      <p id={`${idPrefix}-hint`} className="hint">
        From {details.min} to {details.max}, in steps of {details.step}.
      </p>
    </div>
  );
}
