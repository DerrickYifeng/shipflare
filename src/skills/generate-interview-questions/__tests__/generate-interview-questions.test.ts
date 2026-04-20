import { describe, it, expect } from 'vitest';
import { interviewQuestionsOutputSchema } from '@/agents/schemas';

const tenQuestions = Array.from(
  { length: 10 },
  (_, i) => `Question ${i + 1}: walk me through the last time you did X.`,
);

describe('interviewQuestionsOutputSchema', () => {
  it('accepts a valid 10-question discovery script', () => {
    const valid = {
      intent: 'discovery',
      questions: tenQuestions,
      followUpPrompts: [
        'Can you tell me about the last time that happened?',
        'What did you do about it that week?',
      ],
    };
    expect(() => interviewQuestionsOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects 9 questions', () => {
    const invalid = {
      intent: 'activation',
      questions: tenQuestions.slice(0, 9),
      followUpPrompts: [],
    };
    expect(() => interviewQuestionsOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects 11 questions', () => {
    const invalid = {
      intent: 'retention',
      questions: [...tenQuestions, 'extra'],
      followUpPrompts: [],
    };
    expect(() => interviewQuestionsOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects an unknown intent', () => {
    const invalid = {
      intent: 'acquisition',
      questions: tenQuestions,
      followUpPrompts: [],
    };
    expect(() => interviewQuestionsOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects more than 10 follow-ups', () => {
    const invalid = {
      intent: 'discovery',
      questions: tenQuestions,
      followUpPrompts: Array.from({ length: 11 }, (_, i) => `followup ${i}`),
    };
    expect(() => interviewQuestionsOutputSchema.parse(invalid)).toThrow();
  });
});
