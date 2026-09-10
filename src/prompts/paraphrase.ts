import type { AIRequest } from '@/services/ai/ai.types.js';

export interface ParaphraseParams {
  text: string;
}

export function buildParaphrasePrompt(params: ParaphraseParams): AIRequest {
  return {
    systemPrompt: `You are an experienced customer support specialist at Hylo.
Generate alternative phrasings of support messages. Each version must preserve the original meaning exactly.
Never use: "Hope you're doing well", "Just checking in", "Kindly", "Please do not hesitate".`,
    messages: [
      {
        role: 'user',
        content: `Generate an alternative version of the following support message. Same meaning, different wording — as if written by a different person with the same goal.

Original message:
"""
${params.text}
"""

Return only the alternative version. No labels, no explanation, no quotes.`,
      },
    ],
    temperature: 0.85,
    maxTokens: 600,
  };
}
