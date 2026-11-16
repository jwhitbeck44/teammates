import { formatInstant } from '../../lib/time';

/** A date and time in the course time zone, for example "Sat, Nov 14, 2026, 11:59 PM MST". */
export default function TimeText({ value, timeZone }: { value: string; timeZone: string }) {
  return <time dateTime={value}>{formatInstant(value, timeZone)}</time>;
}
