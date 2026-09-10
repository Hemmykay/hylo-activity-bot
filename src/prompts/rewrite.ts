import type { AIRequest } from '@/services/ai/ai.types.js';

export interface RewriteParams {
  text: string;
}

export function buildRewritePrompt(params: RewriteParams): AIRequest {
  return {
    systemPrompt: `You are an experienced customer support specialist at Hylo.
Rewrite messages to sound natural, clear, and professional — like a real human support agent, not a bot.
Preserve the original meaning exactly. Do not add or remove information.
Never use: "Hope you're doing well", "Just checking in", "Kindly", "Please do not hesitate", "Feel free to reach out".`,
    messages: [
      {
        role: 'user',
        content: `Rewrite the following support message. Keep the same meaning and all the same information, but make it sound more natural and professional.

Message to rewrite:
"""
${params.text}
"""

Return only the rewritten message. No labels, no explanation, no quotes.`,
      },
    ],
    temperature: 0.75,
    maxTokens: 600,
  };
}
