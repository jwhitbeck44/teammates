import { useMemo } from 'react';

const COMMON = [
  'America/Denver',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function allZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (f) return f('timeZone');
  } catch {
    // fall through
  }
  return [];
}

export function TimeZoneSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const zones = useMemo(() => {
    const rest = allZones().filter((z) => !COMMON.includes(z));
    return { rest };
  }, []);
  const known = COMMON.includes(value) || zones.rest.includes(value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{value}</option>}
      <optgroup label="Common">
        {COMMON.map((z) => (
          <option key={z} value={z}>{z}</option>
        ))}
      </optgroup>
      {zones.rest.length > 0 && (
        <optgroup label="All time zones">
          {zones.rest.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
