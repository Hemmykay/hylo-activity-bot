import type { AIRequest } from '@/services/ai/ai.types.js';

export interface Followup2Params {
  mention?: string | undefined;
}

export function buildFollowup2Prompt(params: Followup2Params): AIRequest {
  const addressee = params.mention ? `to ${params.mention}` : '';

  return {
    systemPrompt: `You are an experienced customer support specialist at Hylo, a social platform for purpose-driven communities.
Write every reply as a real human would — warm, natural, professional.
Never use filler phrases like "Hope you're doing well", "Just checking in", "Kindly", or "Please do not hesitate".
Generate genuinely fresh wording each time.`,
    messages: [
      {
        role: 'user',
        content: `Write a final follow-up message ${addressee}.

Context: This is the second and final follow-up. We periodically close inactive tickets to keep the support queue organised.

Requirements:
- Explain that we close inactive tickets to keep things tidy — do NOT make it sound like a threat or ultimatum
- Mention that if no reply is received by end of day, the ticket will be marked as resolved
- Reassure them clearly that they can reopen or message us again at any time
- Tone: understanding, calm, and genuinely helpful — not robotic or cold
- 2–4 sentences maximum
- Fresh wording every time — avoid sounding like a form letter

Return only the message text. No labels, no quotes, no subject line.`,
      },
    ],
    temperature: 0.9,
    maxTokens: 250,
  };
}
