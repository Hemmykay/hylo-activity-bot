import type { AIRequest } from '@/services/ai/ai.types.js';

export interface FAQImprovementResult {
  action: 'update_existing' | 'create_new' | 'no_change_needed';
  matchedFAQId?: string;
  matchedFAQTitle?: string;
  reasoning: string;
  proposedTitle: string;
  proposedCategory: string;
  proposedTags: string[];
  proposedQuestion: string;
  proposedAnswer: string;
}

export interface FAQSmartMergeResult {
  proposedTitle: string;
  proposedAnswer: string;
  changesSummary: string;
}

export interface FAQSmartMergeParams {
  existingFAQ: { title: string; question: string; answer: string };
  originalCustomerQuestion: string;
  wrongBotReply: string;
  agentCorrection: string;
}

export function buildFAQSmartMergePrompt(params: FAQSmartMergeParams): AIRequest {
  const { existingFAQ, originalCustomerQuestion, wrongBotReply, agentCorrection } = params;

  return {
    systemPrompt: `You are a knowledge base editor for Hylo. Your job is to intelligently merge a correction into an existing FAQ entry.
Do NOT replace the existing answer wholesale. Instead: remove what is factually wrong, add what is newly correct, and preserve everything that is still accurate.
Always respond with valid JSON only — no markdown, no text outside the JSON.`,
    messages: [
      {
        role: 'user',
        content: `An agent has submitted a correction to an existing FAQ. Merge it intelligently.

EXISTING FAQ:
Title: ${existingFAQ.title}
Question: ${existingFAQ.question}
Current Answer:
"""
${existingFAQ.answer}
"""

WHAT THE BOT GOT WRONG (the reply that prompted this correction):
"""
${wrongBotReply.slice(0, 500)}
"""

ORIGINAL CUSTOMER QUESTION:
"""
${originalCustomerQuestion}
"""

AGENT'S CORRECTION (what should be true instead):
"""
${agentCorrection}
"""

Instructions:
- Keep all parts of the current answer that are still correct
- Remove or rewrite parts that contradict the agent's correction
- Incorporate the agent's correction naturally into the answer
- Do NOT add a preamble like "Updated to reflect..." — just write the answer
- Preserve the existing formatting style and tone
- Keep the title unless the correction changes the scope significantly

Respond with JSON in exactly this format:
{
  "proposedTitle": "<updated or unchanged title>",
  "proposedAnswer": "<the merged, complete answer>",
  "changesSummary": "<one sentence describing what was added, removed, or changed>"
}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 1000,
  };
}

export interface FAQAuditResult {
  consolidations: Array<{
    primaryId: string;
    primaryTitle: string;
    duplicateId: string;
    duplicateTitle: string;
    reason: string;
    mergedTitle: string;
    mergedAnswer: string;
  }>;
  improvements: Array<{
    faqId: string;
    faqTitle: string;
    issue: string;
    suggestion: string;
  }>;
  summary: string;
}

export interface FAQImprovementParams {
  originalQuestion: string;
  wrongBotAnswer: string;
  userCorrection: string;
  existingFAQs: Array<{
    id: string;
    title: string;
    category: string;
    question: string;
    answer: string;
  }>;
}

export interface FAQAuditParams {
  faqs: Array<{
    id: string;
    title: string;
    category: string;
    question: string;
    answer: string;
  }>;
}

export function buildFAQImprovementPrompt(params: FAQImprovementParams): AIRequest {
  const { originalQuestion, wrongBotAnswer, userCorrection, existingFAQs } = params;

  const faqContext =
    existingFAQs.length > 0
      ? existingFAQs
          .map(
            (f) =>
              `--- ID: ${f.id.slice(-6)} | ${f.category}\nTitle: ${f.title}\nQ: ${f.question}\nA: ${f.answer.slice(0, 300)}${f.answer.length > 300 ? '...' : ''}`,
          )
          .join('\n\n')
      : '(No existing FAQs)';

  return {
    systemPrompt: `You are a knowledge base curator for Hylo, a DeFi yield optimizer on Solana.
A support bot gave a wrong answer. Analyze the correction and determine whether to update an existing FAQ or create a new one.
Always respond with valid JSON only — no markdown, no explanation outside the JSON.`,
    messages: [
      {
        role: 'user',
        content: `A correction was submitted. Analyze whether it should update an existing FAQ or become a new entry.

ORIGINAL QUESTION (what the customer asked):
"""
${originalQuestion}
"""

WRONG BOT ANSWER (what the bot incorrectly said):
"""
${wrongBotAnswer.slice(0, 600)}
"""

USER'S CORRECTION (the correct information):
"""
${userCorrection}
"""

EXISTING FAQs:
${faqContext}

Rules:
- If the correction directly relates to a topic covered by an existing FAQ → action: "update_existing", include its 6-char ID in matchedFAQId
- If it's a genuinely new topic → action: "create_new"
- If the correction is too vague to act on → action: "no_change_needed"
- proposedAnswer must incorporate the correction clearly and completely
- Keep proposedAnswer factual and under 400 words

Respond with JSON in exactly this format:
{
  "action": "update_existing" | "create_new" | "no_change_needed",
  "matchedFAQId": "<last 6 chars of FAQ id — only when action is update_existing>",
  "matchedFAQTitle": "<matched FAQ title — only when action is update_existing>",
  "reasoning": "<one sentence>",
  "proposedTitle": "<concise FAQ title>",
  "proposedCategory": "<one of: Getting Started, Tokens & Payments, hyUSD & Minting, General>",
  "proposedTags": ["tag1", "tag2"],
  "proposedQuestion": "<the question this FAQ answers>",
  "proposedAnswer": "<the corrected, complete answer>"
}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 1200,
  };
}

export function buildFAQAuditPrompt(params: FAQAuditParams): AIRequest {
  const faqContext = params.faqs
    .map(
      (f) =>
        `--- ID: ${f.id.slice(-6)} | ${f.category}\nTitle: ${f.title}\nQ: ${f.question}\nA: ${f.answer.slice(0, 400)}${f.answer.length > 400 ? '...' : ''}`,
    )
    .join('\n\n');

  return {
    systemPrompt: `You are a knowledge base auditor for Hylo. Analyze FAQs for overlap, redundancy, and quality issues.
Always respond with valid JSON only — no markdown, no explanation outside the JSON.`,
    messages: [
      {
        role: 'user',
        content: `Audit these FAQs for consolidation opportunities and quality improvements.

FAQs:
${faqContext}

Look for:
1. Pairs that cover the same topic and should be merged into one comprehensive entry
2. FAQs that are incomplete, vague, or could be significantly improved
3. Category mismatches

For consolidations, propose what the merged entry would look like.
Only flag genuine issues — not every FAQ needs action.

Respond with JSON in exactly this format:
{
  "consolidations": [
    {
      "primaryId": "<6-char ID to keep>",
      "primaryTitle": "<title of primary>",
      "duplicateId": "<6-char ID to fold in>",
      "duplicateTitle": "<title of duplicate>",
      "reason": "<why these should merge>",
      "mergedTitle": "<proposed merged title>",
      "mergedAnswer": "<the merged, comprehensive answer>"
    }
  ],
  "improvements": [
    {
      "faqId": "<6-char ID>",
      "faqTitle": "<title>",
      "issue": "<what's wrong>",
      "suggestion": "<what to change>"
    }
  ],
  "summary": "<one paragraph summary of the audit findings>"
}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 2000,
  };
}
