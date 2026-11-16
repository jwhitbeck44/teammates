import type { RankOptionsDetails } from '../../lib/types';
import { rankChoices, rankRules } from './mapping';
import type { InputOf, InputProps } from './props';

export default function RankOptionsInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'rank_options'>, RankOptionsDetails>) {
  const choices = rankChoices(details.options.length);
  return (
    <div role="group" aria-labelledby={labelId}>
      <p className="hint">{rankRules(details).join(' ')}</p>
      <ul className="plain-list">
        {details.options.map((o, i) => (
          <li key={i} className="field-row">
            <label htmlFor={`${idPrefix}-rank-${i}`}>{o}</label>
            <select
              id={`${idPrefix}-rank-${i}`}
              value={input.ranks[i] ?? ''}
              disabled={disabled}
              onChange={(e) => onChange({ ...input, ranks: input.ranks.map((r, j) => (j === i ? e.target.value : r)) })}
            >
              <option value="">No rank</option>
              {choices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
