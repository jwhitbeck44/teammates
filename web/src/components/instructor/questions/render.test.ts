import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import QuestionEditor from './QuestionEditor';
import { defaultDraft } from './draft';
import { QUESTION_TYPES } from '../../../lib/types';

describe('QuestionEditor', () => {
  it('renders for every question type', () => {
    for (const t of QUESTION_TYPES) {
      const html = renderToString(
        createElement(QuestionEditor, {
          initial: { ...defaultDraft(t, 1), brief: 'Question text' },
          isNew: true,
          busy: false,
          error: null,
          onSave: () => {},
          onCancel: () => {},
        }),
      );
      expect(html, t).toContain('Question text');
      expect(html, t).toContain('Visibility');
    }
  });
});
