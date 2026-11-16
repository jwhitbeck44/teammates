import type { MsqDetails } from '../../lib/types';
import { msqRules, toggleMsqChoice } from './mapping';
import type { InputOf, InputProps } from './props';

export default function MsqInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'msq'>, MsqDetails>) {
  const rules = msqRules(details);
  return (
    <div role="group" aria-labelledby={labelId} className="choices">
      {rules.length > 0 ? <p className="hint">{rules.join(' ')}</p> : null}
      {details.choices.map((c, i) => (
        <label key={i} className="choice">
          <input
            type="checkbox"
            name={`${idPrefix}-msq`}
            checked={input.choices.includes(c)}
            disabled={disabled}
            onChange={(e) => onChange(toggleMsqChoice(input, c, e.target.checked))}
          />
          <span>{c}</span>
        </label>
      ))}
      {details.otherEnabled ? (
        <div className="choice-other">
          <label className="choice">
            <input
              type="checkbox"
              checked={input.otherChecked}
              disabled={disabled}
              onChange={(e) => onChange({ ...input, otherChecked: e.target.checked, none: false })}
            />
            <span>Other</span>
          </label>
          <input
            type="text"
            aria-label="Other: your answer"
            value={input.other}
            disabled={disabled || !input.otherChecked}
            onChange={(e) => onChange({ ...input, other: e.target.value })}
          />
        </div>
      ) : null}
      <label className="choice">
        <input
          type="checkbox"
          checked={input.none}
          disabled={disabled}
          onChange={(e) =>
            onChange(e.target.checked ? { ...input, choices: [], otherChecked: false, other: '', none: true } : { ...input, none: false })
          }
        />
        <span>None of the above</span>
      </label>
    </div>
  );
}
