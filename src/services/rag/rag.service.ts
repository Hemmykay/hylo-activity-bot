import { aiService } from '@/services/ai/ai.service.js';
import { searchService } from '@/services/search/search.service.js';
import { faqRepository } from '@/db/repositories/faq.repository.js';
import { venueRepository } from '@/db/repositories/venue.repository.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { venueAssetXPRepository, toVenueAssetView } from '@/db/repositories/venue-asset-xp.repository.js';
import { resolveAssetPriceUsd } from '@/services/price/asset-price.service.js';
import { buildSupportAnswerPrompt } from '@/prompts/support.js';
import type { VenueContext, AssetContext, ComputedXP, ComputedXPComparison } from '@/prompts/support.js';
import { assetMentionedIn } from '@/lib/asset-match.js';
import type { Venue, Asset } from '@prisma/client';
import { config } from '@/config/index.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('rag-service');

export interface RAGResult {
  confidence: number;
  matchedFAQTitles: string[];
  reasoning: string;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  suggestedReply: string;
  provider: string;
  usedFallback: boolean;
}

// ─── JSON extraction helpers ──────────────────────────────────────────────────
// Local LLMs often ignore JSON format instructions or add extra prose around the
// JSON object. We try multiple strategies before falling back to plain text.

interface ParsedRAGResponse {
  confidence: number;
  matchedFAQTitles: string[];
  reasoning: string;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  suggestedReply: string;
}

function stripCodeFences(text: string): string {
  // Remove all ``` fences — models frequently wrap JSON in ```json ... ``` blocks
  // despite being told not to. Replace globally so opening + closing are both gone.
  return text
    .replace(/^```(?:\w+)?\s*/gm, '')  // opening fences (```json, ```, etc.)
    .replace(/^```\s*$/gm, '')          // bare closing fences
    .trim();
}

function tryExtractJSON(raw: string): ParsedRAGResponse | null {
  const stripped = stripCodeFences(raw);

  // Find outermost JSON object boundaries (handles any prose before/after)
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const candidate = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;

  try {
    return JSON.parse(candidate) as ParsedRAGResponse;
  } catch {
    return null;
  }
}

function unescapeJSON(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

// ─── Leak guard ────────────────────────────────────────────────────────────
// The system prompt already instructs the model never to reference "our
// knowledge base" (support.ts rule 6), but that instruction alone proved
// unreliable in practice — it leaked again after being added. This is a
// deterministic backstop: strip the phrase outright rather than trust the
// model to keep following the rule every time.

// Note: these deliberately do NOT try to consume trailing punctuation — "in
// our knowledge base" commonly ends the sentence it's in (e.g. "...rates in
// our knowledge base. However,"), and eating that period along with the
// phrase left the sentence boundary broken. The cleanup pass below fixes up
// the stray "word ." left behind instead.
const KNOWLEDGE_BASE_LEAK_PATTERNS = [
  /\b(?:in|from|according to)\s+our\s+knowledge\s*base\b/gi,
  /\bin\s+our\s+records\b/gi,
  /\bbased\s+on\s+our\s+knowledge(?:\s+base)?,?\s*/gi,
  /\bour\s+records\s+show\s+(?:that\s+)?/gi,
];

function sanitizeSuggestedReply(text: string): string {
  let cleaned = text;
  let leaked = false;
  for (const pattern of KNOWLEDGE_BASE_LEAK_PATTERNS) {
    if (pattern.test(cleaned)) leaked = true;
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, '');
  }
  if (!leaked) return text;

  cleaned = cleaned
    .replace(/\s+([.,!?])/g, '$1') // "rates ." -> "rates." (stray space left before punctuation)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s*[,.]\s*/, '')
    .trim();
  // Re-capitalize a sentence start that lost its leading word to the strip
  cleaned = cleaned.replace(/(^|[.!?]\s+)([a-z])/g, (_m, sep: string, letter: string) => sep + letter.toUpperCase());
  logger.warn({ before: text.slice(0, 200), after: cleaned.slice(0, 200) }, 'Stripped a "knowledge base" leak from suggestedReply');
  return cleaned;
}

function extractSuggestedReply(text: string): string | null {
  // Pass 1 — strict: properly closed string value
  const strict = text.match(/"suggestedReply"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  if (strict?.[1]) return unescapeJSON(strict[1]);

  // Pass 2 — lenient: handles token-truncated JSON where the closing " was never emitted.
  // Capture everything from the opening " until a JSON structural character or end-of-string.
  const lenient = text.match(/"suggestedReply"\s*:\s*"([\s\S]*?)(?="\s*[},]|"\s*$|$)/);
  if (lenient?.[1]?.trim()) return unescapeJSON(lenient[1].trim());

  return null;
}

// When the query is a clarification context block (multi-line with headers), pull
// out just the last user-facing sentence for FTS — the full block confuses keyword
// matching and tanks recall unnecessarily.
function extractSearchQuery(message: string): string {
  // Look for "[Customer clarified: ...]" or "[Customer follow-up]\n..." patterns
  const clarifiedMatch = message.match(/\[Customer clarified:\s*(.+?)\]/s);
  if (clarifiedMatch?.[1]) return clarifiedMatch[1].trim();

  const followupMatch = message.match(/\[Customer follow-up\]\s*([\s\S]+)$/);
  if (followupMatch?.[1]) return followupMatch[1].trim();

  // If the message has a "[Previous exchange]" header, use everything after "[Customer..."
  if (message.includes('[Previous exchange]')) {
    const lastLine = message.split('\n').filter(Boolean).at(-1);
    if (lastLine) return lastLine.trim();
  }

  return message;
}

// ─── Deterministic reasoning helpers ─────────────────────────────────────────
// These run BEFORE the LLM and give it verified, pre-computed facts so it
// doesn't have to do math or guess which venue is being asked about.

function extractDollarAmount(text: string): number | null {
  const parse = (numStr: string, suf?: string): number | null => {
    let n = parseFloat(numStr.replace(/,/g, ''));
    const s = suf?.toLowerCase();
    if (s === 'k' || s === 'thousand') n *= 1_000;
    if (s === 'm' || s === 'million') n *= 1_000_000;
    if (s === 'billion') n *= 1_000_000_000;
    return isFinite(n) && n > 0 ? n : null;
  };

  let m: RegExpMatchArray | null;

  // 1. Dollar sign: $1,000,000 / $1.5M / $500k / $1m
  m = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k|m|million|thousand|billion)?/i);
  if (m) return parse(m[1]!, m[2]);

  // 2. Spelled-out scale without $: "1 million", "500 thousand", "2.5 billion"
  m = text.match(/\b([\d,]+(?:\.\d+)?)\s+(million|thousand|billion)\b/i);
  if (m) return parse(m[1]!, m[2]);

  // 3. Short suffix at word boundary without $: "500k", "1.5M", "2m"
  //    \b after (k|m|M) ensures "1meter" or "1minute" are not matched
  m = text.match(/\b([\d,]+(?:\.\d+)?)(k|m|M)\b/);
  if (m) return parse(m[1]!, m[2]);

  // 4. Large bare number followed by "worth": "1,000,000 worth of"
  //    Require ≥4 digits to avoid false positives on small counts
  m = text.match(/\b([\d,]{4,}(?:\.\d+)?)\s+worth\b/i);
  if (m) return parse(m[1]!, undefined);

  // 5. Financial context word followed by a bare number:
  //    "I have 250000 in", "position of 500000", "deposited 1000000", "holding 2000000"
  m = text.match(/(?:position(?:\s+(?:value|of|is))?|deposite[d]?|invest(?:ed)?|holding|have)\s+(?:of\s+)?([\d,]{4,}(?:\.\d+)?)/i);
  if (m) return parse(m[1]!, undefined);

  return null;
}

function findMentionedVenue(text: string, venues: Venue[]): Venue | null {
  const lower = text.toLowerCase();
  // Sort longest-name-first so "Kamino Finance" matches before a hypothetical "Kamino"
  return [...venues]
    .sort((a, b) => b.name.length - a.name.length)
    .find((v) => lower.includes(v.name.toLowerCase())) ?? null;
}

/**
 * Extracts a flat "N XP per dollar per day" rate from an xpRate label.
 * Handles "8 XP per dollar", "8 Hylo XP per dollar", AND a bare "8" (the
 * field's own name already says it's the XP rate, so a lone number needs no
 * further qualifier — this is Kamino's actual stored format and was silently
 * unmatched before, meaning the deterministic computation never fired for it).
 * Deliberately does NOT match multiplier notations like "8X" or "1X
 * multiplier on notional value" — those depend on leverage/notional inputs
 * this function doesn't have, so they're correctly left uncomputed rather
 * than guessed at.
 */
function parseXPRatePerDollar(xpRate: string): number | null {
  const trimmed = xpRate.trim();
  if (/^[\d.]+$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    return isFinite(n) && n > 0 ? n : null;
  }
  const m = trimmed.match(/([\d.]+)\s*(?:Hylo\s*)?XP\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * Matches "100 xSOL", "3.5 HYLOSOL+" — a token quantity, not a dollar figure.
 * XP rates are per-dollar, so this needs converting via live price before use
 * (see tryComputeXP) rather than being applied to the raw count directly.
 */
function extractTokenAmount(text: string, assets: Asset[]): { tokenAmount: number; asset: Asset } | null {
  // Longest symbol first so "HYLOSOL+" is checked before "HYLOSOL" matches inside it
  const sorted = [...assets].sort((a, b) => b.symbol.length - a.symbol.length);
  for (const asset of sorted) {
    const esc = asset.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = text.match(new RegExp(`\\b([\\d,]+(?:\\.\\d+)?)\\s*${esc}\\b`, 'i'));
    if (!m) continue;
    const tokenAmount = parseFloat(m[1]!.replace(/,/g, ''));
    if (isFinite(tokenAmount) && tokenAmount > 0) return { tokenAmount, asset };
  }
  return null;
}

/**
 * Resolves a position size from either a stated dollar amount or a stated
 * token quantity (converted via live price). Shared by tryComputeXP (single
 * venue) and tryComputeXPComparison (across all venues) so both interpret
 * "100 xSOL" or "$500" the same way.
 */
async function resolveStatedAmount(
  text: string,
  knownAssets: Asset[],
  assetMap: Map<string, Asset>,
): Promise<{ amount: number; asset: Asset | null } | null> {
  const dollarAmount = extractDollarAmount(text);
  if (dollarAmount !== null) {
    const lower = text.toLowerCase();
    const asset = knownAssets.find((a) => assetMentionedIn(a, lower)) ?? null;
    return { amount: dollarAmount, asset };
  }

  // No dollar figure stated — check for a token quantity instead ("100 xSOL")
  // and convert it to a dollar amount via that asset's live price, so the
  // XP rate (always per-dollar) is never applied to a raw token count.
  const tokenMatch = extractTokenAmount(text, knownAssets);
  if (tokenMatch) {
    const price = await resolveAssetPriceUsd(tokenMatch.asset.symbol, assetMap);
    if (price !== null) return { amount: tokenMatch.tokenAmount * price, asset: tokenMatch.asset };
  }

  return null;
}

async function tryComputeXP(text: string, venues: Venue[], knownAssets: Asset[], assetMap: Map<string, Asset>): Promise<ComputedXP | null> {
  const resolved = await resolveStatedAmount(text, knownAssets, assetMap);
  if (!resolved) return null;
  const { amount, asset: resolvedAsset } = resolved;

  const venue = findMentionedVenue(text, venues);
  if (!venue) return null;

  const xpRows = await venueAssetXPRepository.findByVenue(venue.id);
  if (!xpRows.length) return null;

  const lower = text.toLowerCase();
  // Prefer the asset resolved from the stated amount (e.g. "100 xSOL" already
  // names it exactly); fall back to whatever's mentioned elsewhere in the text.
  const row =
    (resolvedAsset ? xpRows.find((r) => r.asset.symbol === resolvedAsset.symbol) : undefined) ??
    xpRows.find((r) => assetMentionedIn(r.asset, lower)) ??
    xpRows[0]!;

  const ratePerDollar = parseXPRatePerDollar(row.xpRate);
  if (ratePerDollar === null) return null;

  return {
    venue: venue.name,
    asset: row.asset.symbol,
    amount,
    ratePerDollar,
    xpRateLabel: row.xpRate,
    dailyXP: Math.round(amount * ratePerDollar),
  };
}

// ─── Multi-venue XP comparison ────────────────────────────────────────────
// "is Kamino the best place to earn XP" needs a ranked comparison across
// every venue that supports the asset, plus the wallet-holding rate — not
// just the one venue tryComputeXP would pick. Wallet rates aren't structured
// data (no "wallet" Venue row), so they're parsed from the one FAQ that
// documents them; if that FAQ's wording changes, wallet rows silently drop
// out of the comparison rather than breaking it.
const WALLET_XP_FAQ_TITLE = 'Hylo XP Rates for Wallet Assets';
const WALLET_RATE_LINE_PATTERN = /Hold\s+([A-Za-z+]+)\**:\s*([\d.]+)\s*XP\s*per\s*dollar/gi;

async function getWalletXPRates(): Promise<Map<string, number>> {
  const rates = new Map<string, number>();
  const faqs = await faqRepository.findAll({ activeOnly: true });
  const walletFAQ = faqs.find((f) => f.title === WALLET_XP_FAQ_TITLE);
  if (!walletFAQ) return rates;

  for (const m of walletFAQ.answer.matchAll(WALLET_RATE_LINE_PATTERN)) {
    rates.set(m[1]!.toLowerCase(), parseFloat(m[2]!));
  }
  return rates;
}

async function tryComputeXPComparison(
  text: string,
  knownAssets: Asset[],
  assetMap: Map<string, Asset>,
): Promise<ComputedXPComparison | null> {
  const resolved = await resolveStatedAmount(text, knownAssets, assetMap);
  if (!resolved?.asset) return null;
  const { amount, asset } = resolved;

  const [venueRows, walletRates] = await Promise.all([
    venueAssetXPRepository.findByAsset(asset.id),
    getWalletXPRates(),
  ]);

  const rows: ComputedXPComparison['rows'] = [];

  const walletRate = walletRates.get(asset.symbol.toLowerCase());
  if (walletRate !== undefined) {
    rows.push({ venue: 'Wallet (holding)', ratePerDollar: walletRate, dailyXP: Math.round(amount * walletRate) });
  }

  for (const row of venueRows) {
    const ratePerDollar = parseXPRatePerDollar(row.xpRate);
    if (ratePerDollar === null) continue;
    rows.push({ venue: row.venue.name, ratePerDollar, dailyXP: Math.round(amount * ratePerDollar) });
  }

  if (rows.length === 0) return null;
  rows.sort((a, b) => b.dailyXP - a.dailyXP);

  return { asset: asset.symbol, amount, rows };
}

class RAGService {
  async answer(customerMessage: string, actorId: string, rejectedFacts: string[] = []): Promise<RAGResult> {
    logger.debug({ messageLength: customerMessage.length }, 'RAG pipeline start');

    // 1. Extract a clean search query from clarification contexts.
    // When the message is a multi-line clarification block, FTS searches work better
    // against just the core user question rather than the full combined string.
    const searchQuery = extractSearchQuery(customerMessage);

    // 2. Search FAQ knowledge base
    const searchResults = await searchService.search(searchQuery, actorId, 5);

    // 3. Normalise scores to 0–1
    const topScore = searchResults[0]?.score ?? 0;
    const normalisedConfidence = topScore > 0 ? Math.min(topScore / 0.5, 1) : 0;

    logger.debug({ resultCount: searchResults.length, normalisedConfidence }, 'Search complete');

    // 4. Fall back to full KB when FTS finds nothing (e.g. calculation questions)
    let contextFAQs = searchResults.slice(0, 3);
    if (contextFAQs.length === 0) {
      const allFAQs = await faqRepository.findAll({ activeOnly: true });
      contextFAQs = allFAQs.map((f) => ({ ...f, score: 0 }));
      logger.debug({ faqCount: allFAQs.length }, 'FTS returned nothing — using full knowledge base');
    }

    // 5. Fetch active third-party venues and Hylo native assets (assets fetched
    //    here, ahead of where they're used for prompt context below, so
    //    tryComputeXP can resolve live prices for token-count phrasing)
    const [venueRows, assetRows] = await Promise.all([
      venueRepository.findAll({ activeOnly: true }),
      assetRepository.findAll({ activeOnly: true }),
    ]);
    const assetMap = new Map(assetRows.map((a) => [a.symbol, a]));

    // 5a. Venue filtering — if the customer mentioned a specific venue by name, only show
    //     that venue's data. This prevents the model from referencing the wrong venue.
    const mentionedVenue = findMentionedVenue(searchQuery, venueRows);
    const relevantVenueRows = mentionedVenue ? [mentionedVenue] : venueRows;

    if (mentionedVenue) {
      logger.debug({ venue: mentionedVenue.name }, 'Venue filter active');
    }

    // 5b. Deterministic XP computation — if the customer provided an explicit dollar
    //     amount, or a token quantity convertible via live price, AND mentioned a
    //     recognisable venue+asset, compute the result in code so the model doesn't
    //     have to do math and cannot ask for information already given.
    const computedXP = await tryComputeXP(searchQuery, venueRows, assetRows, assetMap);
    if (computedXP) {
      logger.debug({ venue: computedXP.venue, asset: computedXP.asset, dailyXP: computedXP.dailyXP }, 'XP pre-computed');
    }

    // 5c. No single venue resolved (e.g. "is Kamino the best place to earn XP",
    //     comparing options) — rank every venue (+ wallet) that supports the
    //     asset instead, so "which is best" has an actual answer.
    const computedXPComparison = computedXP ? null : await tryComputeXPComparison(searchQuery, assetRows, assetMap);
    if (computedXPComparison) {
      logger.debug({ asset: computedXPComparison.asset, best: computedXPComparison.rows[0] }, 'XP comparison pre-computed');
    }

    const venues: VenueContext[] = await Promise.all(
      relevantVenueRows.map(async (v) => ({
        name: v.name,
        description: v.description,
        context: v.context,
        link: v.link,
        disclaimer: v.disclaimer,
        assets: toVenueAssetView(await venueAssetXPRepository.findByVenue(v.id)),
      })),
    );

    // 6. Map assets to prompt context
    const assets: AssetContext[] = assetRows.map((a) => ({
      symbol: a.symbol,
      name: a.name,
      description: a.description,
      considerations: a.considerations,
    }));

    // 7. Build prompt
    const promptParams: Parameters<typeof buildSupportAnswerPrompt>[0] = {
      customerMessage,
      matchedFAQs: contextFAQs,
      venues,
      assets,
      hasFAQMatch: normalisedConfidence > 0,
      computedXP,
      computedXPComparison,
    };
    if (rejectedFacts.length > 0) promptParams.rejectedFacts = rejectedFacts;
    const prompt = buildSupportAnswerPrompt(promptParams);

    // 8. Generate
    const aiResponse = await aiService.generate(prompt);

    // 9. Parse — multiple strategies for local LLM resilience
    let parsed: ParsedRAGResponse;

    const extracted = tryExtractJSON(aiResponse.text);

    if (extracted) {
      parsed = extracted;
      parsed.needsClarification ??= false;
      parsed.clarificationQuestion ??= null;
    } else {
      // JSON parse failed entirely — decide how to recover
      logger.warn({ raw: aiResponse.text.slice(0, 200) }, 'Failed to parse RAG JSON — using fallback');

      const rawText = aiResponse.text.trim();
      const strippedText = stripCodeFences(rawText);
      const looksLikeJSON = strippedText.includes('"suggestedReply"') || strippedText.trimStart().startsWith('{');

      let suggestedReply: string;
      if (looksLikeJSON) {
        // Malformed JSON — try to salvage the suggestedReply field.
        // NEVER fall back to rawText here: sending raw JSON to the user is always wrong.
        // An empty string signals the caller to ask for clarification instead.
        suggestedReply = extractSuggestedReply(strippedText) ?? '';
      } else {
        // Plain-text response from local LLM — use it directly as the answer.
        suggestedReply = strippedText;
      }

      parsed = {
        confidence: Math.round(normalisedConfidence * 100),
        matchedFAQTitles: searchResults.map((r) => r.title),
        reasoning: 'Response was plain text — used directly.',
        needsClarification: false,
        clarificationQuestion: null,
        suggestedReply,
      };
    }

    // No auto-escalation UI (no "knowledge base update" self-serve flow, no
    // Discord ping) — the bot just answers as best it can and this is the
    // paper trail. An admin reviewing needs the actual question text, not
    // just a confidence number, to decide whether it's worth a new FAQ.
    const belowThreshold = parsed.confidence / 100 < config.app.faqConfidenceThreshold;
    const needsAdminAttention = parsed.needsClarification || (belowThreshold && parsed.matchedFAQTitles.length === 0);
    if (needsAdminAttention) {
      logger.warn(
        {
          customerMessage: customerMessage.slice(0, 500),
          actorId,
          confidence: parsed.confidence,
          needsClarification: parsed.needsClarification,
          matchedFAQTitles: parsed.matchedFAQTitles,
        },
        'Bot could not confidently answer — no FAQ covers this, flagging for admin review',
      );
    }

    if (parsed.suggestedReply) parsed.suggestedReply = sanitizeSuggestedReply(parsed.suggestedReply);
    if (parsed.clarificationQuestion) parsed.clarificationQuestion = sanitizeSuggestedReply(parsed.clarificationQuestion);

    return {
      ...parsed,
      provider: aiResponse.provider,
      usedFallback: aiResponse.usedFallback,
    };
  }
}

export const ragService = new RAGService();
