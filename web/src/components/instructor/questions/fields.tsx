import { useEffect, useState } from 'react';

/** A number input that keeps its own text so the field can be cleared while typing. */
export function NumberField({
  value,
  onChange,
  required,
  label,
  min,
  step,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  /** When required, clearing the field does not call onChange. */
  required?: boolean;
  label: string;
  min?: number;
  step?: number | 'any';
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    const parsed = text.trim() === '' ? undefined : Number(text);
    if (parsed !== value && !(required && text.trim() === '')) setText(value === undefined ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label>
      {label}
      <input
        type="number"
        value={text}
        min={min}
        step={step ?? 'any'}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (t.trim() === '') {
            if (!required) onChange(undefined);
            return;
          }
          const n = Number(t);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

/** Editable list of strings with add, remove and move buttons. */
export function StringListEditor({
  items,
  onChange,
  label,
  addLabel,
  minItems = 0,
  placeholder,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  label: string;
  addLabel: string;
  minItems?: number;
  placeholder?: string;
}) {
  const set = (i: number, v: string) => onChange(items.map((x, j) => (j === i ? v : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="ins-list-edit">
      <strong>{label}</strong>
      {items.map((it, i) => (
        <div key={i}>
          <input type="text" value={it} placeholder={placeholder} aria-label={`${label} ${i + 1}`} onChange={(e) => set(i, e.target.value)} />
          <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">Up</button>
          <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Move down">Down</button>
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={items.length <= minItems} aria-label="Remove">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, ''])}>{addLabel}</button>
    </div>
  );
}
