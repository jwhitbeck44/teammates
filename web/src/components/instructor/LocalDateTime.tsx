import { useState } from 'react';
import { instantToLocalInputs, localToInstant } from '../../lib/time';

/**
 * Date and time inputs read in a given time zone. `value` is an ISO instant (or null);
 * `onChange` receives the ISO instant, or null while either field is empty or invalid.
 * Remount (change `key`) to load a different value.
 */
export function LocalDateTime({
  value,
  timeZone,
  onChange,
  label,
}: {
  value: string | null;
  timeZone: string;
  onChange: (iso: string | null) => void;
  label?: string;
}) {
  const initial = value ? instantToLocalInputs(value, timeZone) : { date: '', time: '' };
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);

  function emit(d: string, t: string) {
    const inst = d && t ? localToInstant(d, t, timeZone) : null;
    onChange(inst ? inst.toISOString() : null);
  }

  return (
    <span className="ins-inline">
      {label && <span>{label} </span>}
      <input
        type="date"
        value={date}
        aria-label={label ? `${label} date` : 'Date'}
        onChange={(e) => {
          setDate(e.target.value);
          emit(e.target.value, time);
        }}
      />{' '}
      <input
        type="time"
        value={time}
        aria-label={label ? `${label} time` : 'Time'}
        onChange={(e) => {
          setTime(e.target.value);
          emit(date, e.target.value);
        }}
      />
    </span>
  );
}
