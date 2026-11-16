import type { ConstsumOptionsDetails } from '../../lib/types';
import { constsumRules, constsumTarget, sumPoints } from './mapping';
import type { InputOf, InputProps } from './props';

export default function ConstsumOptionsInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'constsum_options'>, ConstsumOptionsDetails>) {
  const total = sumPoints(input.points);
  const target = constsumTarget(details, details.options.length);
  const rules = constsumRules(details);
  const ok = total === target;
  return (
    <div role="group" aria-labelledby={labelId}>
      {rules.length > 0 ? <p className="hint">{rules.join(' ')}</p> : null}
      <ul className="plain-list">
        {details.options.map((o, i) => (
          <li key={i} className="field-row">
            <label htmlFor={`${idPrefix}-opt-${i}`}>{o}</label>
            <input
              id={`${idPrefix}-opt-${i}`}
              type="number"
              inputMode="numeric"
              step={1}
              className="num"
              value={input.points[i] ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...input, points: input.points.map((p, j) => (j === i ? e.target.value : p)) })}
            />
          </li>
        ))}
      </ul>
      <p className={`total ${ok ? 'total-ok' : 'total-off'}`} aria-live="polite">
        Total: {total} of {target}
        {ok ? ' (done)' : total > target ? ` (${total - target} too many)` : ` (${target - total} left)`}
      </p>
    </div>
  );
}
