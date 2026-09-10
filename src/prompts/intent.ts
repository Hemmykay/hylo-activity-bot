import type { AIRequest } from '@/services/ai/ai.types.js';

export type DMIntent =
  | 'faq_create'
  | 'faq_edit'
  | 'faq_delete'
  | 'faq_search'
  | 'customer_question'
  | 'kb_discuss'    // detected deterministically in router — never returned by LLM
  | 'rewrite'
  | 'explain_protocol'
  | 'calculation'
  | 'improve_wording'
  | 'general';

export interface IntentResult {
  intent: DMIntent;
  confidence: number; // 0–1
  reasoning: string;
}

export function buildIntentPrompt(userMessage: string): AIRequest {
  return {
    systemPrompt: `You are an intent classifier for an internal AI support assistant used by the Hylo customer support team.
Your job is to classify what the support agent is trying to do based on their message.
Always respond with valid JSON only — no markdown, no explanation outside the JSON.`,
    messages: [
      {
        role: 'user',
        content: `Classify the intent of this message from a Hylo support agent.

Message:
"""
${userMessage}
"""

Possible intents:
- faq_create: The agent is teaching the bot a new FAQ entry (provides a Q&A pair)
- faq_edit: The agent wants to update an existing FAQ
- faq_delete: The agent wants to remove an FAQ
- faq_search: The agent is searching for a specific FAQ
- customer_question: The agent has pasted a customer's question and wants a suggested reply. Also applies when the agent asks a short question to test the bot's knowledge.
- rewrite: The agent wants a message rewritten or paraphrased
- explain_protocol: The agent is asking about Hylo's product behaviour or processes
- calculation: The agent needs a numerical calculation or ratio worked out
- improve_wording: The agent wants phrasing suggestions or tone adjustments
- general: Doesn't fit any of the above

Respond with JSON in exactly this format:
{
  "intent": "<one of the intent names above>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one sentence explaining your classification>"
}`,
      },
    ],
    temperature: 0.1,
    maxTokens: 200,
  };
}
