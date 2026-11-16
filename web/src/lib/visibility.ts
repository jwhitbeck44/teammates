// Visibility presets, editor state rules and canView() (ARCHITECTURE.md section 7, spec section d).
// canView mirrors the SQL function can_view() for student viewers.

import {
  ANONYMOUS_NAME,
  GiverType,
  QuestionFields,
  QuestionType,
  RecipientType,
  VISIBILITY_TYPES,
  VisibilityType,
} from './types';

export type VisibilityLists = Pick<QuestionFields, 'show_responses_to' | 'show_giver_name_to' | 'show_recipient_name_to'>;

/** The three columns of the visibility grid. */
export type VisibilityControl = 'response' | 'giver_name' | 'recipient_name';

export const VISIBILITY_LABELS: Record<VisibilityType, string> = {
  recipient: 'Recipient',
  giver_team_members: "Giver's team members",
  recipient_team_members: "Recipient's team members",
  students: 'Other students in the course',
  instructors: 'Instructors',
};

// ---------------------------------------------------------------------------
// Presets (section 7)

export interface VisibilityPreset extends VisibilityLists {
  id: 'team_and_instructors' | 'recipient_and_instructors' | 'recipient_named' | 'instructors_only';
  label: string;
}

export const VISIBILITY_PRESETS: readonly VisibilityPreset[] = [
  {
    id: 'team_and_instructors',
    label: "Shown anonymously to recipient and giver's team members, visible to instructors",
    show_responses_to: ['instructors', 'recipient', 'giver_team_members'],
    show_giver_name_to: ['instructors'],
    show_recipient_name_to: ['instructors', 'recipient'],
  },
  {
    id: 'recipient_and_instructors',
    label: 'Shown anonymously to recipient, visible to instructors',
    show_responses_to: ['recipient', 'instructors'],
    show_giver_name_to: ['instructors'],
    show_recipient_name_to: ['recipient', 'instructors'],
  },
  {
    id: 'recipient_named',
    label: 'Visible to recipient and instructors',
    show_responses_to: ['recipient', 'instructors'],
    show_giver_name_to: ['recipient', 'instructors'],
    show_recipient_name_to: ['recipient', 'instructors'],
  },
  {
    id: 'instructors_only',
    label: 'Visible to instructors only',
    show_responses_to: ['instructors'],
    show_giver_name_to: ['instructors'],
    show_recipient_name_to: ['instructors'],
  },
];

export const CUSTOM_PRESET_LABEL = 'Custom';

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The preset whose three lists equal `lists` (order ignored), or null for a custom setting. */
export function matchPreset(lists: VisibilityLists): VisibilityPreset | null {
  return (
    VISIBILITY_PRESETS.find(
      (p) =>
        sameSet(p.show_responses_to, lists.show_responses_to) &&
        sameSet(p.show_giver_name_to, lists.show_giver_name_to) &&
        sameSet(p.show_recipient_name_to, lists.show_recipient_name_to),
    ) ?? null
  );
}

/** Label for a question's visibility: the preset label or "Custom". */
export function visibilityLabel(lists: VisibilityLists): string {
  return matchPreset(lists)?.label ?? CUSTOM_PRESET_LABEL;
}

export function presetLists(p: VisibilityPreset): VisibilityLists {
  return {
    show_responses_to: [...p.show_responses_to],
    show_giver_name_to: [...p.show_giver_name_to],
    show_recipient_name_to: [...p.show_recipient_name_to],
  };
}

/** Default for a new question. Not determined by TEAMMATES code; the private option is the safe choice. */
export function defaultVisibility(): VisibilityLists {
  return presetLists(VISIBILITY_PRESETS[3]);
}

// ---------------------------------------------------------------------------
// Which visibility types make sense for a path (spec section d, "Hidden as redundant")

export function applicableVisibilityTypes(giver: GiverType, recipient: RecipientType): VisibilityType[] {
  const out = new Set<VisibilityType>(VISIBILITY_TYPES);
  if (giver === 'instructors') out.delete('giver_team_members');
  switch (recipient) {
    case 'self':
      out.delete('recipient');
      out.delete('recipient_team_members');
      break;
    case 'own_team':
      out.delete('recipient');
      out.delete('recipient_team_members');
      break;
    case 'instructors':
    case 'teams':
    case 'teams_excluding_self':
    case 'own_team_members':
    case 'own_team_members_including_self':
      out.delete('recipient_team_members');
      break;
    case 'none':
      out.delete('recipient');
      out.delete('recipient_team_members');
      break;
    default:
      break;
  }
  if (giver === 'instructors' && recipient === 'self') out.delete('recipient_team_members');
  return VISIBILITY_TYPES.filter((v) => out.has(v));
}

/** Presets that can be offered for a question type and path (all their entries must apply). */
export function presetsFor(type: QuestionType, giver: GiverType, recipient: RecipientType): VisibilityPreset[] {
  const applicable = new Set(applicableVisibilityTypes(giver, recipient));
  return VISIBILITY_PRESETS.filter((p) => {
    // CONTRIB needs 'recipient' and 'giver_team_members' together (spec section a), so it only
    // offers the presets that satisfy that.
    if (type === 'contrib' && !['team_and_instructors', 'instructors_only'].includes(p.id)) return false;
    return [...p.show_responses_to, ...p.show_giver_name_to, ...p.show_recipient_name_to].every((v) => applicable.has(v));
  });
}

// ---------------------------------------------------------------------------
// Editor state rules (spec section d, visibility-state-machine.ts)

function listKey(c: VisibilityControl): keyof VisibilityLists {
  return c === 'response' ? 'show_responses_to' : c === 'giver_name' ? 'show_giver_name_to' : 'show_recipient_name_to';
}

/** Is this grid cell editable? The recipient's own "recipient name" cell is fixed. */
export function isCellEditable(vt: VisibilityType, c: VisibilityControl): boolean {
  return !(vt === 'recipient' && c === 'recipient_name');
}

export function isCellOn(lists: VisibilityLists, vt: VisibilityType, c: VisibilityControl): boolean {
  return lists[listKey(c)].includes(vt);
}

function without(list: VisibilityType[], vt: VisibilityType): VisibilityType[] {
  return list.filter((x) => x !== vt);
}
function withType(list: VisibilityType[], vt: VisibilityType): VisibilityType[] {
  return list.includes(vt) ? list : VISIBILITY_TYPES.filter((x) => x === vt || list.includes(x));
}

/**
 * Turn one grid cell on or off, applying the editor rules:
 * - granting a name right also grants the response right;
 * - granting the response right to the recipient also grants the recipient name;
 * - removing the response right removes both name rights;
 * - the recipient's own recipient-name cell cannot be edited;
 * - types that are not applicable for the path are ignored.
 * Returns new lists; the input is not modified.
 */
export function setVisibility(
  lists: VisibilityLists,
  vt: VisibilityType,
  control: VisibilityControl,
  on: boolean,
  giver: GiverType,
  recipient: RecipientType,
): VisibilityLists {
  if (!applicableVisibilityTypes(giver, recipient).includes(vt) || !isCellEditable(vt, control)) return lists;
  let r = [...lists.show_responses_to];
  let g = [...lists.show_giver_name_to];
  let n = [...lists.show_recipient_name_to];
  if (on) {
    if (control === 'response') {
      r = withType(r, vt);
      if (vt === 'recipient') n = withType(n, vt);
    } else if (control === 'giver_name') {
      g = withType(g, vt);
      r = withType(r, vt);
    } else {
      n = withType(n, vt);
      r = withType(r, vt);
    }
  } else if (control === 'response') {
    r = without(r, vt);
    g = without(g, vt);
    n = without(n, vt);
  } else if (control === 'giver_name') {
    g = without(g, vt);
  } else {
    n = without(n, vt);
  }
  return { show_responses_to: r, show_giver_name_to: g, show_recipient_name_to: n };
}

/**
 * Make three lists consistent with the editor rules: name lists only contain types that can see
 * the response, and the recipient who sees a response also sees the recipient name. Entries are
 * returned in canonical order without duplicates.
 */
export function normalizeVisibility(lists: VisibilityLists): VisibilityLists {
  const canon = (l: VisibilityType[]) => VISIBILITY_TYPES.filter((v) => l.includes(v));
  const r = canon(lists.show_responses_to);
  const g = canon(lists.show_giver_name_to.filter((v) => r.includes(v)));
  let n = lists.show_recipient_name_to.filter((v) => r.includes(v));
  if (r.includes('recipient') && !n.includes('recipient')) n = [...n, 'recipient'];
  return { show_responses_to: r, show_giver_name_to: g, show_recipient_name_to: canon(n) };
}

/** Plain-English lines describing who sees what, for the editor and instructor previews. */
export function describeVisibility(lists: VisibilityLists): string[] {
  const out: string[] = [];
  for (const vt of VISIBILITY_TYPES) {
    if (!lists.show_responses_to.includes(vt)) continue;
    const shown: string[] = [];
    const hidden: string[] = [];
    (lists.show_giver_name_to.includes(vt) ? shown : hidden).push("the giver's name");
    (lists.show_recipient_name_to.includes(vt) ? shown : hidden).push("the recipient's name");
    const seen = shown.length > 0 ? `, ${shown.join(' and ')}` : '';
    const notSeen = hidden.length > 0 ? `, but not ${hidden.join(' or ')}` : '';
    out.push(`${VISIBILITY_LABELS[vt]} can see the response${seen}${notSeen}.`);
  }
  if (out.length === 0) out.push('Nobody but the giver can see the responses.');
  return out;
}

// ---------------------------------------------------------------------------
// canView (section 7)

export type Viewer =
  | { kind: 'instructor' }
  | { kind: 'student'; student: { id: string; section: string; team: string } };

/** The parts of a response that visibility depends on. Team keys are null for instructors and 'none'. */
export interface ResponseParties {
  giver_key: string;
  recipient_key: string;
  giver_team_key: string | null;
  recipient_team_key: string | null;
}

export interface ViewRights {
  sees_response: boolean;
  sees_giver_name: boolean;
  sees_recipient_name: boolean;
}

const ALL: ViewRights = { sees_response: true, sees_giver_name: true, sees_recipient_name: true };
const NONE: ViewRights = { sees_response: false, sees_giver_name: false, sees_recipient_name: false };

function qualifies(vt: VisibilityType, r: ResponseParties, viewerKey: string, viewerTeamKey: string): boolean {
  switch (vt) {
    case 'recipient':
      return r.recipient_key === viewerKey || r.recipient_key === viewerTeamKey;
    case 'giver_team_members':
      return r.giver_key === viewerKey || r.giver_team_key === viewerTeamKey;
    case 'recipient_team_members':
      return r.recipient_team_key === viewerTeamKey || r.recipient_key === viewerTeamKey;
    case 'students':
      return true;
    case 'instructors':
      return false;
  }
}

/**
 * What a viewer may see of one response. Instructors with view_results see everything (the
 * hiding applies to students only). A giver always sees their own responses with full names.
 */
export function canView(lists: VisibilityLists, response: ResponseParties, viewer: Viewer): ViewRights {
  if (viewer.kind === 'instructor') return { ...ALL };
  const s = viewer.student;
  const viewerKey = `s:${s.id}`;
  const viewerTeamKey = `t:${s.section}|${s.team}`;
  if (response.giver_key === viewerKey) return { ...ALL };
  const any = (list: VisibilityType[]) => list.some((vt) => qualifies(vt, response, viewerKey, viewerTeamKey));
  if (!any(lists.show_responses_to)) return { ...NONE };
  return {
    sees_response: true,
    sees_giver_name: any(lists.show_giver_name_to),
    sees_recipient_name: any(lists.show_recipient_name_to),
  };
}

/** Names to display for a viewer: the real name when allowed, else "Anonymous". */
export function visibleNames(
  rights: ViewRights,
  giverName: string,
  recipientName: string,
): { giver_name: string; recipient_name: string } {
  return {
    giver_name: rights.sees_giver_name ? giverName : ANONYMOUS_NAME,
    recipient_name: rights.sees_recipient_name ? recipientName : ANONYMOUS_NAME,
  };
}
