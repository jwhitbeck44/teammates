import { useState } from 'react';
import type { GiverType, QuestionType, RecipientType } from '../../../lib/types';
import {
  VISIBILITY_LABELS,
  applicableVisibilityTypes,
  describeVisibility,
  isCellEditable,
  isCellOn,
  matchPreset,
  presetLists,
  presetsFor,
  setVisibility,
  type VisibilityControl,
  type VisibilityLists,
} from '../../../lib/visibility';

const CONTROLS: { id: VisibilityControl; label: string }[] = [
  { id: 'response', label: 'Can see the response' },
  { id: 'giver_name', label: "Can see the giver's name" },
  { id: 'recipient_name', label: "Can see the recipient's name" },
];

export function VisibilityEditor({
  type,
  giver,
  recipient,
  lists,
  responseCount = 0,
  onChange,
}: {
  type: QuestionType;
  giver: GiverType;
  recipient: RecipientType;
  lists: VisibilityLists;
  responseCount?: number;
  onChange: (l: VisibilityLists) => void;
}) {
  const presets = presetsFor(type, giver, recipient);
  const current = matchPreset(lists);
  const [custom, setCustom] = useState(current === null || !presets.some((p) => p.id === current.id));
  const showGrid = custom || current === null;
  const rows = applicableVisibilityTypes(giver, recipient);
  const selectValue = showGrid ? 'custom' : (current?.id ?? 'custom');

  return (
    <div>
      {responseCount > 0 && (
        <p className="ins-notice">
          This question already has {responseCount} answer{responseCount === 1 ? '' : 's'}. You can remove people from
          these lists but not add anyone, because students answered on the understanding of who would see their
          answers. Changing the question type, path or details deletes the answers and lifts this limit.
        </p>
      )}
      <label>
        Who can see the responses
        <select
          value={selectValue}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              setCustom(true);
              return;
            }
            const p = presets.find((x) => x.id === e.target.value);
            if (p) {
              setCustom(false);
              onChange(presetLists(p));
            }
          }}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {showGrid && (
        <div className="ins-scroll">
          <table className="ins-grid">
            <thead>
              <tr>
                <th>Who</th>
                {CONTROLS.map((c) => <th key={c.id}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((vt) => (
                <tr key={vt}>
                  <td>{VISIBILITY_LABELS[vt]}</td>
                  {CONTROLS.map((c) => (
                    <td key={c.id}>
                      <input
                        type="checkbox"
                        checked={isCellOn(lists, vt, c.id) || (vt === 'recipient' && c.id === 'recipient_name' && isCellOn(lists, 'recipient', 'response'))}
                        disabled={!isCellEditable(vt, c.id)}
                        aria-label={`${VISIBILITY_LABELS[vt]}: ${c.label}`}
                        onChange={(e) => onChange(setVisibility(lists, vt, c.id, e.target.checked, giver, recipient))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="ins-hint">
        {describeVisibility(lists).map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      {(giver === 'students') && <p className="ins-hint">Instructors with permission to view results always see names. Hiding applies to students.</p>}
    </div>
  );
}
