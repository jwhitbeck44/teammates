import type { Recipient } from '../../lib/types';

interface Props {
  idPrefix: string;
  recipients: readonly Recipient[];
  chosen: readonly string[];
  max: number;
  onToggle: (key: string, on: boolean) => void;
  disabled?: boolean;
  isSelf?: (r: Recipient) => boolean;
}

/** For questions with max_recipients: the giver picks who to answer for. */
export default function RecipientPicker({ idPrefix, recipients, chosen, max, onToggle, disabled, isSelf }: Props) {
  const full = chosen.length >= max;
  return (
    <fieldset className="picker">
      <legend>
        Pick up to {max} to answer for ({chosen.length} picked)
      </legend>
      <div className="picker-list">
        {recipients.map((r, i) => {
          const on = chosen.includes(r.recipient_key);
          return (
            <label key={r.recipient_key} className="choice">
              <input
                id={`${idPrefix}-pick-${i}`}
                type="checkbox"
                checked={on}
                disabled={disabled || (!on && full)}
                onChange={(e) => onToggle(r.recipient_key, e.target.checked)}
              />
              <span>
                {r.display_name}
                {isSelf?.(r) ? ' (you)' : ''}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
