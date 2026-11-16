import type {
  ConstsumOptionsDetails,
  ConstsumRecipientsDetails,
  ContribDetails,
  DistributeMode,
  McqDetails,
  MsqDetails,
  NumscaleDetails,
  QuestionDraft,
  RankOptionsDetails,
  RankRecipientsDetails,
  RubricDetails,
  TextDetails,
} from '../../../lib/types';
import { NumberField, StringListEditor } from './fields';

const DISTRIBUTE_LABELS: Record<DistributeMode, string> = {
  none: 'No requirement',
  some: 'At least two different values',
  all: 'Every value different',
};

function TextEditor({ d, set }: { d: TextDetails; set: (d: TextDetails) => void }) {
  return (
    <div className="ins-row">
      <NumberField label="Recommended length (characters, optional)" value={d.recommendedLength} min={1} step={1} onChange={(v) => set(v === undefined ? {} : { recommendedLength: v })} />
      <span className="ins-hint">Shown to the student as a guide; not enforced. Changing it keeps existing responses.</span>
    </div>
  );
}

function ChoiceEditor({ d, set, multi }: { d: McqDetails | MsqDetails; set: (d: McqDetails | MsqDetails) => void; multi: boolean }) {
  const m = d as MsqDetails;
  return (
    <div>
      <StringListEditor label="Choices" addLabel="Add choice" items={d.choices} minItems={2} onChange={(choices) => set({ ...d, choices })} />
      <label className="ins-inline">
        <input type="checkbox" checked={d.otherEnabled} onChange={(e) => set({ ...d, otherEnabled: e.target.checked })} /> Allow an "Other" answer
      </label>
      {multi && (
        <div className="ins-row">
          <NumberField label="Minimum choices (optional)" value={m.minSelectable} min={1} step={1} onChange={(v) => set({ ...omit(m, 'minSelectable'), ...(v === undefined ? {} : { minSelectable: v }) })} />
          <NumberField label="Maximum choices (optional)" value={m.maxSelectable} min={1} step={1} onChange={(v) => set({ ...omit(m, 'maxSelectable'), ...(v === undefined ? {} : { maxSelectable: v }) })} />
        </div>
      )}
    </div>
  );
}

function omit<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const { [k]: _x, ...rest } = o;
  void _x;
  return rest;
}

function NumscaleEditor({ d, set }: { d: NumscaleDetails; set: (d: NumscaleDetails) => void }) {
  return (
    <div className="ins-row">
      <NumberField label="Minimum" value={d.min} required onChange={(v) => set({ ...d, min: v ?? d.min })} />
      <NumberField label="Maximum" value={d.max} required onChange={(v) => set({ ...d, max: v ?? d.max })} />
      <NumberField label="Step" value={d.step} required onChange={(v) => set({ ...d, step: v ?? d.step })} />
    </div>
  );
}

function PointsFields({
  d,
  set,
  perWhat,
}: {
  d: ConstsumOptionsDetails | ConstsumRecipientsDetails;
  set: (d: ConstsumOptionsDetails | ConstsumRecipientsDetails) => void;
  perWhat: string;
}) {
  return (
    <>
      <div className="ins-row">
        <NumberField label="Points" value={d.points} min={1} step={1} required onChange={(v) => set({ ...d, points: v ?? d.points })} />
        <label>
          Distribution
          <select value={d.distribute} onChange={(e) => set({ ...d, distribute: e.target.value as DistributeMode })}>
            {(Object.keys(DISTRIBUTE_LABELS) as DistributeMode[]).map((k) => (
              <option key={k} value={k}>{DISTRIBUTE_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <NumberField label="Minimum per item (optional)" value={d.minPoint} min={0} step={1} onChange={(v) => set({ ...omit(d, 'minPoint'), ...(v === undefined ? {} : { minPoint: v }) })} />
        <NumberField label="Maximum per item (optional)" value={d.maxPoint} min={0} step={1} onChange={(v) => set({ ...omit(d, 'maxPoint'), ...(v === undefined ? {} : { maxPoint: v }) })} />
      </div>
      <label className="ins-inline">
        <input type="checkbox" checked={d.pointsPerOption} onChange={(e) => set({ ...d, pointsPerOption: e.target.checked })} /> Points are per {perWhat}
        <span className="ins-hint"> (the total is the points times the number of {perWhat}s)</span>
      </label>
    </>
  );
}

function ConstsumOptionsEditor({ d, set }: { d: ConstsumOptionsDetails; set: (d: ConstsumOptionsDetails) => void }) {
  return (
    <div>
      <StringListEditor label="Options" addLabel="Add option" items={d.options} minItems={2} onChange={(options) => set({ ...d, options })} />
      <PointsFields d={d} perWhat="option" set={(x) => set(x as ConstsumOptionsDetails)} />
    </div>
  );
}

function ConstsumRecipientsEditor({ d, set }: { d: ConstsumRecipientsDetails; set: (d: ConstsumRecipientsDetails) => void }) {
  return <PointsFields d={d} perWhat="recipient" set={(x) => set(x as ConstsumRecipientsDetails)} />;
}

function ContribEditor({ d, set }: { d: ContribDetails; set: (d: ContribDetails) => void }) {
  return (
    <div>
      <label className="ins-inline">
        <input type="checkbox" checked={d.isZeroSum} onChange={(e) => set({ isZeroSum: e.target.checked, isNotSureAllowed: e.target.checked ? false : d.isNotSureAllowed })} /> Answers must add up to an equal share for the whole team (zero-sum)
      </label>
      <label className="ins-inline">
        <input type="checkbox" checked={d.isNotSureAllowed} onChange={(e) => set({ isNotSureAllowed: e.target.checked, isZeroSum: e.target.checked ? false : d.isZeroSum })} /> Allow "Not sure"
      </label>
      <p className="ins-hint">Zero-sum and "Not sure" cannot both be on. Students answer 0% to 200% of an equal share in steps of 5.</p>
    </div>
  );
}

function RubricEditor({ d, set }: { d: RubricDetails; set: (d: RubricDetails) => void }) {
  // Keep the description grid the size of subQuestions x choices.
  const grid = (subs: string[], choices: string[], old: string[][]): string[][] =>
    subs.map((_, r) => choices.map((_c, c) => old[r]?.[c] ?? ''));
  const setChoices = (choices: string[]) => set({ ...d, choices, descriptions: grid(d.subQuestions, choices, d.descriptions) });
  const setSubs = (subQuestions: string[]) => set({ ...d, subQuestions, descriptions: grid(subQuestions, d.choices, d.descriptions) });
  const setCell = (r: number, c: number, v: string) =>
    set({ ...d, descriptions: d.descriptions.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) });
  return (
    <div>
      <StringListEditor label="Choices (columns)" addLabel="Add choice" items={d.choices} minItems={2} onChange={setChoices} />
      <StringListEditor label="Sub-questions (rows)" addLabel="Add sub-question" items={d.subQuestions} minItems={1} onChange={setSubs} />
      <div className="ins-scroll">
        <table className="ins-grid">
          <thead>
            <tr>
              <th>Description for each cell (optional)</th>
              {d.choices.map((c, i) => <th key={i}>{c || `Choice ${i + 1}`}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.subQuestions.map((s, r) => (
              <tr key={r}>
                <td>{s || `Sub-question ${r + 1}`}</td>
                {d.choices.map((_c, c) => (
                  <td key={c}>
                    <input type="text" value={d.descriptions[r]?.[c] ?? ''} aria-label={`Description row ${r + 1} column ${c + 1}`} onChange={(e) => setCell(r, c, e.target.value)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RankFields({
  d,
  set,
}: {
  d: RankOptionsDetails | RankRecipientsDetails;
  set: (d: RankOptionsDetails | RankRecipientsDetails) => void;
}) {
  return (
    <div className="ins-row">
      <NumberField label="Minimum to rank (optional)" value={d.minToRank} min={1} step={1} onChange={(v) => set({ ...omit(d, 'minToRank'), ...(v === undefined ? {} : { minToRank: v }) })} />
      <NumberField label="Maximum to rank (optional)" value={d.maxToRank} min={1} step={1} onChange={(v) => set({ ...omit(d, 'maxToRank'), ...(v === undefined ? {} : { maxToRank: v }) })} />
      <label className="ins-inline">
        <input type="checkbox" checked={d.duplicatesAllowed} onChange={(e) => set({ ...d, duplicatesAllowed: e.target.checked })} /> Allow the same rank more than once
      </label>
    </div>
  );
}

/** One small editor per question type. Edits `draft.details`. */
export function DetailsEditor({ draft, onChange }: { draft: QuestionDraft; onChange: (d: QuestionDraft) => void }) {
  switch (draft.type) {
    case 'text':
      return <TextEditor d={draft.details} set={(details) => onChange({ ...draft, details })} />;
    case 'mcq':
      return <ChoiceEditor multi={false} d={draft.details} set={(details) => onChange({ ...draft, details: details as McqDetails })} />;
    case 'msq':
      return <ChoiceEditor multi d={draft.details} set={(details) => onChange({ ...draft, details: details as MsqDetails })} />;
    case 'numscale':
      return <NumscaleEditor d={draft.details} set={(details) => onChange({ ...draft, details })} />;
    case 'constsum_options':
      return <ConstsumOptionsEditor d={draft.details} set={(details) => onChange({ ...draft, details })} />;
    case 'constsum_recipients':
      return <ConstsumRecipientsEditor d={draft.details} set={(details) => onChange({ ...draft, details })} />;
    case 'contrib':
      return <ContribEditor d={draft.details} set={(details) => onChange({ ...draft, details })} />;
    case 'rubric':
      return <RubricEditor d={draft.details} set={(details) => onChange({ ...draft, details })} />;
    case 'rank_options':
      return (
        <div>
          <StringListEditor label="Options" addLabel="Add option" items={draft.details.options} minItems={2} onChange={(options) => onChange({ ...draft, details: { ...draft.details, options } })} />
          <RankFields d={draft.details} set={(details) => onChange({ ...draft, details: details as RankOptionsDetails })} />
        </div>
      );
    case 'rank_recipients':
      return <RankFields d={draft.details} set={(details) => onChange({ ...draft, details: details as RankRecipientsDetails })} />;
  }
}
