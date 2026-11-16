import { RUBRIC_UNANSWERED } from '../../lib/types';
import type { RubricDetails } from '../../lib/types';
import { alphabeticalIndex } from '../../lib/answerText';
import type { InputOf, InputProps } from './props';

/** A grid of radio buttons: one group per sub-question, one cell per choice. */
export default function RubricInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'rubric'>, RubricDetails>) {
  const cols = details.choices.length;
  return (
    <div role="group" aria-labelledby={labelId} className="rubric">
      {details.subQuestions.map((sub, si) => (
        <fieldset key={si} className="rubric-row">
          <legend>
            {alphabeticalIndex(si + 1)}) {sub}
          </legend>
          <div className="rubric-cells" style={{ ['--cols' as string]: cols }}>
            {details.choices.map((c, ci) => {
              const desc = details.descriptions[si]?.[ci] ?? '';
              return (
                <label key={ci} className={`rubric-cell${input.choices[si] === ci ? ' picked' : ''}`}>
                  <input
                    type="radio"
                    name={`${idPrefix}-rubric-${si}`}
                    checked={input.choices[si] === ci}
                    disabled={disabled}
                    onChange={() => onChange({ ...input, choices: input.choices.map((x, j) => (j === si ? ci : x)) })}
                  />
                  <span className="rubric-choice">{c}</span>
                  {desc ? <span className="rubric-desc">{desc}</span> : null}
                </label>
              );
            })}
          </div>
          {input.choices[si] !== undefined && input.choices[si] !== RUBRIC_UNANSWERED ? (
            <button
              type="button"
              className="link-button"
              disabled={disabled}
              onClick={() => onChange({ ...input, choices: input.choices.map((x, j) => (j === si ? RUBRIC_UNANSWERED : x)) })}
            >
              Clear row {alphabeticalIndex(si + 1)}
            </button>
          ) : null}
        </fieldset>
      ))}
    </div>
  );
}
