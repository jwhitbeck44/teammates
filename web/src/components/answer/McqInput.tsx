import type { McqDetails } from '../../lib/types';
import type { InputOf, InputProps } from './props';

export default function McqInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'mcq'>, McqDetails>) {
  const name = `${idPrefix}-mcq`;
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="choices">
      {details.choices.map((c, i) => (
        <label key={i} className="choice">
          <input
            type="radio"
            name={name}
            checked={!input.otherSelected && input.choice === c}
            disabled={disabled}
            onChange={() => onChange({ ...input, choice: c, otherSelected: false })}
          />
          <span>{c}</span>
        </label>
      ))}
      {details.otherEnabled ? (
        <div className="choice-other">
          <label className="choice">
            <input
              type="radio"
              name={name}
              checked={input.otherSelected}
              disabled={disabled}
              onChange={() => onChange({ ...input, choice: null, otherSelected: true })}
            />
            <span>Other</span>
          </label>
          <input
            type="text"
            aria-label="Other: your answer"
            value={input.other}
            disabled={disabled || !input.otherSelected}
            onChange={(e) => onChange({ ...input, other: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}
