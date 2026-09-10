import {
  EmbedBuilder,
  type Message,
} from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { ragService } from '@/services/rag/rag.service.js';
import { faqService } from '@/services/faq/faq.service.js';
import { searchService } from '@/services/search/search.service.js';
import { buildIntentPrompt, type DMIntent } from '@/prompts/intent.js';
import { buildQuickAnswerPrompt } from '@/prompts/quick-answer.js';
import { buildComposeStatementPrompt } from '@/prompts/compose-statement.js';
import { buildFAQExtractPrompt } from '@/prompts/faq.js';
import { buildRewritePrompt } from '@/prompts/rewrite.js';
import { buildFAQImprovementPrompt, type FAQImprovementResult, buildFAQSmartMergePrompt, type FAQSmartMergeResult } from '@/prompts/faq-improvement.js';
import { venueRepository } from '@/db/repositories/venue.repository.js';
import { faqRepository } from '@/db/repositories/faq.repository.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { correctionRepository } from '@/db/repositories/correction.repository.js';
import { venueAssetXPRepository } from '@/db/repositories/venue-asset-xp.repository.js';
import {
  queryTokenSupply,
  queryTokenHolders,
  queryTokenActivity,
  queryRecentPoolRebalanceEvents,
} from '@/services/onchain/helius.service.js';
import { resolveAssetPriceUsd } from '@/services/price/asset-price.service.js';
import { queryPrice } from '@/services/price/jupiter-price.service.js';
import { queryLSTPrice } from '@/services/price/hylo.service.js';
import { queryXSOLPrice } from '@/services/price/xsol.service.js';
import { queryXBTCPrice } from '@/services/price/xbtc.service.js';
import { queryEHYUSDPrice } from '@/services/price/ehyusd.service.js';
import { buildConfirmationRow, COLORS, truncate, safeEmbedText } from '@/lib/discord-utils.js';
import { assetMentionedIn, findMatchingAsset } from '@/lib/asset-match.js';
import { createLogger } from '@/lib/logger.js';
import type { FAQDraftInput } from '@/services/faq/faq.types.js';

const logger = createLogger('intent-router');

// ─── Answer Record ────────────────────────────────────────────────────────────
// Maps the bot's reply message ID → the original customer question it answered.
// When an agent replies to a bot answer with "!" to correct it, we can look up
// the original question so the FAQ is created with the right Q/A pairing.

interface AnswerRecord {
  originalQuestion: string;
  expiresAt: number;
}
const answersByBotMsgId = new Map<string, AnswerRecord>();
const ANSWER_TTL_MS = 24 * 60 * 60 * 1000;

function recordAnswer(botMsgId: string, originalQuestion: string): void {
  answersByBotMsgId.set(botMsgId, {
    originalQuestion,
    expiresAt: Date.now() + ANSWER_TTL_MS,
  });
  setTimeout(() => answersByBotMsgId.delete(botMsgId), ANSWER_TTL_MS).unref?.();
}

function getOriginalQuestion(botMsgId: string): string | null {
  const record = answersByBotMsgId.get(botMsgId);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    answersByBotMsgId.delete(botMsgId);
    return null;
  }
  return record.originalQuestion;
}

// ─── Correction Detection ─────────────────────────────────────────────────────
// Recognises when the user is saying the previous answer was wrong.

const CORRECTION_PATTERNS = [
  /\bthat'?s?\s+(wrong|incorrect|not\s+right|not\s+true|not\s+correct|not\s+accurate)\b/i,
  /\byou'?re?\s+wrong\b/i,
  /\byou\s+(?:made\s+a\s+mistake|got\s+(?:that\s+)?wrong)\b/i,
  /\bthat\s+is\s+(?:wrong|incorrect|not\s+right)\b/i,
  /\bno[,.]?\s+that'?s?\s+not\b/i,
  /\bthat'?s?\s+not\s+(?:correct|right|accurate|true)\b/i,
  /\b(?:please\s+)?(?:correct|fix)\s+(?:that|your(?:self)?)\b/i,
  /\bwrong\s+(?:answer|information|info)\b/i,
];

function isCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((re) => re.test(text));
}

// ─── Last Bot Reply Store ─────────────────────────────────────────────────────
// Tracks the most recent reply the bot sent to each user so we can extract it
// as a rejected fact if the user calls it incorrect.

interface LastBotReplyRecord {
  text: string;
  originalQuestion: string;
  expiresAt: number;
}

const lastBotReplies = new Map<string, LastBotReplyRecord>();
const LAST_REPLY_TTL_MS = 30 * 60 * 1000;

function storeLastBotReply(userId: string, text: string, originalQuestion: string): void {
  lastBotReplies.set(userId, { text, originalQuestion, expiresAt: Date.now() + LAST_REPLY_TTL_MS });
  setTimeout(() => lastBotReplies.delete(userId), LAST_REPLY_TTL_MS).unref?.();
}

function popLastBotReply(userId: string): { text: string; originalQuestion: string } | null {
  const record = lastBotReplies.get(userId);
  if (!record || Date.now() > record.expiresAt) {
    lastBotReplies.delete(userId);
    return null;
  }
  return { text: record.text, originalQuestion: record.originalQuestion };
}

// ─── Rejected Facts Store ─────────────────────────────────────────────────────
// Accumulates facts the user has flagged as wrong so they can be injected into
// subsequent prompts. Expired after 30 minutes of inactivity.

interface RejectedFactsRecord {
  facts: string[];
  expiresAt: number;
}

const rejectedFactsStore = new Map<string, RejectedFactsRecord>();
const REJECTED_FACTS_TTL_MS = 30 * 60 * 1000;

function addRejectedFact(userId: string, fact: string): void {
  const existing = rejectedFactsStore.get(userId);
  const facts = existing ? [...existing.facts, fact] : [fact];
  rejectedFactsStore.set(userId, {
    facts: facts.slice(-5), // cap at 5 to avoid prompt bloat
    expiresAt: Date.now() + REJECTED_FACTS_TTL_MS,
  });
  setTimeout(() => rejectedFactsStore.delete(userId), REJECTED_FACTS_TTL_MS).unref?.();
}

function getRejectedFacts(userId: string): string[] {
  const record = rejectedFactsStore.get(userId);
  if (!record || Date.now() > record.expiresAt) {
    rejectedFactsStore.delete(userId);
    return [];
  }
  return record.facts;
}

// ─── FAQ Improvement Session ──────────────────────────────────────────────────
// Entered when a correction is detected. The next message from the user is
// treated as the corrected answer and processed through buildFAQImprovementPrompt.

interface FaqImprovementSession {
  originalQuestion: string;
  wrongBotAnswer: string;
  expiresAt: number;
}

const faqImprovementSessions = new Map<string, FaqImprovementSession>();
const FAQ_IMPROVEMENT_TTL_MS = 15 * 60 * 1000;

function storeFAQImprovementSession(
  userId: string,
  originalQuestion: string,
  wrongBotAnswer: string,
): void {
  faqImprovementSessions.set(userId, {
    originalQuestion,
    wrongBotAnswer,
    expiresAt: Date.now() + FAQ_IMPROVEMENT_TTL_MS,
  });
  setTimeout(() => faqImprovementSessions.delete(userId), FAQ_IMPROVEMENT_TTL_MS).unref?.();
}

function popFAQImprovementSession(userId: string): FaqImprovementSession | null {
  const session = faqImprovementSessions.get(userId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    faqImprovementSessions.delete(userId);
    return null;
  }
  faqImprovementSessions.delete(userId);
  return session;
}

// ─── Clarification Session State ──────────────────────────────────────────────

interface ClarificationSession {
  originalMessage: string;
  clarificationQuestion: string;
  expiresAt: number;
}

const clarificationSessions = new Map<string, ClarificationSession>();
const CLARIFICATION_TTL_MS = 10 * 60 * 1000;

function storeClarification(userId: string, originalMessage: string, question: string): void {
  clarificationSessions.set(userId, {
    originalMessage,
    clarificationQuestion: question,
    expiresAt: Date.now() + CLARIFICATION_TTL_MS,
  });
  setTimeout(() => clarificationSessions.delete(userId), CLARIFICATION_TTL_MS).unref?.();
}

function popClarification(userId: string): ClarificationSession | null {
  const session = clarificationSessions.get(userId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    clarificationSessions.delete(userId);
    return null;
  }
  clarificationSessions.delete(userId);
  return session;
}

// ─── KB Discuss Detection ────────────────────────────────────────────────────
// Detected deterministically — never via LLM — to prevent over-triggering on
// ordinary customer questions that happen to mention a protocol name.

const KB_DISCUSS_PATTERNS = [
  /\bwhat do you know about\b/i,
  /\bdo you have (info|information|data|anything) (on|about)\b/i,
  /\byour (knowledge|info|data|database|kb|knowledge\s+base) (on|about|for)\b/i,
  /\b(check|look up|show me|show me what) (you have|your|the) (knowledge|database|kb|data|info)\b/i,
  /\b(update|fix|correct|change) your (knowledge|info|data|records)\b/i,
  /\bwhat('?s| is) in (your|the) (database|knowledge\s+base|kb)\b/i,
  /\byou already have\b/i,
  /\bthe (link|url|description|context|disclaimer) for .+ (should be|is wrong|needs to be|must be)\b/i,
  /\bkb[\s:-]/i,
  /\bknowledge\s+base\b/i,
];

function isKBDiscuss(text: string): boolean {
  return KB_DISCUSS_PATTERNS.some((re) => re.test(text));
}

// ─── Compose Statement Detection ─────────────────────────────────────────────
// "Help me structure/draft/write a statement/message that X" — the agent is
// asking the bot to COMPOSE new customer-facing text expressing a reason or
// fact, not to improve wording they already gave it. The AI intent
// classifier previously misrouted this to 'rewrite' (a real, observed
// failure: fed the literal instruction sentence to buildRewritePrompt, which
// just handed back a request to phrase it themselves — the opposite of
// helpful). Detected deterministically, same reasoning as isKBDiscuss: this
// distinction is easy to get precisely backwards, so don't leave it to the
// classifier.
const COMPOSE_STATEMENT_PATTERNS = [
  /\b(help me|please|can you|could you)\b[^.!?\n]{0,40}\b(structure|draft|write|compose|phrase)\b[^.!?\n]{0,40}\b(statement|message|reply|response|explanation)\b/i,
  /\b(help me|please|can you|could you)\b[^.!?\n]{0,20}\b(tell|explain to)\s+(them|him|her|the (customer|user))\b/i,
];

function isComposeStatementRequest(text: string): boolean {
  return COMPOSE_STATEMENT_PATTERNS.some((re) => re.test(text));
}

// ─── Greeting / Chit-chat Detection ──────────────────────────────────────────
// Short casual openers that should never trigger a full RAG pipeline.

const GREETING_PATTERNS = [
  /^(hey|hi|hello|howdy|yo|sup|hiya|heya|what'?s?\s+up|how'?s?\s+it\s+going|how\s+are\s+you|good\s+(morning|afternoon|evening|day))[\s!.?]*$/i,
];

function isGreeting(text: string): boolean {
  return GREETING_PATTERNS.some((re) => re.test(text.trim()));
}

// ─── On-chain Detection — Tier 1: Address Lookup (DB only, no Helius) ────────
// "What's the token address of X?" → answer from DB, no external call needed.

const TOKEN_ADDRESS_PATTERNS = [
  /\b(token|mint|contract|wallet)\s+address\b/i,
  /\baddress\s+(of|for)\b/i,
  /\bwhat('?s| is)(\s+the)?\s+(token|mint|contract)\b/i,
  /\bwhere\s+(can\s+i\s+find|is)\s+the\s+(token|mint|contract)\b/i,
];

function isTokenAddressQuery(text: string): boolean {
  return TOKEN_ADDRESS_PATTERNS.some((re) => re.test(text));
}

// ─── On-chain Detection — Tier 2: Live Data (requires Helius) ────────────────
// Each pattern set maps to exactly one API call. Order matters — check the most
// specific patterns first so a question like "total supply and holders" resolves
// to 'supply' (the first match), not a generic fallback.

type OnchainQueryType = 'supply' | 'holders' | 'activity';

const ONCHAIN_SUPPLY_PATTERNS = [
  /\b(total\s+)?supply\b/i,
  /\bcirculating\b/i,
  /\bhow\s+many\s+tokens?\s+(are\s+)?(there|exist|in\s+circulation)/i,
  /\bhow\s+much.*\bminted\b/i,
];

const ONCHAIN_HOLDER_PATTERNS = [
  /\b(holder|holders)\b/i,
  /\bhow\s+many\s+(wallet|wallets|people|user|users)\b/i,
  /\bwho\s+(hold|holds|owns)\b/i,
];

const ONCHAIN_ACTIVITY_PATTERNS = [
  /\b(new|recent|latest)\s+(mint|mints|minted|minting)\b/i,
  /\bburn(ed|s|ing)?\b/i,
  /\brecent\s+(activity|transaction|tx)\b/i,
  /\bon.?chain\b/i,
];

function detectOnchainQueryType(text: string): OnchainQueryType | null {
  if (ONCHAIN_SUPPLY_PATTERNS.some((re) => re.test(text))) return 'supply';
  if (ONCHAIN_HOLDER_PATTERNS.some((re) => re.test(text))) return 'holders';
  if (ONCHAIN_ACTIVITY_PATTERNS.some((re) => re.test(text))) return 'activity';
  return null;
}

// ─── Price Detection — Tier 1.5: Live price via Jupiter ──────────────────────
// Maps common names/abbreviations to the symbol keys in jupiter-price.service.ts's MINT_IDS.

const PRICE_SYMBOL_MAP: Record<string, string> = {
  // Hylo LSTs — resolved via on-chain vault calculation, not Jupiter
  hylosol: 'HYLOSOL', 'hylo sol': 'HYLOSOL', 'hylo staked sol': 'HYLOSOL',
  'hylosol+': 'HYLOSOLPLUS', 'hylo sol+': 'HYLOSOLPLUS', 'hylo sol plus': 'HYLOSOLPLUS', 'hylo staked sol plus': 'HYLOSOLPLUS',
  // Hylo stablecoin — hardcoded $1 peg
  hyusd: 'HYUSD', 'hylo usd': 'HYUSD',
  // xSOL lever token — collateral-backed
  xsol: 'XSOL', 'hylo xsol': 'XSOL',
  // xBTC lever token — cbBTC-collateral-backed
  xbtc: 'XBTC', 'hylo xbtc': 'XBTC',
  // eHYUSD yield-bearing token — collateral-backed. Renamed from sHYUSD (same
  // mint/collateral wallet, same formula) — "shyusd"/"staked hyusd" etc. kept
  // as legacy aliases for a transition period so old habits still resolve.
  ehyusd: 'EHYUSD', 'hylo ehyusd': 'EHYUSD',
  shyusd: 'EHYUSD', 'hylo shyusd': 'EHYUSD', 'staked hyusd': 'EHYUSD', 'staked hylo usd': 'EHYUSD',
  // Stability Pool APY — scoped phrases only. Bare "apy"/"yield" stay unmapped
  // since hyloSOL has its own separate (much lower) staking APY; we don't want
  // a generic "what's the apy" question silently routed to the wrong number.
  'stability pool apy': 'EHYUSD', 'stability pool yield': 'EHYUSD',
  'shyusd apy': 'EHYUSD', 'ehyusd apy': 'EHYUSD', 'staking hyusd apy': 'EHYUSD', 'hyusd staking yield': 'EHYUSD',
  // Standard Jupiter-tracked mints
  sol: 'SOL', solana: 'SOL',
  btc: 'BTC', bitcoin: 'BTC',
  eth: 'ETH', ethereum: 'ETH',
  usdc: 'USDC',
  bonk: 'BONK',
};

const PRICE_TRIGGER_PATTERNS = [
  /\b(price|cost|worth|rate|apy|yield)\b/i,
  /\btrading\s+at\b/i,
  /\bhow\s+much\b/i,
  /\bcurrent(ly)?\s+(price|value|rate)\b/i,
];

function extractMentionedSymbols(text: string): string[] {
  const lower = text.toLowerCase();
  const allWords = Object.keys(PRICE_SYMBOL_MAP);
  // Longest key first so "hylosol+" is always checked before "hylosol"
  const entries = Object.entries(PRICE_SYMBOL_MAP).sort((a, b) => b[0].length - a[0].length);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const [word, sym] of entries) {
    if (seen.has(sym)) continue;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Build negative lookaheads for any longer key that starts with this word,
    // so "hylosol" doesn't match inside "hylosol+" (\b treats '+' as non-word)
    const neg = allWords
      .filter((w) => w !== word && w.startsWith(word))
      .map((w) => w.slice(word.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const re = new RegExp(`\\b${esc}${neg ? `(?!${neg})` : ''}`);
    if (re.test(lower)) {
      found.push(sym);
      seen.add(sym);
    }
  }
  return found;
}

// A question about a TOOL that happens to mention "price" (a predictor,
// simulator, dashboard) isn't asking for a live quote — e.g. "is there a
// website that predicts xSOL price for a given SOL price" should reach FAQ
// search (which has the actual answer: the risk-dashboard simulator), not
// the deterministic price lookup.
const PRICE_TOOL_EXCLUSION_PATTERN = /\b(website|dashboard|predictor|simulate|simulator|calculator|tool|chart)\b/i;

// "I have $102 worth of hyUSD-USDC, what's the XP per day?" trips the "worth"
// trigger and matches hyUSD/USDC as symbols, but it's really an XP question —
// answering with prices instead is exactly the wrong reply. XP questions need
// ragService's dollar-amount → XP-rate computation (tryComputeXP /
// tryComputeXPComparison in rag.service.ts), so they must fall through past
// this tier rather than being answered here.
const XP_QUERY_EXCLUSION_PATTERN = /\bxp\b/i;

function detectPriceQuery(text: string): string[] | null {
  if (!PRICE_TRIGGER_PATTERNS.some((re) => re.test(text))) return null;
  if (PRICE_TOOL_EXCLUSION_PATTERN.test(text)) return null;
  if (XP_QUERY_EXCLUSION_PATTERN.test(text)) return null;
  const found = extractMentionedSymbols(text);
  return found.length > 0 ? found : null;
}

// ─── Market Cap Detection — Tier 1.45 ─────────────────────────────────────────
// "market cap", "multiply supply by price" — a distinct computed quantity, not
// covered by PRICE_TRIGGER_PATTERNS (which matches "price" as a standalone
// lookup, not "price × supply"). Checked ahead of the plain price tier so this
// takes priority when both would otherwise match.

const MARKET_CAP_PATTERNS = [
  /\bmarket\s*cap(?:italization)?\b/i,
  /\bmcap\b/i,
  /\b(?:multiply|times)\b.*\bsupply\b.*\bprice\b/i,
  /\b(?:multiply|times)\b.*\bprice\b.*\bsupply\b/i,
  /\bsupply\b\s*(?:x|\*|times)\s*\bprice\b/i,
  /\bprice\b\s*(?:x|\*|times)\s*\bsupply\b/i,
];

function detectMarketCapQuery(text: string): string[] | null {
  if (!MARKET_CAP_PATTERNS.some((re) => re.test(text))) return null;
  const found = extractMentionedSymbols(text);
  return found.length > 0 ? found : null;
}

// ─── Protocol Health Detection — Tier 1.6 ────────────────────────────────────
// "What's the collateral ratio?", "how levered is xSOL?" — protocol-wide
// metrics, not tied to one asset symbol, so they don't fit PRICE_SYMBOL_MAP.
// Both values are derived from the same data as the xSOL price calculation.

const PROTOCOL_HEALTH_PATTERNS = [
  /\bcollateral\s+ratio\b/i,
  /\beffective\s+leverage\b/i,
  /\bhow\s+(healthy|levered|leveraged)\b/i,
  /\bprotocol\s+health\b/i,
  /\bhealth\s+(of|level)\b/i,
];

function isProtocolHealthQuery(text: string): boolean {
  return PROTOCOL_HEALTH_PATTERNS.some((re) => re.test(text));
}

// ─── Stability Pool Rebalance History — Tier 1.65 ────────────────────────────
// "last 10 stability pool offloads", "stability pool deployments" — answered
// with a live on-chain scan (no DB), so it's real history straight from the
// chain rather than only what's been observed since some feature shipped.
// Capped at 10: each request is a bounded backward scan of the stability pool
// wallet's own signature history (see queryRecentPoolRebalanceEvents), and a
// DM reply needs to stay timely.

const STABILITY_POOL_QUERY_PATTERN = /stability\s+pool\s+(offload|deployment|buy|sell)s?\b/i;
const STABILITY_POOL_QUERY_MAX = 10;

const STABILITY_POOL_QUERY_TYPE: Record<string, 'OFFLOAD' | 'DEPLOYMENT'> = {
  offload: 'OFFLOAD',
  deployment: 'DEPLOYMENT',
  // "buy" = pool buying xSOL (deploying hyUSD into xSOL exposure); "sell" =
  // pool selling xSOL (offloading it back to hyUSD) — same underlying events,
  // just the trader's-perspective framing instead of the protocol's own terms.
  buy: 'DEPLOYMENT',
  sell: 'OFFLOAD',
};

/**
 * `replyBotText` lets a bare follow-up continue a prior Stability Pool list
 * without repeating "stability pool" — e.g. replying to a "Stability Pool
 * Offload: ..." list with just "what about sells?" or "and buys?".
 */
function detectStabilityPoolQuery(text: string, replyBotText?: string | null): { type: 'OFFLOAD' | 'DEPLOYMENT'; limit: number } | null {
  const countMatch = text.match(/\b(\d{1,3})\b/);
  const limit = countMatch ? Math.min(Math.max(Number(countMatch[1]), 1), STABILITY_POOL_QUERY_MAX) : STABILITY_POOL_QUERY_MAX;

  const directMatch = text.match(STABILITY_POOL_QUERY_PATTERN);
  if (directMatch) {
    return { type: STABILITY_POOL_QUERY_TYPE[directMatch[1]!.toLowerCase()]!, limit };
  }

  if (replyBotText?.startsWith('Stability Pool ')) {
    const followupMatch = text.match(/\b(offload|deployment|buy|sell)s?\b/i);
    if (followupMatch) {
      return { type: STABILITY_POOL_QUERY_TYPE[followupMatch[1]!.toLowerCase()]!, limit };
    }
  }

  return null;
}

// ─── Asset Detail Detection — Tier 1.7 ───────────────────────────────────────
// "Tell me about X", "What is X", "Explain X" → rich embed (price + venues + XP).
// Intentionally NOT caught before the price tier so "what is X's price" still
// resolves via Tier 1.5 first.  Supply/holders/activity queries are guarded
// explicitly since they come AFTER this tier in the pipeline.

const ASSET_DETAIL_TRIGGER_PATTERNS = [
  /\b(tell me|explain|describe)\b/i,
  /\bgive me\s+(the\s+)?(full|complete|all|more\s+)?(details?|info(?:rmation)?|overview|breakdown|summary)\b/i,
  /\b(full|complete)\s+(details?|info(?:rmation)?|overview|breakdown)\b/i,
  /\boverview\s+(of|on|about)\b/i,
  /\bmore\s+(?:info|details?|about)\b/i,
  /\bwhat\s+(?:is|are|'?s)\b/i,
  /\bhow\s+does\b/i,
];

function isAssetDetailQuery(text: string): boolean {
  // Don't intercept supply / holders / activity — those go to Tier 2
  if (detectOnchainQueryType(text) !== null) return false;
  return ASSET_DETAIL_TRIGGER_PATTERNS.some((re) => re.test(text));
}

// ─── Reply Context ────────────────────────────────────────────────────────────

interface ReplyContext {
  originalQuestion: string | null;
  botReply: string;
}

async function fetchReplyContext(message: Message): Promise<ReplyContext | null> {
  if (!message.reference?.messageId) return null;
  try {
    const refMsg = await message.channel.messages.fetch(message.reference.messageId);
    if (!refMsg.author.bot) return null;
    const originalQuestion = getOriginalQuestion(refMsg.id);
    return { originalQuestion, botReply: refMsg.content };
  } catch {
    return null;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * @param message  The Discord message (used for author info, replying, etc.)
 * @param content  The text to route. Defaults to message.content but may be a
 *                 batch-combined string when multiple rapid messages are coalesced.
 */
export interface RouteGuard {
  isCancelled(): boolean;
}

export async function routeIntent(
  message: Message,
  content = message.content,
  guard?: RouteGuard,
): Promise<void> {
  const userId = message.author.id;

  // FAQ improvement session takes highest priority — the user was asked for the
  // correct answer and this message IS that correction.
  const improvementSession = popFAQImprovementSession(userId);
  if (improvementSession) {
    return handleFAQImprovementResponse(message, content, improvementSession);
  }

  const replyContext = await fetchReplyContext(message);

  // Greeting fast-path — skip LLM and RAG entirely for casual openers
  if (isGreeting(content)) {
    await message.reply("Hey! What can I help you with today? Feel free to paste a customer question and I'll suggest a reply, or use `/` to see available commands.");
    return;
  }

  // Explicit FAQ submission/correction: starts with !
  // When used as a reply to a bot message → smart-update the existing FAQ.
  // When used standalone → create a new FAQ draft.
  if (content.trimStart().startsWith('!')) {
    const faqText = content.trimStart().slice(1).trim();
    if (!faqText) {
      await message.reply(
        'Add the FAQ content after `!` to submit it.\n\nExample:\n`! Q: How do I reset my password? A: Go to Settings → Security → Reset Password.`',
      );
      return;
    }
    if (replyContext) {
      logger.debug({}, 'Routing ! reply → FAQ smart update');
      return handleFAQSmartUpdate(message, faqText, replyContext);
    }
    logger.debug({ contentLength: faqText.length }, 'Routing ! standalone → FAQ create');
    return handleFAQCreate(message, faqText, undefined);
  }

  // Quick correction: reply to a bot message with @<correction> — stored
  // immediately as a raw audit record (correctionRepository), no AI call, no
  // confirmation UI, no auto-FAQ-update. Distinct from `!` above, which
  // drives an immediate structured FAQ create/update: this is deliberately
  // just a timestamped "question → wrong answer → why/how it should differ"
  // record for a human to review later via `/corrections list`.
  if (content.trimStart().startsWith('@')) {
    const correctionText = content.trimStart().slice(1);
    if (!replyContext) {
      await message.reply(
        'Reply to the bot message you want to correct, prefixed with `@` — e.g.\n`@ This should have mentioned the 24h unstake cooldown.`',
      );
      return;
    }
    logger.debug({}, 'Routing @ reply → quick correction');
    return handleQuickCorrection(message, correctionText, replyContext);
  }

  // ── Deterministic pre-classification ─────────────────────────────────────────
  // kb_discuss is never LLM-classified — small models over-trigger it on any
  // message that mentions a protocol name. Detect it with explicit patterns only.
  if (isKBDiscuss(content)) {
    logger.debug({}, 'Pre-classified as kb_discuss (regex match)');
    return handleKBDiscuss(message, content);
  }

  // Tier 1 — token address lookup: answer from the database, no Helius call.
  if (isTokenAddressQuery(content)) {
    const assets = await assetRepository.findAll({ activeOnly: true });
    const lower = content.toLowerCase();
    const named = assets
      .sort((a, b) => b.symbol.length - a.symbol.length)
      .filter((a) => assetMentionedIn(a, lower));
    // If specific assets were mentioned use those; otherwise return everything we have
    const targets = named.length > 0 ? named : assets;
    if (targets.length === 1) {
      const t = targets[0]!;
      logger.debug({ symbol: t.symbol }, 'Pre-classified as token_address_lookup');
      return handleTokenAddressLookup(message, t.symbol, t.name, t.tokenAddress ?? null);
    }
    if (targets.length > 1) {
      logger.debug({ symbols: targets.map((t) => t.symbol) }, 'Pre-classified as multi-token_address_lookup');
      return handleMultiTokenAddressLookup(message, targets);
    }
    // Nothing in the DB at all
    await message.reply("I don't have any assets in my database yet. An admin can add them via `/asset add`.");
    return;
  }

  // Tier 1.45 — market cap: price × supply, computed directly.
  const marketCapSymbols = detectMarketCapQuery(content);
  if (marketCapSymbols) {
    logger.debug({ marketCapSymbols }, 'Pre-classified as market_cap_query');
    return handleMarketCapQuery(message, content, marketCapSymbols);
  }

  // Tier 1.5 — live price via Jupiter / on-chain vault calculation.
  const priceSymbols = detectPriceQuery(content);
  if (priceSymbols) {
    logger.debug({ priceSymbols }, 'Pre-classified as price_query');
    return handlePriceQuery(message, content, priceSymbols);
  }

  // Tier 1.6 — protocol health: collateral ratio, xSOL effective leverage.
  if (isProtocolHealthQuery(content)) {
    logger.debug({}, 'Pre-classified as protocol_health_query');
    return handleProtocolHealthQuery(message, content);
  }

  // Tier 1.65 — stability pool rebalance history (persisted event log).
  const stabilityPoolQuery = detectStabilityPoolQuery(content, replyContext?.botReply);
  if (stabilityPoolQuery) {
    logger.debug({ stabilityPoolQuery }, 'Pre-classified as stability_pool_query');
    return handleStabilityPoolQuery(message, stabilityPoolQuery.type, stabilityPoolQuery.limit);
  }

  // Tier 1.7 — asset detail: rich embed with price, description, considerations,
  // and per-venue XP rates.  Catches "tell me about X", "what is X", "explain X".
  if (isAssetDetailQuery(content)) {
    const assets = await assetRepository.findAll({ activeOnly: true });
    const target = findMatchingAsset(content, assets);
    if (target) {
      logger.debug({ symbol: target.symbol }, 'Pre-classified as asset_detail_query');
      return handleAssetDetailQuery(message, target);
    }
    // No specific Hylo asset mentioned — fall through to on-chain / RAG
  }

  // Tier 2 — live on-chain data: one API call per question type, no bulk fetches.
  const onchainType = detectOnchainQueryType(content);
  if (onchainType) {
    const assets = await assetRepository.findAll({ activeOnly: true });
    const target = findMatchingAsset(content, assets);
    if (target?.tokenAddress) {
      logger.debug({ symbol: target.symbol, onchainType }, 'Pre-classified as onchain_query');
      return handleOnchainQuery(message, content, target.symbol, target.name, target.tokenAddress, onchainType);
    }
    if (target && !target.tokenAddress) {
      await message.reply(`I don't have a token address stored for **${target.symbol}** yet. An admin can add it via \`/asset edit\`.`);
      return;
    }
  }

  // Tier 2.5 — compose a customer-facing statement from a stated reason,
  // rather than the AI classifier's error-prone guess between this and a
  // plain rewrite (see isComposeStatementRequest's comment for the real
  // failure this fixes).
  if (isComposeStatementRequest(content)) {
    logger.debug({}, 'Pre-classified as compose_statement');
    return handleComposeStatement(message, content, replyContext);
  }

  // AI intent classification
  let intent: DMIntent = 'customer_question';
  try {
    const intentResponse = await aiService.generate(buildIntentPrompt(content));
    const cleaned = intentResponse.text.trim()
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '');
    const parsed = JSON.parse(cleaned) as { intent: DMIntent; confidence: number };
    intent = parsed.intent;
    logger.debug({ intent, confidence: parsed.confidence }, 'Intent classified');
  } catch (err) {
    logger.warn({ err }, 'Intent classification failed — defaulting to customer_question');
  }

  // ── Deterministic overrides ─────────────────────────────────────────────────
  // kb_discuss can never come from the LLM (it was removed from the prompt) —
  // if it's ever returned anyway, treat it as a customer question instead.
  if (intent === 'kb_discuss') {
    intent = 'customer_question';
    logger.debug({}, 'Overriding kb_discuss → customer_question (no regex match)');
  }

  switch (intent) {
    case 'faq_create':
      await message.reply(
        "It looks like you're trying to add a FAQ. Start your message with `!` to submit it for review.\n\nExample:\n`! Q: <question> A: <answer>`",
      );
      return;

    case 'rewrite':
    case 'improve_wording':
      return handleRewrite(message, content);

    case 'general':
      return handleCustomerQuestion(message, content, replyContext, guard);

    default:
      return handleCustomerQuestion(message, content, replyContext, guard);
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// Wraps an already-resolved deterministic fact block (price/market-cap/
// protocol-health) in a natural, reasoned reply via the LLM. The facts
// themselves are never touched by this — only used as the tiers' final
// human-facing phrasing. Falls back to the raw facts verbatim when no AI
// provider is configured or the call fails, so these queries never depend on
// LLM connectivity to keep working (only the *wording* does).
const URL_PATTERN = /https?:\/\/\S+/g;

async function composeReply(question: string, facts: string): Promise<string> {
  if (!aiService.isAvailable) return facts;
  try {
    const response = await aiService.generate(buildQuickAnswerPrompt({ question, facts }));
    const text = response.text.trim();
    if (!text) return facts;

    // Small local models occasionally drop or mangle links despite being told
    // not to (observed while testing this) — a link a customer can't click is
    // worse than a robotic-sounding fact dump, so verify every URL survived
    // verbatim before trusting the rephrased version.
    const factUrls = facts.match(URL_PATTERN) ?? [];
    if (factUrls.some((url) => !text.includes(url))) {
      logger.warn({ factUrls }, 'LLM phrasing dropped/altered a URL — falling back to raw facts');
      return facts;
    }

    return text;
  } catch (err) {
    logger.warn({ err }, 'LLM phrasing failed — falling back to raw facts');
    return facts;
  }
}

async function handleFAQCreate(message: Message, text: string, questionContext?: string) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  if (questionContext) {
    logger.debug({ questionContext }, 'FAQ create with reply context — question pre-filled');
  }

  const aiResponse = await aiService.generate(buildFAQExtractPrompt(text, questionContext));

  let draft: FAQDraftInput;
  try {
    const cleaned = aiResponse.text.trim()
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '');
    draft = JSON.parse(cleaned) as FAQDraftInput;
  } catch {
    await message.reply("I couldn't structure that as a FAQ. Try:\n`! Q: <question> A: <answer>`");
    return;
  }

  const actor = { id: message.author.id, name: message.author.displayName };
  const pendingId = await faqService.pendingCreate(draft, actor, message.channelId);

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📝 New FAQ Draft')
    .addFields(
      { name: 'Title', value: draft.title, inline: false },
      { name: 'Category', value: draft.category, inline: true },
      { name: 'Tags', value: draft.tags.join(', ') || 'none', inline: true },
      { name: 'Question', value: draft.question, inline: false },
      { name: 'Answer', value: truncate(draft.answer, 900), inline: false },
    )
    .setFooter({ text: questionContext ? 'Correction from bot reply — review carefully' : 'Review carefully before saving' })
    .setTimestamp();

  const sent = await message.reply({
    content: questionContext
      ? "Here's the corrected FAQ draft — the question was inferred from the conversation:"
      : "Here's the FAQ I extracted — review and save, edit, or cancel:",
    embeds: [embed],
    components: [buildConfirmationRow(pendingId)],
  });

  await faqService.setPendingDiscordMsgId(pendingId, sent.id);
}

/**
 * Stores a correction immediately, with no AI involvement and no confirmation
 * step — the point is a fast, low-friction way to flag "the bot got this
 * wrong" in the moment, trusting the raw record over any auto-structuring.
 * Review and any resulting FAQ update happens later via `/corrections list`.
 */
async function handleQuickCorrection(message: Message, correctionText: string, replyCtx: ReplyContext) {
  const trimmed = correctionText.trim();
  if (!trimmed) {
    await message.reply(
      'Add your correction after `@` — e.g.\n`@ This should have mentioned the 24h unstake cooldown.`',
    );
    return;
  }

  await correctionRepository.create({
    actorId: message.author.id,
    actorName: message.author.displayName,
    originalQuestion: replyCtx.originalQuestion ?? '(not tracked for this reply — bot answer came from a non-conversational handler)',
    wrongBotAnswer: replyCtx.botReply,
    rawCorrection: trimmed,
  });

  await message.reply('📝 Saved for review — `/corrections list` to audit later.');
}

async function handleFAQSmartUpdate(message: Message, correction: string, replyCtx: ReplyContext) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const originalQuestion = replyCtx.originalQuestion ?? replyCtx.botReply;

  // Find the FAQ(s) most relevant to the original question
  const candidates = await faqRepository.fullTextSearch(originalQuestion, 3);

  if (candidates.length === 0) {
    // No existing FAQ found — fall back to creating a new one
    logger.debug({}, 'No matching FAQ for smart update — falling back to FAQ create');
    return handleFAQCreate(message, correction, replyCtx.originalQuestion ?? undefined);
  }

  const target = candidates[0]!;

  const aiResponse = await aiService.generate(
    buildFAQSmartMergePrompt({
      existingFAQ: { title: target.title, question: target.question, answer: target.answer },
      originalCustomerQuestion: replyCtx.originalQuestion ?? '',
      wrongBotReply: replyCtx.botReply,
      agentCorrection: correction,
    }),
  );

  let result: FAQSmartMergeResult;
  try {
    const cleaned = aiResponse.text.trim()
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '');
    result = JSON.parse(cleaned) as FAQSmartMergeResult;
  } catch {
    await message.reply("I couldn't structure the merge. Try using `/faq edit` to update it manually.");
    return;
  }

  const actor = { id: message.author.id, name: message.author.displayName };
  const pendingId = await faqService.pendingUpdate(
    target.id,
    {
      title: result.proposedTitle,
      answer: result.proposedAnswer,
    },
    actor,
    message.channelId,
  );

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('FAQ Update — Smart Merge')
    .addFields(
      { name: 'FAQ', value: `${target.title} \`${target.id.slice(-6)}\``, inline: false },
      { name: 'Changes', value: result.changesSummary, inline: false },
      { name: 'Updated Answer', value: truncate(result.proposedAnswer, 900), inline: false },
    )
    .setFooter({ text: 'Confirm to apply, Edit to adjust, or Cancel to discard' })
    .setTimestamp();

  const sent = await message.reply({
    content: "Here's the proposed update — it keeps what was correct and applies your correction:",
    embeds: [embed],
    components: [buildConfirmationRow(pendingId)],
  });

  await faqService.setPendingDiscordMsgId(pendingId, sent.id);
}

async function handleKBDiscuss(message: Message, content: string) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const lower = content.toLowerCase();

  // Pull venue data for any venue mentioned by name
  const allVenues = await venueRepository.findAll({ activeOnly: true });
  const mentionedVenue = [...allVenues]
    .sort((a, b) => b.name.length - a.name.length)
    .find((v) => lower.includes(v.name.toLowerCase()));

  // Pull matching FAQs via full-text search
  const matchingFAQs = await faqRepository.fullTextSearch(content, 5);

  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('Knowledge Base').setTimestamp();

  if (mentionedVenue) {
    const xpRows = await venueAssetXPRepository.findByVenue(mentionedVenue.id);
    const assetLines =
      xpRows.length > 0
        ? xpRows.map((r) => `  - ${r.asset.symbol}: ${r.xpRate}${r.notes ? ` (${r.notes})` : ''}`).join('\n')
        : '  (none)';

    const details = [
      mentionedVenue.description ?? null,
      mentionedVenue.context ? `XP context: ${mentionedVenue.context}` : null,
      mentionedVenue.link ? `Link: ${mentionedVenue.link}` : '**No link stored** — add one with `/venue edit`',
      mentionedVenue.disclaimer ? `Disclaimer: ${mentionedVenue.disclaimer}` : null,
      `Assets:\n${assetLines}`,
    ]
      .filter(Boolean)
      .join('\n');

    embed.addFields({ name: `Venue: ${mentionedVenue.name}`, value: details, inline: false });
  }

  if (matchingFAQs.length > 0) {
    const faqLines = matchingFAQs
      .slice(0, 3)
      .map((f) => `• **${f.title}**: ${f.answer.slice(0, 120)}${f.answer.length > 120 ? '…' : ''}`)
      .join('\n');
    embed.addFields({ name: 'Matching FAQs', value: faqLines, inline: false });
  }

  if (!mentionedVenue && matchingFAQs.length === 0) {
    embed.setDescription("I don't have any information about this topic in my knowledge base yet.");
    embed.addFields({
      name: 'How to add it',
      value: '• **Venue** (protocol with XP rates): `/venue add [name]`\n• **FAQ**: start a message with `!` followed by `Q: … A: …`\n• **From a document**: paste the raw text and I\'ll extract what I can',
      inline: false,
    });
  } else {
    embed.addFields({
      name: 'Need to update something?',
      value: '• **Edit a venue field** (link, disclaimer, assets): `/venue edit [name]`\n• **Edit an FAQ**: `/faq` → search → edit\n• **Tell me directly**: say "the [field] for [name] should be [value]" and I\'ll confirm before saving',
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

async function handleCustomerQuestion(
  message: Message,
  content: string,
  replyContext: ReplyContext | null,
  guard?: RouteGuard,
) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const userId = message.author.id;

  // ── Correction detection ────────────────────────────────────────────────────
  // Store the rejected fact so the model won't repeat it, then enter FAQ
  // improvement mode: ask the user for the correct answer so the knowledge base
  // can be updated.
  if (isCorrection(content)) {
    const lastReply = popLastBotReply(userId);
    if (lastReply) {
      addRejectedFact(userId, lastReply.text);
      storeFAQImprovementSession(userId, lastReply.originalQuestion, lastReply.text);
      logger.info({ userId }, 'Correction detected — entering FAQ improvement mode');
      await message.reply(
        "Thanks for letting me know that wasn't right. What should the correct answer have been? I'll use your response to improve my knowledge base.",
      );
      return;
    }
  }

  const rejectedFacts = getRejectedFacts(userId);

  let queryForRAG: string;
  let isAnsweringClarification = false;

  if (replyContext) {
    const { originalQuestion, botReply } = replyContext;
    if (originalQuestion) {
      queryForRAG = `[Previous exchange]\nCustomer originally asked: "${originalQuestion}"\nBot answered: "${truncateForContext(botReply)}"\n\n[Customer follow-up]\n${content}`;
    } else {
      queryForRAG = `[Customer is replying to this message]\n"${truncateForContext(botReply)}"\n\n[Customer reply]\n${content}`;
    }
    popClarification(userId);
    isAnsweringClarification = true;
    logger.debug({ userId }, 'Re-running RAG with reply context');
  } else {
    const session = popClarification(userId);
    if (session) {
      queryForRAG = `${session.originalMessage}\n\n[Customer clarified: ${content}]`;
      isAnsweringClarification = true;
      logger.debug({ userId }, 'Processing clarification answer');
    } else {
      queryForRAG = content;
    }
  }

  const result = await ragService.answer(queryForRAG, userId, rejectedFacts);

  // If this job was superseded by a newer message, discard the result silently.
  if (guard?.isCancelled()) {
    logger.debug({ userId }, 'Reply suppressed — job was superseded');
    return;
  }

  if (result.needsClarification && !isAnsweringClarification && result.clarificationQuestion) {
    storeClarification(userId, content, result.clarificationQuestion);
    logger.debug({ userId }, 'Sending clarification question');
    const sentClarification = await message.reply({ content: result.clarificationQuestion });
    recordAnswer(sentClarification.id, content);
    storeLastBotReply(userId, result.clarificationQuestion, queryForRAG);
    return;
  }

  // If the model returned empty despite instructions, prefer the model's own clarification
  // question (it at least has context) over a generic fallback.
  const replyText = autoparagraph(result.suggestedReply.trim());
  if (!replyText) {
    logger.warn({ userId, confidence: result.confidence }, 'RAG returned empty reply — falling back to clarification');
    const fallback = result.clarificationQuestion?.trim()
      ?? 'I want to make sure I give you the right information — could you share a bit more context about what you\'re trying to find out?';
    storeClarification(userId, content, fallback);
    const sentFallback = await message.reply({ content: fallback });
    recordAnswer(sentFallback.id, content);
    storeLastBotReply(userId, fallback, queryForRAG);
    return;
  }

  const sent = await message.reply({ content: replyText });
  recordAnswer(sent.id, content);
  storeLastBotReply(userId, replyText, queryForRAG);
}

async function handleFAQImprovementResponse(
  message: Message,
  correction: string,
  session: FaqImprovementSession,
) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  // Persist the raw correction immediately — before any AI call — so it is
  // always available for audit even if structuring fails or the bot crashes.
  let correctionId: string | null = null;
  try {
    const saved = await correctionRepository.create({
      actorId: message.author.id,
      actorName: message.author.displayName,
      originalQuestion: session.originalQuestion,
      wrongBotAnswer: session.wrongBotAnswer,
      rawCorrection: correction,
    });
    correctionId = saved.id;
  } catch (err) {
    logger.warn({ err }, 'Failed to persist raw correction — continuing without it');
  }

  // Helper: mark the correction structured in the background (never blocks the reply)
  const markStructured = (faqAction: 'created' | 'updated' | 'no_change', faqTitle?: string) => {
    if (!correctionId) return;
    correctionRepository.markStructured(correctionId, { faqAction, faqTitle }).catch((err) =>
      logger.warn({ err, correctionId }, 'Failed to mark correction as structured'),
    );
  };

  const existingFAQs = await faqRepository.findAll({ activeOnly: true });

  const aiResponse = await aiService.generate(
    buildFAQImprovementPrompt({
      originalQuestion: session.originalQuestion,
      wrongBotAnswer: session.wrongBotAnswer,
      userCorrection: correction,
      existingFAQs: existingFAQs.map((f) => ({
        id: f.id,
        title: f.title,
        category: f.category,
        question: f.question,
        answer: f.answer,
      })),
    }),
  );

  let result: FAQImprovementResult;
  try {
    const cleaned = aiResponse.text
      .trim()
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '');
    result = JSON.parse(cleaned) as FAQImprovementResult;
  } catch {
    // Correction is already saved as unstructured — admin can audit via /corrections list
    await message.reply(
      "I understood the correction and saved it for review, but had trouble structuring it as a FAQ. An admin can audit it via `/corrections list`.",
    );
    return;
  }

  if (result.action === 'no_change_needed') {
    markStructured('no_change');
    await message.reply(
      `Got it. ${result.reasoning} No knowledge base update was needed for this correction.`,
    );
    return;
  }

  const actor = { id: message.author.id, name: message.author.displayName };

  if (result.action === 'update_existing' && result.matchedFAQId) {
    let existing = null;
    try {
      existing = await faqRepository.findByShortId(result.matchedFAQId);
    } catch {
      // ambiguous match — fall through to create_new
    }

    if (existing) {
      const pendingId = await faqService.pendingUpdate(
        existing.id,
        {
          answer: result.proposedAnswer,
          title: result.proposedTitle,
          tags: result.proposedTags,
          keywords: result.proposedTags,
        },
        actor,
        message.channelId,
      );

      markStructured('updated', existing.title);

      const embed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('FAQ Update Proposed')
        .setDescription(result.reasoning)
        .addFields(
          { name: 'Updating', value: `${existing.title} \`${existing.id.slice(-6)}\``, inline: false },
          { name: 'New Question', value: result.proposedQuestion, inline: false },
          { name: 'Updated Answer', value: truncate(result.proposedAnswer, 900), inline: false },
        )
        .setFooter({ text: 'Confirm to apply this update to the knowledge base' })
        .setTimestamp();

      await message.reply({
        content: 'Found an existing FAQ that should be updated with this correction:',
        embeds: [embed],
        components: [buildConfirmationRow(pendingId)],
      });
      return;
    }
  }

  // action === 'create_new' or matched FAQ not found
  const draft: FAQDraftInput = {
    title: result.proposedTitle,
    question: result.proposedQuestion,
    answer: result.proposedAnswer,
    category: result.proposedCategory,
    tags: result.proposedTags,
    keywords: result.proposedTags,
  };

  const pendingId = await faqService.pendingCreate(draft, actor, message.channelId);
  markStructured('created', result.proposedTitle);

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('New FAQ Draft from Correction')
    .setDescription(result.reasoning)
    .addFields(
      { name: 'Title', value: result.proposedTitle, inline: false },
      { name: 'Category', value: result.proposedCategory, inline: true },
      { name: 'Tags', value: result.proposedTags.join(', ') || 'none', inline: true },
      { name: 'Question', value: result.proposedQuestion, inline: false },
      { name: 'Answer', value: truncate(result.proposedAnswer, 900), inline: false },
    )
    .setFooter({ text: 'Confirm to add to knowledge base, or Cancel to discard' })
    .setTimestamp();

  const sent = await message.reply({
    content: "This correction covers a topic not yet in my knowledge base. Here's the draft:",
    embeds: [embed],
    components: [buildConfirmationRow(pendingId)],
  });
  await faqService.setPendingDiscordMsgId(pendingId, sent.id);
}

async function handleTokenAddressLookup(
  message: Message,
  symbol: string,
  assetName: string,
  tokenAddress: string | null,
) {
  if (!tokenAddress) {
    await message.reply(
      `No token address is stored for **${symbol}** yet. An admin can add it via \`/asset edit\`.`,
    );
    return;
  }
  const solscanUrl = `https://solscan.io/token/${tokenAddress}`;
  await message.reply(
    `The **${symbol}** (${assetName}) token address is:\n[\`${tokenAddress}\`](${solscanUrl})`,
  );
}

// Fallback stake accounts used until an admin runs /asset configure for each LST.
const FALLBACK_LST_STAKES: Record<string, string[]> = {
  'HYLOSOL':  ['CyFfp1mRFSmxak9xnheNGCpVZG5964rCzN43ZtrvtYxi'],
  'HYLOSOL+': ['7DtBTtdECSxLHYbZkuNRhkF8LmEF1D1Ku4wJ8cexwnPY'],
};

async function resolvePriceBlock(symbol: string): Promise<string> {
  // ── Hylo LSTs: on-chain vault calculation ─────────────────────────────────
  if (symbol === 'HYLOSOL' || symbol === 'HYLOSOLPLUS') {
    const isPlus   = symbol === 'HYLOSOLPLUS';
    const label    = isPlus ? 'hyloSOL+' : 'hyloSOL';
    const dbSymbol = isPlus ? 'HYLOSOL+' : 'HYLOSOL';

    const asset = await assetRepository.findBySymbol(dbSymbol);
    if (!asset?.tokenAddress) {
      return `**${label}**: mint address not set — an admin can add it via \`/asset edit ${dbSymbol}\``;
    }

    // Use stake accounts from DB; fall back to hardcoded values until /asset configure is run
    const stakeAccounts = asset.stakeVault
      ? asset.stakeVault.split(',').map((s) => s.trim()).filter(Boolean)
      : (FALLBACK_LST_STAKES[dbSymbol] ?? []);

    if (stakeAccounts.length === 0) {
      return `**${label}**: no stake vault configured — an admin can set it via \`/asset configure ${dbSymbol}\``;
    }

    const result = await queryLSTPrice(stakeAccounts, asset.tokenAddress);
    if (!result.success) {
      return `**${label}**: price unavailable — ${result.error}`;
    }
    const { formatted, exchangeRate, stakedSOL, tokenSupply, solPrice } = result.data;
    return [
      `**${label}/USD** is currently **${formatted}**`,
      `Exchange rate: **${exchangeRate.toFixed(6)}** · Vault: **${stakedSOL.toLocaleString('en-US', { maximumFractionDigits: 3 })} SOL** · Supply: **${tokenSupply.toLocaleString('en-US', { maximumFractionDigits: 3 })}**`,
      `SOL/USD: **$${solPrice.toFixed(2)}** (Jupiter)`,
    ].join('\n');
  }

  // ── Hylo stablecoin: hardcoded $1 peg ────────────────────────────────────
  if (symbol === 'HYUSD') {
    return '**hyUSD/USD** is currently **$1.00** (stablecoin — 1:1 USD peg)';
  }

  // ── xSOL lever token: collateral TVL − hyUSD supply / xSOL supply ────────
  if (symbol === 'XSOL') {
    const [hyloSOLAsset, hyUSDAsset, xSOLAsset] = await Promise.all([
      assetRepository.findBySymbol('HYLOSOL'),
      assetRepository.findBySymbol('HYUSD'),
      assetRepository.findBySymbol('XSOL'),
    ]);

    if (!hyloSOLAsset?.tokenAddress) return '**xSOL**: hyloSOL mint not set — add it via `/asset edit HYLOSOL`';
    if (!hyUSDAsset?.tokenAddress)   return '**xSOL**: hyUSD mint not set — add it via `/asset edit HYUSD`';
    if (!xSOLAsset?.tokenAddress)    return '**xSOL**: xSOL mint not set — add it via `/asset edit XSOL`';

    const stakeAccounts = hyloSOLAsset.stakeVault
      ? hyloSOLAsset.stakeVault.split(',').map((s) => s.trim()).filter(Boolean)
      : (FALLBACK_LST_STAKES['HYLOSOL'] ?? []);

    const result = await queryXSOLPrice({
      hyloSOLMint: hyloSOLAsset.tokenAddress,
      hyloSOLStakeAccounts: stakeAccounts,
      xSOLMint: xSOLAsset.tokenAddress,
    });

    if (!result.success) return `**xSOL**: price unavailable — ${result.error}`;

    // Just the price — collateral TVL/ratio/leverage breakdown belongs to the
    // dedicated protocol-health query (isProtocolHealthQuery), not every price
    // check. A plain "what's the price of xSOL" shouldn't get a wall of
    // numbers nobody asked for.
    return `**xSOL/USD** is currently **${result.data.formatted}**`;
  }

  // ── xBTC lever token: (cbBTC collateral value − BTC pool's virtual stablecoin supply) / xBTC supply ──
  if (symbol === 'XBTC') {
    const xBTCAsset = await assetRepository.findBySymbol('XBTC');
    if (!xBTCAsset?.tokenAddress)    return '**xBTC**: xBTC mint not set — add it via `/asset edit XBTC`';
    if (!xBTCAsset.collateralWallet) return '**xBTC**: collateral wallet not set — an admin can set it via `/asset configure XBTC`';

    const result = await queryXBTCPrice({
      collateralWallet: xBTCAsset.collateralWallet,
      xBTCMint: xBTCAsset.tokenAddress,
    });

    if (!result.success) return `**xBTC**: price unavailable — ${result.error}`;

    return `**xBTC/USD** is currently **${result.data.formatted}**`;
  }

  // ── eHYUSD yield-bearing token (formerly sHYUSD — same mint/collateral wallet,
  // same formula): (xSOL + hyUSD value in collateral wallet) / eHYUSD supply ──
  if (symbol === 'EHYUSD') {
    const [hyloSOLAsset, hyUSDAsset, xSOLAsset, eHYUSDAsset] = await Promise.all([
      assetRepository.findBySymbol('HYLOSOL'),
      assetRepository.findBySymbol('HYUSD'),
      assetRepository.findBySymbol('XSOL'),
      assetRepository.findBySymbol('EHYUSD'),
    ]);

    if (!hyloSOLAsset?.tokenAddress)   return '**eHYUSD**: hyloSOL mint not set — add it via `/asset edit HYLOSOL`';
    if (!hyUSDAsset?.tokenAddress)     return '**eHYUSD**: hyUSD mint not set — add it via `/asset edit HYUSD`';
    if (!xSOLAsset?.tokenAddress)      return '**eHYUSD**: xSOL mint not set — add it via `/asset edit XSOL`';
    if (!eHYUSDAsset?.tokenAddress)    return '**eHYUSD**: eHYUSD mint not set — add it via `/asset edit EHYUSD`';
    if (!eHYUSDAsset.collateralWallet) return '**eHYUSD**: collateral wallet not set — an admin can set it via `/asset configure EHYUSD`';

    const stakeAccounts = hyloSOLAsset.stakeVault
      ? hyloSOLAsset.stakeVault.split(',').map((s) => s.trim()).filter(Boolean)
      : (FALLBACK_LST_STAKES['HYLOSOL'] ?? []);

    const result = await queryEHYUSDPrice({
      collateralWallet: eHYUSDAsset.collateralWallet,
      xSOLMint: xSOLAsset.tokenAddress,
      hyUSDMint: hyUSDAsset.tokenAddress,
      eHYUSDMint: eHYUSDAsset.tokenAddress,
      xSOLPriceParams: {
        hyloSOLMint: hyloSOLAsset.tokenAddress,
        hyloSOLStakeAccounts: stakeAccounts,
        xSOLMint: xSOLAsset.tokenAddress,
      },
    });

    if (!result.success) return `**eHYUSD**: price unavailable — ${result.error}`;

    const { formatted, xSOLBalance, xSOLPrice, xSOLValue, hyUSDBalance, hyUSDValue, eHYUSDSupply } = result.data;
    const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
    return [
      `**eHYUSD/USD** is currently **${formatted}**`,
      `  xSOL: **${qty(xSOLBalance)}** × ${usd(xSOLPrice)} = **${usd(xSOLValue)}**`,
      `  hyUSD: **${qty(hyUSDBalance)}** × $1.00 = **${usd(hyUSDValue)}**`,
      `eHYUSD supply: **${qty(eHYUSDSupply)}**`,
    ].join('\n');
  }

  // ── External assets: Jupiter price API ───────────────────────────────────
  const result = await queryPrice(symbol);
  if (!result.success) {
    return `**${symbol}**: price unavailable — ${result.error}`;
  }
  const { formatted, priceChange24hPct } = result.data;
  const change = priceChange24hPct === null ? '' : ` (${priceChange24hPct >= 0 ? '+' : ''}${priceChange24hPct.toFixed(2)}% 24h)`;
  return `**${symbol}/USD** is currently **${formatted}**${change}. (Jupiter)`;
}

async function handlePriceQuery(message: Message, content: string, symbols: string[]) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();
  // All symbols resolved in parallel — no serial bottleneck even for 3+ assets
  const blocks = await Promise.all(symbols.map(resolvePriceBlock));
  const facts = blocks.join('\n\n');
  await message.reply(await composeReply(content, facts));
}

// Maps the PRICE_SYMBOL_MAP key to the DB symbol — only Hylo's own assets
// have a supply we can pair with a live price; external Jupiter-tracked symbols
// (SOL, BTC, ...) have neither a stored mint nor a supply source here.
const MARKET_CAP_DB_SYMBOL: Record<string, string> = {
  HYLOSOL: 'HYLOSOL',
  HYLOSOLPLUS: 'HYLOSOL+',
  HYUSD: 'HYUSD',
  XSOL: 'XSOL',
  EHYUSD: 'EHYUSD',
  XBTC: 'XBTC',
};

async function handleMarketCapQuery(message: Message, content: string, symbols: string[]) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const dbSymbols = [...new Set(symbols.map((s) => MARKET_CAP_DB_SYMBOL[s]).filter((s): s is string => Boolean(s)))];
  if (dbSymbols.length === 0) {
    await message.reply("I can compute market cap for Hylo's own assets (hyloSOL, hyloSOL+, hyUSD, xSOL, xBTC, eHYUSD) — I don't track external token supply data.");
    return;
  }

  const allAssets = await assetRepository.findAll({ activeOnly: true });
  const assetMap = new Map(allAssets.map((a) => [a.symbol, a]));
  const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const lines = await Promise.all(
    dbSymbols.map(async (symbol) => {
      const asset = assetMap.get(symbol);
      if (!asset?.tokenAddress) return `**${symbol}**: mint address not set — an admin can add it via \`/asset edit ${symbol}\``;

      const [price, supplyResult] = await Promise.all([
        resolveAssetPriceUsd(symbol, assetMap),
        queryTokenSupply(asset.tokenAddress),
      ]);

      if (price === null) return `**${symbol}**: price unavailable right now`;
      if (!supplyResult.success) return `**${symbol}**: supply unavailable — ${supplyResult.error}`;

      const marketCap = price * supplyResult.data.uiAmount;
      const supplyStr = supplyResult.data.uiAmount.toLocaleString('en-US', { maximumFractionDigits: 3 });
      return `**${symbol} market cap: ${usd(marketCap)}** (${usd(price)} price × ${supplyStr} supply)`;
    }),
  );

  await message.reply(await composeReply(content, lines.join('\n')));
}

async function handleProtocolHealthQuery(message: Message, content: string) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const [hyloSOLAsset, hyUSDAsset, xSOLAsset] = await Promise.all([
    assetRepository.findBySymbol('HYLOSOL'),
    assetRepository.findBySymbol('HYUSD'),
    assetRepository.findBySymbol('XSOL'),
  ]);

  if (!hyloSOLAsset?.tokenAddress) {
    await message.reply('hyloSOL mint not set — an admin can add it via `/asset edit HYLOSOL`.');
    return;
  }
  if (!hyUSDAsset?.tokenAddress) {
    await message.reply('hyUSD mint not set — an admin can add it via `/asset edit HYUSD`.');
    return;
  }
  if (!xSOLAsset?.tokenAddress) {
    await message.reply('xSOL mint not set — an admin can add it via `/asset edit XSOL`.');
    return;
  }

  const stakeAccounts = hyloSOLAsset.stakeVault
    ? hyloSOLAsset.stakeVault.split(',').map((s) => s.trim()).filter(Boolean)
    : (FALLBACK_LST_STAKES['HYLOSOL'] ?? []);

  const result = await queryXSOLPrice({
    hyloSOLMint: hyloSOLAsset.tokenAddress,
    hyloSOLStakeAccounts: stakeAccounts,
    xSOLMint: xSOLAsset.tokenAddress,
  });

  if (!result.success) {
    await message.reply(`Protocol health metrics unavailable — ${result.error}`);
    return;
  }

  const { collateralTVL, solPoolVirtualStablecoinUsd, collateralRatio, effectiveLeverage } = result.data;
  const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const facts = [
    `**Collateral ratio: ${(collateralRatio * 100).toFixed(1)}%** — indicates the health level of the SOL pool (Collateral TVL ÷ hyUSD backed by this pool).`,
    `**Effective leverage: ${effectiveLeverage.toFixed(2)}x** for xSOL holders right now.`,
    `Collateral TVL: **${usd(collateralTVL)}** · hyUSD backed by SOL pool: **${usd(solPoolVirtualStablecoinUsd)}**`,
  ].join('\n');

  await message.reply(await composeReply(content, facts));
}

async function handleStabilityPoolQuery(message: Message, type: 'OFFLOAD' | 'DEPLOYMENT', limit: number) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const label = type === 'OFFLOAD' ? 'Stability Pool Offload' : 'Stability Pool Deployment';

  const [hyUSDAsset, xSOLAsset] = await Promise.all([
    assetRepository.findBySymbol('HYUSD'),
    assetRepository.findBySymbol('XSOL'),
  ]);
  if (!hyUSDAsset?.tokenAddress || !xSOLAsset?.tokenAddress) {
    await message.reply('hyUSD or xSOL mint not set — an admin can add them via `/asset edit`.');
    return;
  }

  const result = await queryRecentPoolRebalanceEvents(hyUSDAsset.tokenAddress, xSOLAsset.tokenAddress, type, limit);
  if (!result.success) {
    await message.reply(`Couldn't scan the chain for ${label} events — ${result.error}`);
    return;
  }

  const { events, pagesScanned } = result.data;
  if (events.length === 0) {
    await message.reply(`No ${label} events found in the on-chain history I scanned (${pagesScanned} page${pagesScanned === 1 ? '' : 's'} of the stability pool wallet's activity).`);
    return;
  }

  // Same compact style as the live mint-watcher alerts (postRebalanceAlert):
  // "<label>: <flow> ($<usd>) [→](link)", one per line, arrow as the hyperlink.
  const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const usd = (n: number) => ` ($${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  const lines = events.map((e) => {
    const flow =
      type === 'OFFLOAD'
        ? `${qty(e.xSOLAmount)} xSOL to ${qty(e.hyUSDAmount)} hyUSD`
        : `${qty(e.hyUSDAmount)} hyUSD to ${qty(e.xSOLAmount)} xSOL`;
    return `${label}: ${flow}${usd(e.hyUSDAmount)} [→](https://solscan.io/tx/${e.signature})`;
  });

  await message.reply(truncate(lines.join('\n'), 1900));
}

async function handleAssetDetailQuery(
  message: Message,
  asset: {
    id: string;
    symbol: string;
    name: string;
    description: string | null;
    considerations: string | null;
    tokenAddress: string | null;
    category: string | null;
    stakeVault: string | null;
    collateralWallet: string | null;
  },
) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const PRICE_RESOLVER_KEY: Record<string, string> = {
    HYLOSOL: 'HYLOSOL',
    'HYLOSOL+': 'HYLOSOLPLUS',
    HYUSD: 'HYUSD',
    XSOL: 'XSOL',
    EHYUSD: 'EHYUSD',
    XBTC: 'XBTC',
  };
  const priceKey = PRICE_RESOLVER_KEY[asset.symbol.toUpperCase()] ?? null;

  const [xpRows, priceBlock] = await Promise.all([
    venueAssetXPRepository.findByAsset(asset.id),
    priceKey ? resolvePriceBlock(priceKey) : Promise.resolve(null),
  ]);

  const CATEGORY_DISPLAY: Record<string, string> = {
    LST: 'LST',
    STABLECOIN: 'Stablecoin',
    LEVER_TOKEN: 'Lever Token',
    YIELD_BEARING_TOKEN: 'Yield-Bearing Token',
  };

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`${asset.symbol} — ${asset.name}`)
    .setTimestamp();

  const metaParts: string[] = [];
  if (asset.category) metaParts.push(`**${CATEGORY_DISPLAY[asset.category] ?? asset.category}**`);
  if (asset.tokenAddress) metaParts.push(`[Solscan](https://solscan.io/token/${asset.tokenAddress})`);
  if (metaParts.length) embed.setDescription(metaParts.join('  ·  '));

  if (asset.description) {
    embed.addFields({ name: 'About', value: asset.description.slice(0, 1024), inline: false });
  }

  if (priceBlock) {
    embed.addFields({ name: 'Current Price', value: priceBlock.slice(0, 1024), inline: false });
  }

  if (asset.considerations) {
    embed.addFields({ name: 'Considerations', value: asset.considerations.slice(0, 1024), inline: false });
  }

  if (xpRows.length > 0) {
    const lines = xpRows.map((r) => {
      const xp = `${r.xpRate}${r.notes ? ` — ${r.notes}` : ''}`;
      const link = r.venue.link ? ` · [Go](${r.venue.link})` : '';
      return `• **${r.venue.name}**: ${xp}${link}`;
    });
    embed.addFields({
      name: `XP by Venue (${xpRows.length})`,
      value: lines.join('\n').slice(0, 1024),
      inline: false,
    });
  } else {
    embed.addFields({
      name: 'Venues',
      value: '_No venues have been configured for this asset yet._',
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

async function handleMultiTokenAddressLookup(
  message: Message,
  assets: Array<{ symbol: string; name: string; tokenAddress: string | null }>,
) {
  const lines = assets.map((a) => {
    if (!a.tokenAddress) return `**${a.symbol}** (${a.name}): _no address stored yet — an admin can add it via \`/asset edit\`_`;
    const url = `https://solscan.io/token/${a.tokenAddress}`;
    return `**${a.symbol}** (${a.name}):\n[\`${a.tokenAddress}\`](${url})`;
  });
  await message.reply(lines.join('\n\n'));
}

async function handleOnchainQuery(
  message: Message,
  content: string,
  symbol: string,
  assetName: string,
  mintAddress: string,
  queryType: OnchainQueryType,
) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const solscanUrl = `https://solscan.io/token/${mintAddress}`;

  if (queryType === 'supply') {
    const result = await queryTokenSupply(mintAddress);
    if (!result.success) {
      await message.reply(`Couldn't fetch supply for **${symbol}** right now.\n> ${result.error}`);
      return;
    }
    // Just the number asked for — decimals, raw amount, and the solscan link
    // are extra detail the customer can ask for if they actually want it.
    const facts = `The total supply of **${symbol}** (${assetName}) is **${result.data.formatted}**.`;
    await message.reply(await composeReply(content, facts));
    return;
  }

  if (queryType === 'holders') {
    const result = await queryTokenHolders(mintAddress);
    if (!result.success) {
      await message.reply(`Couldn't fetch holder count for **${symbol}** right now.\n> ${result.error}`);
      return;
    }
    const facts = `**${symbol}** (${assetName}) currently has **${result.data.formatted}** holder${result.data.total !== 1 ? 's' : ''}.`;
    await message.reply(await composeReply(content, facts));
    return;
  }

  // activity — recent transactions / mints / burns
  const result = await queryTokenActivity(mintAddress, 10);
  if (!result.success) {
    await message.reply(`Couldn't fetch recent activity for **${symbol}** right now.\n> ${result.error}`);
    return;
  }
  const txs = result.data.signatures;
  if (txs.length === 0) {
    await message.reply(`No recent on-chain activity found for **${symbol}**.\n\n${solscanUrl}`);
    return;
  }
  const successCount = txs.filter((t) => !t.err).length;
  const newest = txs[0]?.blockTime
    ? Math.round((Date.now() / 1000 - txs[0].blockTime) / 60)
    : null;
  const oldest = txs[txs.length - 1]?.blockTime
    ? Math.round((Date.now() / 1000 - txs[txs.length - 1]!.blockTime!) / 60)
    : null;
  const facts = [
    `**${symbol}** (${assetName}) — last ${txs.length} on-chain transactions:`,
    `${successCount} succeeded · ${txs.length - successCount} failed`,
    newest !== null ? `Most recent: ~${newest} min ago` : null,
    oldest !== null ? `Oldest in sample: ~${oldest} min ago` : null,
    `\n${solscanUrl}`,
  ].filter(Boolean).join('\n');
  await message.reply(await composeReply(content, facts));
}

async function handleRewrite(message: Message, content: string) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();
  const response = await aiService.generate(buildRewritePrompt({ text: content }));
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('Rewritten')
    .setDescription(response.text)
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

/**
 * Composes a fresh customer-facing statement from a stated reason/fact,
 * rather than rewriting text the agent already gave — grounded in whichever
 * bot message this is a reply to (the usual case: the agent just got an
 * explanation from the bot and wants it turned into something they can send
 * on to the actual customer) and/or matching FAQ entries, never invented.
 */
async function handleComposeStatement(message: Message, content: string, replyContext: ReplyContext | null) {
  if ('sendTyping' in message.channel) void message.channel.sendTyping();

  const priorContext = replyContext
    ? replyContext.originalQuestion
      ? `Customer originally asked: "${replyContext.originalQuestion}"\nBot answered: "${truncateForContext(replyContext.botReply)}"`
      : `Prior bot message in this thread: "${truncateForContext(replyContext.botReply)}"`
    : null;

  const searchResults = await searchService.search(content, message.author.id, 3);
  const faqContext = searchResults.length > 0
    ? searchResults.map((r) => `${r.title}: ${r.answer}`).join('\n\n')
    : null;

  const response = await aiService.generate(buildComposeStatementPrompt({ instruction: content, priorContext, faqContext }));

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('Drafted Statement')
    .setDescription(safeEmbedText(response.text))
    .setTimestamp();
  const sent = await message.reply({ embeds: [embed] });
  recordAnswer(sent.id, content);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateForContext(text: string, max = 600): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/**
 * Splits a wall-of-text reply into readable paragraphs.
 * Only activates when the text has no existing line breaks and is long enough
 * to warrant paragraph splitting. Groups sentences in pairs separated by \n\n.
 * Preserves any text that already contains newlines (bullet lists, markdown, etc.).
 */
function expandInlineList(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"'])/);
  let changed = false;

  const processed = sentences.map((sentence) => {
    if ((sentence.match(/,/g) ?? []).length < 2) return sentence;

    // Match intro phrase ending with a list introducer, then the enumerated items
    const m = sentence.match(
      /^(.*?(?:\b(?:include|includes|consist of|consists of|such as)|\s*:))\s+(.+?)[.!?]?$/si,
    );
    if (!m) return sentence;

    const [, intro, rest] = m;
    const restClean = (rest ?? '').replace(/[.!?]$/, '').trim();
    // Normalise ", and X" / " and X" at the tail into a plain comma item
    const normalized = restClean.replace(/,?\s+and\s+([^,]+)$/, ',$1');
    const items = normalized.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    if (items.length < 3) return sentence;

    changed = true;
    return `${(intro ?? '').trim()}:\n${items.map((item) => `• ${item}`).join('\n')}`;
  });

  if (!changed) return text;
  return processed.join('\n\n');
}

function autoparagraph(text: string): string {
  // Pass 1 — convert inline comma-separated enumerations into bullet lists
  const expanded = expandInlineList(text);
  if (expanded !== text) return expanded;

  // Already has structure — leave it alone
  if (text.includes('\n')) return text;
  // Short answers look fine as a single block
  if (text.length < 200) return text;

  // Split at sentence boundaries: after . ! ? when followed by whitespace + capital
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"'])/);
  if (sentences.length < 3) return text;

  // Pair sentences into paragraphs of 2
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const chunk = sentences.slice(i, i + 2).join(' ').trim();
    if (chunk) paragraphs.push(chunk);
  }
  return paragraphs.join('\n\n');
}
