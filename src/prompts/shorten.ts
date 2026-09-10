import type { AIRequest } from '@/services/ai/ai.types.js';

export interface ShortenParams {
  text: string;
}

export function buildShortenPrompt(params: ShortenParams): AIRequest {
  return {
    systemPrompt: `You are an experienced customer support specialist at Hylo.
Edit support messages to be concise. Remove redundancy and filler — keep every word that carries meaning.
Never sacrifice clarity or warmth for brevity.`,
    messages: [
      {
        role: 'user',
        content: `Shorten the following support message. Remove unnecessary words, filler phrases, and redundant sentences. Keep all the important information and maintain the original tone.

Message:
"""
${params.text}
"""

Return only the shortened message. No labels, no explanation, no quotes.`,
      },
    ],
    temperature: 0.5,
    maxTokens: 500,
  };
}
