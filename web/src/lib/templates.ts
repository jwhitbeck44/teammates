// Session templates copied from TEAMMATES web/data/template-sessions.ts (GPL-2.0), spec section e.
// Question text, types, paths and visibility are exactly as in TEAMMATES. The long
// `questionText` field of TEAMMATES' CONSTSUM_RECIPIENTS and CONTRIB details has no place in this
// app's question shape (the brief carries the text), so it is not stored.

import { QuestionDraft, QuestionDraftOf, VisibilityType } from './types';

export type TemplateId = 'point_based' | 'percentage_based' | 'empty';

export interface SessionTemplate {
  id: TemplateId;
  /** Label for the template picker. */
  label: string;
  /** TEAMMATES' session name for the template, a reasonable default for the name field. */
  sessionName: string;
  questions: QuestionDraft[];
}

const I: VisibilityType = 'instructors';
const R: VisibilityType = 'recipient';
const GTM: VisibilityType = 'giver_team_members';

const COMMON = { giver_type: 'students', max_recipients: null, description: '' } as const;

function textQuestion(
  number: number,
  brief: string,
  recipient: 'self' | 'own_team_members' | 'own_team',
  responses: VisibilityType[],
  giverName: VisibilityType[],
  recipientName: VisibilityType[],
): QuestionDraftOf<'text'> {
  return {
    ...COMMON,
    number,
    type: 'text',
    brief,
    details: {},
    recipient_type: recipient,
    show_responses_to: responses,
    show_giver_name_to: giverName,
    show_recipient_name_to: recipientName,
  };
}

const WORK_BRIEF =
  'How much work did each team member contribute? (response will be shown anonymously to each team member). ';

/** Questions 2 to 5, identical in both templates. A new array of new objects on every call. */
function sharedTextQuestions(): QuestionDraft[] {
  return [
    textQuestion(2, 'What contributions did you make to the team? (response will be shown to each team member).', 'self', [R, GTM, I], [R, GTM, I], [R, GTM, I]),
    textQuestion(
      3,
      'What comments do you have regarding each of your team members? (response is confidential and will only be shown to the instructor).',
      'own_team_members',
      [I],
      [I],
      [I],
    ),
    textQuestion(
      4,
      'How are the team dynamics thus far? (response is confidential and will only be to the instructor).',
      'own_team',
      [I],
      [I],
      [I],
    ),
    textQuestion(
      5,
      'What feedback do you have for each of your team members? (response will be shown anonymously to each team member).',
      'own_team_members',
      [R, I],
      [I],
      [R, I],
    ),
  ];
}

function pointBasedQuestions(): QuestionDraft[] {
  const q1: QuestionDraftOf<'constsum_recipients'> = {
    ...COMMON,
    number: 1,
    type: 'constsum_recipients',
    brief: WORK_BRIEF,
    description:
      'If a team member did an equal share of the work, give 100 points. If a team member did about 10% more than an equal share of the work, give 110 points, and so on.',
    details: { points: 100, pointsPerOption: true, distribute: 'none' },
    recipient_type: 'own_team_members_including_self',
    show_responses_to: [I, R, GTM],
    show_giver_name_to: [I],
    show_recipient_name_to: [I, R],
  };
  return [q1, ...sharedTextQuestions()];
}

function percentageBasedQuestions(): QuestionDraft[] {
  const q1: QuestionDraftOf<'contrib'> = {
    ...COMMON,
    number: 1,
    type: 'contrib',
    brief: WORK_BRIEF,
    description: '',
    details: { isZeroSum: true, isNotSureAllowed: false },
    recipient_type: 'own_team_members_including_self',
    show_responses_to: [I, R, GTM],
    show_giver_name_to: [I],
    show_recipient_name_to: [I, R],
  };
  return [q1, ...sharedTextQuestions()];
}

const BUILDERS: Record<TemplateId, () => QuestionDraft[]> = {
  point_based: pointBasedQuestions,
  percentage_based: percentageBasedQuestions,
  empty: () => [],
};

const META: { id: TemplateId; label: string; sessionName: string }[] = [
  { id: 'point_based', label: 'Team peer feedback (point-based)', sessionName: 'session using template: team peer feedback (point-based)' },
  { id: 'percentage_based', label: 'Team peer feedback (percentage-based)', sessionName: 'session using template: team peer feedback (percentage-based)' },
  { id: 'empty', label: 'Session with my own questions', sessionName: 'Untitled session' },
];

export const TEMPLATE_IDS: readonly TemplateId[] = META.map((m) => m.id);

/** One template, with fresh question objects that the caller may modify. */
export function getTemplate(id: TemplateId): SessionTemplate {
  const meta = META.find((m) => m.id === id);
  if (!meta) throw new Error(`unknown template ${String(id)}`);
  return { ...meta, questions: BUILDERS[id]() };
}

/** All templates in picker order. */
export function listTemplates(): SessionTemplate[] {
  return META.map((m) => getTemplate(m.id));
}
