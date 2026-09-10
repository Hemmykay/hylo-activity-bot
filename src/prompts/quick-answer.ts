import type { AIRequest } from '@/services/ai/ai.types.js';

export interface QuickAnswerParams {
  question: string;
  /** Verified facts already resolved from Pyth/on-chain/DB — the model must not alter or invent numbers. */
  facts: string;
}

/**
 * Wraps an already-resolved deterministic answer (price, market cap, protocol
 * health) in a natural, reasoned reply. The facts block is the source of
 * truth — the model's job is phrasing and any arithmetic the question asks
 * for on top of those numbers (e.g. "$102 worth is how many xSOL"), never
 * substituting its own figures for the ones given.
 */
export function buildQuickAnswerPrompt(params: QuickAnswerParams): AIRequest {
  return {
    systemPrompt: `You are Hylo Support Copilot, answering a customer's question about the Hylo DeFi protocol.
You are given verified facts already looked up from live on-chain/price data — treat every number in them as ground truth.
Never change, round differently, or invent a number that isn't in the facts. If the question asks for a calculation using those numbers (e.g. converting a dollar amount to a token quantity), do the arithmetic yourself and show the result plainly.
If the facts don't actually answer what was asked, say so honestly instead of forcing an answer.
Write like a knowledgeable person replying directly, not a template. Discord Markdown, first person, concise — a sentence or two of framing plus the number(s), not a wall of text.
If the facts contain a URL, you MUST include it in your reply, reproduced character-for-character exactly as given — never omit, shorten, retype, or paraphrase a link.
Never use em dashes (—). Never mention "our knowledge base" or that you looked anything up "in a database".`,
    messages: [
      {
        role: 'user',
        content: `Customer asked:\n"""\n${params.question}\n"""\n\nVerified facts:\n"""\n${params.facts}\n"""\n\nReply to the customer using only the facts above.`,
      },
    ],
    temperature: 0.4,
    maxTokens: 500,
  };
}
