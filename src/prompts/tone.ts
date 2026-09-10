import type { AIRequest } from '@/services/ai/ai.types.js';

export interface ToneParams {
  text: string;
  direction: 'friendlier' | 'more professional' | 'customer support';
}

export function buildTonePrompt(params: ToneParams): AIRequest {
  let instructions: string;

  if (params.direction === 'friendlier') {
    instructions = `Make this message warmer and more approachable.
It should still be professional — just less stiff and more human.
A customer should feel like they're talking to a real person who genuinely wants to help.`;
  } else if (params.direction === 'customer support') {
    instructions = `Rewrite this as a polished customer support response.
- NEVER use em dashes (—). Replace them with a comma, a period, or split into two sentences.
- Use clear, separate paragraphs — one idea per paragraph with a blank line between each.
- Write warmly and professionally, like an experienced support specialist who genuinely cares.
- If declining or delivering bad news: acknowledge the effort or relationship, explain the reason briefly, and close by leaving the door open for the future.
- Preserve every piece of information from the original — do not add or remove any content.`;
  } else {
    instructions = `Make this message more polished and professional.
Remove any overly casual language. Tighten the phrasing.
It should still be warm and human — just more composed and confident.`;
  }

  // Budget at least as many output tokens as the input needs, capped at 3000.
  // A rewrite shouldn't be shorter than the original, and 600 was cutting off long inputs.
  const estimatedInputTokens = Math.ceil(params.text.length / 4);
  const maxTokens = Math.min(Math.max(estimatedInputTokens + 200, 800), 3000);

  return {
    systemPrompt: `You are an experienced customer support specialist at Hylo.
Adjust the tone of support messages while preserving their meaning exactly.
Never use: "Hope you're doing well", "Just checking in", "Kindly", "Please do not hesitate", "Feel free to reach out".
Never use em dashes (—) under any circumstances.`,
    messages: [
      {
        role: 'user',
        content: `Adjust the tone of the following message. ${instructions}

Keep all the same information — do not add or remove content.

Message:
"""
${params.text}
"""

Return only the adjusted message. No labels, no explanation, no quotes.`,
      },
    ],
    temperature: 0.7,
    maxTokens,
  };
}
