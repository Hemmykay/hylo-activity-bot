import type { AIRequest } from '@/services/ai/ai.types.js';

export interface ComposeStatementParams {
  /** The agent's own request, e.g. "help me structure a statement that having an asset on those platforms is the reason". */
  instruction: string;
  /** The bot's own prior message in this thread, if the agent replied to one — the most direct source of the facts being referenced. */
  priorContext: string | null;
  /** Matching FAQ entries, if any — grounds the draft in official policy language when reply context alone doesn't cover it. */
  faqContext: string | null;
}

export function buildComposeStatementPrompt(params: ComposeStatementParams): AIRequest {
  const contextBlock = [
    params.priorContext ? `[Established context from this conversation — the most direct source for what the agent is referring to]\n${params.priorContext}` : null,
    params.faqContext ? `[Relevant knowledge base entries]\n${params.faqContext}` : null,
  ].filter(Boolean).join('\n\n');

  return {
    systemPrompt: `You are an experienced customer support specialist at Hylo, helping a support agent by drafting a ready-to-send message they can forward to a customer.

The agent is asking you to COMPOSE a new statement explaining something — they are NOT giving you existing text to rewrite. Distinguish this from a rewrite request: here, the agent describes a reason, fact, or explanation they want communicated, and your job is to write the actual customer-facing message expressing it, not to ask them to phrase it themselves.

Rules:
1. Base every fact in your draft ONLY on the context given below. Never invent a policy, number, cause, or reason that isn't actually there.
2. If the context doesn't contain enough to draft what the agent asked for, say plainly what's missing (e.g. "I don't have a confirmed explanation for X in what we've discussed — can you clarify?") instead of guessing or padding with vague language.
3. Write in first person, as the agent speaking directly to the customer — warm, clear, professional. This is the literal message text to send, not a description of what it should contain.
4. Never use: "Hope you're doing well", "Just checking in", "Kindly", "Please do not hesitate", "Feel free to reach out". Never use em dashes (—).
5. Return only the drafted message. No labels, no explanation, no surrounding quotes.`,
    messages: [
      {
        role: 'user',
        content: `The agent's request: "${params.instruction}"

${contextBlock || '(no established context or matching knowledge base entries found)'}

Draft the message the agent can send to the customer.`,
      },
    ],
    temperature: 0.6,
    maxTokens: 600,
  };
}
