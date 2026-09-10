import type { AIRequest } from '@/services/ai/ai.types.js';
import type { FAQ } from '@prisma/client';
import type { VenueAsset } from '@/db/repositories/venue-asset-xp.repository.js';

// ─── Customer Question Answering (RAG) ───────────────────────────────────────

export interface VenueContext {
  name: string;
  description?: string | null;
  context?: string | null;
  link?: string | null;
  disclaimer?: string | null;
  assets: VenueAsset[];
}

export interface AssetContext {
  symbol: string;
  name: string;
  description?: string | null;
  considerations?: string | null;
}

export interface ComputedXP {
  venue: string;
  asset: string;
  /** Dollar amount — either stated directly, or derived from a stated token quantity via live price. */
  amount: number;
  ratePerDollar: number;
  xpRateLabel: string;
  /** Pre-computed daily XP = amount × ratePerDollar */
  dailyXP: number;
}

export interface ComputedXPComparison {
  asset: string;
  amount: number;
  /** Sorted descending by dailyXP — rows[0] is the best option. */
  rows: Array<{ venue: string; ratePerDollar: number; dailyXP: number }>;
}

export interface SupportAnswerParams {
  customerMessage: string;
  matchedFAQs: Array<Pick<FAQ, 'title' | 'question' | 'answer' | 'category'>>;
  venues: VenueContext[];
  assets: AssetContext[];
  /** True when FTS found at least one FAQ hit — used for prompt framing, not passed to model as a number. */
  hasFAQMatch: boolean;
  /** Pre-computed XP calculation when the user stated an explicit dollar amount AND named a specific venue. */
  computedXP?: ComputedXP | null;
  /** Pre-computed XP ranking across every venue (+ wallet) that supports the asset, when no single venue was named. */
  computedXPComparison?: ComputedXPComparison | null;
  /** Previous bot replies the customer identified as incorrect — the model must not repeat them. */
  rejectedFacts?: string[];
}

export interface SupportAnswerResult {
  confidence: number;
  matchedFAQTitles: string[];
  reasoning: string;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  suggestedReply: string;
}

// ─── Context block parsing ────────────────────────────────────────────────────
// When the RAG receives a follow-up or clarification message, `customerMessage`
// is a structured multi-line block. We split it into a prior-context section and
// the actual current question so the model knows exactly what to answer.

interface ParsedQuestion {
  /** The question the model should answer right now. */
  current: string;
  /** Optional prior exchange — shown as context only, not to be re-answered. */
  prior: string | null;
  /** True when this is a follow-up to a prior exchange. */
  isFollowUp: boolean;
}

function parseCustomerMessage(msg: string): ParsedQuestion {
  // Pattern A: [Previous exchange] ... [Customer follow-up] <question>
  const followupMatch = msg.match(/^([\s\S]*?)\[Customer follow-up\]\s*([\s\S]+)$/);
  if (followupMatch) {
    return { current: followupMatch[2]!.trim(), prior: followupMatch[1]!.trim(), isFollowUp: true };
  }

  // Pattern B: [Customer is replying to this message] "..." [Customer reply] <question>
  const replyMatch = msg.match(/^\[Customer is replying to this message\]\s*"([\s\S]*?)"\s*\[Customer reply\]\s*([\s\S]+)$/);
  if (replyMatch) {
    return {
      current: replyMatch[2]!.trim(),
      prior: `Customer is replying to: "${replyMatch[1]!.trim()}"`,
      isFollowUp: true,
    };
  }

  // Pattern C: <original> [Customer clarified: <answer>]
  const clarifiedMatch = msg.match(/^([\s\S]*?)\[Customer clarified:\s*([\s\S]+?)\]\s*$/);
  if (clarifiedMatch) {
    return {
      current: clarifiedMatch[2]!.trim(),
      prior: `Original question: ${clarifiedMatch[1]!.trim()}`,
      isFollowUp: true,
    };
  }

  return { current: msg, prior: null, isFollowUp: false };
}

function buildUserSection(
  customerMessage: string,
  faqContext: string,
  venueContext: string | null,
  assetContext: string | null,
  faqStatus: string,
  computedXP: ComputedXP | null | undefined,
  computedXPComparison: ComputedXPComparison | null | undefined,
  rejectedFacts: string[] | undefined,
): string {
  const parsed = parseCustomerMessage(customerMessage);

  const todayLine = `Today's date: ${new Date().toISOString().slice(0, 10)} (UTC)`;

  const questionBlock = parsed.isFollowUp
    ? [
        parsed.prior ? `[Prior conversation context — for reference only]\n${parsed.prior}` : null,
        `[Current question to answer]\n"${parsed.current}"`,
        '',
        'Answer the current question specifically. Use the prior context to identify WHAT the customer is referring to — including resolving pronouns like "their", "those", or "it" to specific items (assets, venues, numbers) named in the prior context. If the prior reply listed multiple items and the customer is now asking about "them" collectively, answer for EACH item individually, not just one. Once you know what is being asked about, pull FRESH facts and rates from the FAQs and venue data below — do NOT reuse or repeat rates, numbers, or claims from the prior context itself, even for items it named, since that context is not a verified source. Do NOT re-answer the previous question. Do NOT ask for clarification unless the reference genuinely cannot be resolved from the prior context.',
      ]
        .filter((l) => l !== null)
        .join('\n\n')
    : `A customer sent this message:\n"""\n${parsed.current}\n"""`;

  const computedBlock = computedXP
    ? `\n[PRE-COMPUTED CALCULATION — verified from venue data, use these exact figures]
Venue: ${computedXP.venue}
Asset / pool: ${computedXP.asset}
Position value: $${computedXP.amount.toLocaleString()}
XP rate: ${computedXP.xpRateLabel}
Daily XP = $${computedXP.amount.toLocaleString()} × ${computedXP.ratePerDollar} = ${computedXP.dailyXP.toLocaleString()} Hylo XP per day
Use this result directly. Do NOT ask the customer for their position value — they already stated it (in dollars or in tokens, already converted here).\n`
    : '';

  const comparisonBlock = computedXPComparison
    ? `\n[PRE-COMPUTED XP COMPARISON — verified, ranked best to worst]
Asset: ${computedXPComparison.asset}
Position value: $${computedXPComparison.amount.toLocaleString()}
${computedXPComparison.rows.map((r, i) => `${i + 1}. ${r.venue}: ${r.ratePerDollar} XP/$/day → ${r.dailyXP.toLocaleString()} XP/day`).join('\n')}
The first row is the best option. Present this as a ranked comparison and state which option wins. Do NOT ask the customer for their position value — they already stated it.
Each rate belongs to its own venue only — the same asset earns a DIFFERENT rate at each venue (e.g. holding it in a wallet vs. a specific pool). When you state the winning rate, name the venue it came from in the same breath (e.g. "on Kamino, that's 8 XP per dollar per day") — never describe a rate as if it applies to the asset generally, and never state a number from one row while attributing it to a different row's venue.\n`
    : '';

  const rejectedBlock = rejectedFacts?.length
    ? `\n[PREVIOUSLY REJECTED — the customer confirmed the following information was INCORRECT]\n${rejectedFacts.map((f, i) => `${i + 1}. "${f.slice(0, 400)}"`).join('\n')}\n\nDo NOT repeat, rephrase, or build on any of the above. Before writing suggestedReply, verify it contains none of these claims.\n`
    : '';

  return `${todayLine}

${questionBlock}
${computedBlock}${comparisonBlock}${rejectedBlock}
Relevant FAQ entries from our knowledge base:
${faqContext}
${venueContext ? `\nThird-party venue XP data:\n${venueContext}` : ''}
${assetContext ? `\nHylo native assets:\n${assetContext}` : ''}

Search status: ${faqStatus}

Analyse the question, reason through the answer using the FAQs and venue data above, then generate a suggested reply.

Respond with raw JSON only — no markdown, no code fences, no prose before or after. Use exactly this shape:
{
  "confidence": <number 0–100>,
  "matchedFAQTitles": ["<title of FAQ used, or empty array>"],
  "reasoning": "<2–3 sentences on how you arrived at the answer>",
  "needsClarification": <true ONLY if you genuinely cannot answer without more info, false otherwise>,
  "clarificationQuestion": "<the question to ask, or null>",
  "suggestedReply": "<the full reply to the customer, first person, Markdown — MUST be non-empty when needsClarification is false>"
}`;
}

export function buildSupportAnswerPrompt(params: SupportAnswerParams): AIRequest {
  const faqContext =
    params.matchedFAQs.length > 0
      ? params.matchedFAQs
          .map(
            (faq, i) =>
              `--- FAQ ${i + 1}: ${faq.title} [${faq.category}] ---\nQ: ${faq.question}\nA: ${faq.answer}`,
          )
          .join('\n\n')
      : 'No matching FAQs found.';

  const venueContext =
    params.venues.length > 0
      ? params.venues
          .map((v) => {
            const assetLines =
              v.assets.length > 0
                ? v.assets
                    .map(
                      (a) =>
                        `  • ${a.asset}: ${a.xpRate}${a.notes ? ` (${a.notes})` : ''}`,
                    )
                    .join('\n')
                : '  (no assets listed)';
            const contextLine = v.context ? `\n  Note: ${v.context}` : '';
            const linkLine = v.link ? `\n  Official URL: ${v.link}` : '';
            const disclaimerLine = v.disclaimer ? `\n  ⚠ Disclaimer: ${v.disclaimer}` : '';
            return `--- Third-Party Venue: ${v.name}${v.description ? ` — ${v.description}` : ''} ---${contextLine}${linkLine}${disclaimerLine}\n${assetLines}`;
          })
          .join('\n\n')
      : null;

  const assetContext =
    params.assets.length > 0
      ? params.assets
          .map((a) => {
            const descLine = a.description ? `\n  ${a.description}` : '';
            const consLine = a.considerations ? `\n  ⚠ Note: ${a.considerations}` : '';
            return `--- Hylo Asset: ${a.symbol} (${a.name}) ---${descLine}${consLine}`;
          })
          .join('\n\n')
      : null;

  const faqStatus = params.hasFAQMatch
    ? 'Knowledge base search found relevant FAQ entries — prioritise these in your answer.'
    : 'Knowledge base search found no direct FAQ match. Reason from venue data if relevant; use general knowledge for everything else.';

  return {
    systemPrompt: `You are an expert customer support specialist at Hylo, a social platform for purpose-driven communities built on Web3 technology.

Your role is to help a support agent craft the ideal reply to a customer's message.

CRITICAL RULES:
1. Always prefer verified information from the FAQ knowledge base and venue data over general knowledge.
2. If FAQs or venue data contain relevant rates, numbers, or assets, USE that data to derive the answer — including performing any calculations needed.
3. OUTPUT CONTRACT — you have exactly two valid output states. You MUST produce one of them:
   a. ANSWER: provide a non-empty suggestedReply (set needsClarification: false).
   b. CLARIFY: set needsClarification: true with a focused clarificationQuestion (suggestedReply can be empty).
   Returning an empty suggestedReply with needsClarification: false is NEVER acceptable.
4. WHEN TO CLARIFY: If the question is ambiguous, has multiple valid interpretations, or one focused follow-up would dramatically improve your answer — ask that question instead of guessing. Ask only one question per turn. Do NOT ask for clarification if the customer has already answered a prior clarification question. NEVER ask for information the customer already stated in their message (e.g., if they said "I have $1,000,000", that IS their position value — do not ask for it again).
5. WHEN TO ANSWER: Use FAQs and venue data when they are relevant. For general Web3, DeFi, or Solana questions not covered by the FAQs, answer from general knowledge while clearly noting it is not a verified Hylo policy. Never invent Hylo-specific rates, program structures, or platform facts that are not in the provided FAQs or venue data.
5a. PRE-COMPUTED CALCULATIONS: If a [PRE-COMPUTED CALCULATION] block appears in the message, those figures are correct and already verified. Use them directly in your reply — do not recalculate, do not question them, do not reference other venues. If a [PRE-COMPUTED XP COMPARISON] block appears instead, present it as a ranked comparison (best option first) and explicitly state which one wins — this is the answer to "where should I earn the most XP" type questions.
5b. SELF-CHECK: If a [PREVIOUSLY REJECTED] block appears, the customer has already confirmed that information was wrong. Before writing suggestedReply, ask yourself: "Am I about to repeat or paraphrase any rejected information?" If yes, stop and re-examine the FAQs and venue data. If the correct information is not available, set needsClarification: true or acknowledge the uncertainty honestly — never restate what was already rejected.
5c. DON'T CROSS-CONTAMINATE VENUES: Each venue's data is independent — a term like "notional value" that appears in one venue's data (e.g. Loopscale) does NOT apply to a different venue (e.g. Kamino) unless that venue's own data uses it too. When the customer describes an asset pair or pool (e.g. "hyUSD-jitoSOL pool") without naming a venue, check EACH venue's context field for that specific pair before answering — do not default to whichever venue you thought of first. If more than one venue could match, ask which one or list all matches.
5d. DON'T VOLUNTEER DASHBOARD/WEBSITE LINKS: Only mention a venue's dashboard, website, or UI if the customer is specifically asking about that exact venue, or asking where to check something that only that venue's UI shows. Do not append "you can also check the X dashboard" as a reflexive habit — most questions don't need it, and doing this for the wrong venue actively misleads the customer.
5e. DON'T VOLUNTEER XP INFO: Only discuss XP rates, XP calculations, or "how you can earn XP" when the customer's question is actually about XP. If their question is about something else entirely (a swap, a transaction, a technical issue, a general product question) and you don't have a real answer, do not pad the reply with unrelated XP rates as a consolation — that's not what they asked, and it reads as filler, not help.
5f. TIME-SENSITIVE FACTS: The message includes today's actual date. If an FAQ or venue note describes something as upcoming ("will happen", "is expected around <date>", "currently... in the meantime") and the date it names is on or before today's date, treat that thing as already true and answer in the present tense instead — do not describe something as still upcoming once its own stated date has passed. Conversely, if the date is still in the future, keep the future framing exactly as written; do not guess or round the date.
5g. DON'T MERGE DISTINCT VALUES: When an FAQ lists several items each with their own number (e.g. different XP rates per asset, different fees per tier), summarizing them into a shorter sentence is fine — but every item must keep its OWN exact value. Never group two items under one number because they're adjacent in the list or because it reads more smoothly; if two items truly share the same number, only say so if the source data actually shows the same number for both. Before finalizing, re-check your reply against the source list item by item.
6. Write the suggested reply as if you ARE the support agent — first person, warm, professional, concise. Answer directly; do NOT cite or reference the source of your information. Never say "based on our FAQ", "according to our knowledge base", "our records show", or any similar phrase — the customer has no visibility into your knowledge base and shouldn't know it exists. The FAQ and venue data are your private reference — speak as if you simply know the answer.
   BAD (do not do this): "I couldn't find a direct answer to your question in our knowledge base. However, I can suggest that you check the Loopscale dashboard..." — this both names the knowledge base AND invents an unrelated platform suggestion that isn't backed by any FAQ or venue data (rule 5 violation).
   GOOD instead: if you cannot answer, either ask one focused clarifying question (needsClarification: true — see rule 4), or say plainly what you don't have information on without guessing at where the customer might find it elsewhere.
7. Never use: "Hope you're doing well", "Just checking in", "Kindly", "Please do not hesitate". Never use em dashes (—).
7a. TONE WITH FRUSTRATED CUSTOMERS: If the customer's message reads as upset or frustrated (profanity, exclamation, "what is going on", etc.), lead with acknowledgment before facts. State any firm policy (e.g. "we won't be restoring X") gently and with the reasoning behind it, not as a blunt refusal — the goal is to be understood as fair, not dismissive.
8. FORMATTING: Structure your reply with clear paragraph breaks. Each distinct idea or point goes in its own paragraph, separated by a blank line. Never write more than 2–3 sentences in a single paragraph. Use bullet points only for lists of 3 or more items. Short answers (1–2 sentences) do not need special formatting.
9. Respond with valid JSON only.`,
    messages: [
      {
        role: 'user',
        content: buildUserSection(params.customerMessage, faqContext, venueContext, assetContext, faqStatus, params.computedXP, params.computedXPComparison, params.rejectedFacts),
      },
    ],
    temperature: 0.6,
    maxTokens: 1200,
  };
}

// ─── Summarise Customer Issue ─────────────────────────────────────────────────

export interface SummariseIssueParams {
  customerMessage: string;
}

export function buildSummariseIssuePrompt(params: SummariseIssueParams): AIRequest {
  return {
    systemPrompt: `You are a support team lead at Hylo. Summarise customer issues concisely for internal triage.`,
    messages: [
      {
        role: 'user',
        content: `Summarise the following customer message in 1–2 sentences. Identify:
1. What the customer is experiencing
2. What they are asking for (if clear)

Customer message:
"""
${params.customerMessage}
"""

Return only the summary. No labels, no quotes.`,
      },
    ],
    temperature: 0.3,
    maxTokens: 150,
  };
}
