import type { AIRequest } from '@/services/ai/ai.types.js';

export interface Followup1Params {
  mention?: string | undefined;
}

export function buildFollowup1Prompt(params: Followup1Params): AIRequest {
  const addressee = params.mention ? `to ${params.mention}` : '';

  return {
    systemPrompt: `You are an experienced customer support specialist at Hylo, a social platform for purpose-driven communities.
Write every reply as a real human would — warm, natural, professional.
Never use filler phrases like "Hope you're doing well", "Just checking in", "Kindly", "Please do not hesitate", or "Feel free".
Generate genuinely fresh wording each time. No two follow-ups should read alike.`,
    messages: [
      {
        role: 'user',
        content: `Write a first follow-up message ${addressee}.

Purpose: check whether the customer still needs help, and encourage them to reply if they do.

Requirements:
- Friendly and warm, but not over-the-top
- Professional without being stiff
- 2–3 sentences maximum
- Ends with a gentle prompt to respond
- Natural, conversational tone — not template-sounding
- Different wording from any previous follow-up you have written

Return only the message text. No labels, no quotes, no subject line.`,
      },
    ],
    temperature: 0.9,
    maxTokens: 200,
  };
}
