import type { TextDetails } from '../../lib/types';
import type { InputOf, InputProps } from './props';

export default function TextInput({ idPrefix, labelId, details, input, onChange, disabled }: InputProps<InputOf<'text'>, TextDetails>) {
  const rec = details.recommendedLength;
  const words = input.text.trim() === '' ? 0 : input.text.trim().split(/\s+/).length;
  return (
    <div>
      <textarea
        id={`${idPrefix}-text`}
        aria-labelledby={labelId}
        aria-describedby={rec ? `${idPrefix}-hint` : undefined}
        rows={4}
        value={input.text}
        disabled={disabled}
        onChange={(e) => onChange({ ...input, text: e.target.value })}
      />
      {rec ? (
        <p id={`${idPrefix}-hint`} className="hint">
          About {rec} words. You have {words}.
        </p>
      ) : null}
    </div>
  );
}
