import type { AIRequest } from '@/services/ai/ai.types.js';
import type { FAQ } from '@prisma/client';

// ─── FAQ Creation ─────────────────────────────────────────────────────────────

export interface FAQDraft {
  title: string;
  category: string;
  tags: string[];
  keywords: string[];
  question: string;
  answer: string;
}

export function buildFAQExtractPrompt(rawInput: string, questionContext?: string): AIRequest {
  const contextBlock = questionContext
    ? `\nThis correction is in reply to a previous bot response about this customer question:\n"""\n${questionContext}\n"""\nUse this as the question for the FAQ if the correction text does not explicitly state one.\n`
    : '';

  return {
    systemPrompt: `You are a knowledge base manager for Hylo, a social platform for purpose-driven communities.
Extract structured FAQ entries from support agent notes.
Always respond with valid JSON only — no markdown, no explanation outside the JSON.`,
    messages: [
      {
        role: 'user',
        content: `A Hylo support agent has provided the following content to be saved as an FAQ:
${contextBlock}
"""
${rawInput}
"""

Extract and structure this as an FAQ entry. Respond with JSON in exactly this format:
{
  "title": "<short descriptive title, max 60 chars>",
  "category": "<one of: Getting Started, Account & Profile, Communities, Tokens & Payments, hyUSD & Minting, Collateral & Liquidation, Technical Issues, Other>",
  "tags": ["<tag1>", "<tag2>"],
  "keywords": ["<keyword1>", "<keyword2>", "<keyword3>"],
  "question": "<the question, written clearly as a customer might ask it>",
  "answer": "<the answer in Markdown — use bullet points, bold, and links where appropriate>"
}

Guidelines:
- title: concise, describes the specific issue
- category: pick the most specific category that fits
- tags: 2–5 short labels useful for filtering (e.g. "minting", "fees", "collateral")
- keywords: 3–8 terms a FTS search should match on
- question: how a customer would actually phrase this
- answer: complete, accurate, formatted in Markdown`,
      },
    ],
    temperature: 0.2,
    maxTokens: 1000,
  };
}

// ─── FAQ Search Display ───────────────────────────────────────────────────────

export function buildFAQListPrompt(faqs: Pick<FAQ, 'title' | 'category' | 'id'>[]): AIRequest {
  const formatted = faqs
    .map((f, i) => `${i + 1}. [${f.category}] ${f.title} (id: ${f.id})`)
    .join('\n');

  return {
    systemPrompt: `You are a support assistant. Present FAQ lists clearly and helpfully.`,
    messages: [
      {
        role: 'user',
        content: `Format this list of FAQs for a support agent:

${formatted}

Present it as a clean, readable list grouped by category. Use Discord markdown formatting.`,
      },
    ],
    temperature: 0.3,
    maxTokens: 800,
  };
}
