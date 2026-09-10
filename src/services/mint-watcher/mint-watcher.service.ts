/**
 * Background mint watcher — polls every tracked Hylo asset for new mint
 * events and posts an alert to a configured Discord channel.
 *
 * Runs as a self-scheduling loop (see loop()) alongside the Discord client —
 * deliberately not setInterval, since that could fire the next tick before a
 * slow one finishes and double-post every event. Every tick is wrapped in a
 * top-level try/catch: a failure here must never throw past tick() and
 * crash the whole bot process via the global unhandledRejection handler.
 */
import type { Client } from 'discord.js';
import type { Asset } from '@prisma/client';
import { config } from '@/config/index.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { mintFlowRepository } from '@/db/repositories/mint-flow.repository.js';
import {
  queryMintEvents,
  queryBurnEvents,
  queryStakeEvents,
  queryPoolRebalanceEvents,
  queryTokenSupply,
  querySignaturesSince,
  queryTokenActivity,
  classifyTransaction,
  HYLO_STABILITY_POOL_WALLET,
  type RebalanceEvent,
  type RebalanceDirection,
} from '@/services/onchain/helius.service.js';
import { resolveAssetPriceUsd } from '@/services/price/asset-price.service.js';
import {
  getActivityPage,
  markFeedSuccess,
  markFeedFailure,
  feedUsable,
  type ActivityEvent,
} from '@/services/hylo-api/hylo-api.service.js';
import { mapFeedEventsToActions, type FeedAction } from './feed-events.js';
import { getSendableChannel, type SendableChannel } from '@/lib/discord-utils.js';
import { checkEHYUSDCapMilestone } from './ehyusd-cap-watcher.service.js';
import { twitterService } from '@/services/twitter/twitter.service.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('mint-watcher');

const POLL_INTERVAL_MS = 60_000;

// Decimals are immutable for a given mint — fetch once, reuse for the life
// of the process instead of re-querying every tick.
const decimalsCache = new Map<string, number>();

// In-memory only, by design: this is informational monitoring, not an
// accounting ledger. Starting empty on every process boot means a restart
// always seeds fresh from "now" rather than trying to catch up on whatever
// happened during downtime — there's nothing to read back, so there's
// nothing to backfill.
const checkpoints = new Map<string, string>();
// Same idea, tracked separately since burns are polled independently of mints.
const burnCheckpoints = new Map<string, string>();

/** Best-effort ledger write for the daily summary — a DB hiccup here must never take down the tick. */
async function recordFlow(symbol: string, kind: 'MINT' | 'BURN', amount: number): Promise<void> {
  try {
    await mintFlowRepository.record(symbol, kind, amount);
  } catch (err) {
    logger.warn({ err, symbol, kind, amount }, 'Failed to record flow event — daily summary will undercount this one');
  }
}

/**
 * Converts a raw base-unit amount to its UI-decimal amount. Returns null —
 * never the raw integer — when decimals couldn't be resolved: using the raw
 * amount as if it were already UI-scaled inflates it by up to 10^decimals×.
 * Observed happening for real: a single XBTC mint (decimals=6) got recorded
 * as ~4.27 BILLION tokens — its true amount, ~4,271.67, times 10^6 — and
 * corrupted a daily summary. Skipping a mis-scaled event is far safer than
 * recording or posting one at the wrong magnitude.
 */
function toUiAmount(rawAmount: number, decimals: number | null, context: Record<string, unknown>): number | null {
  if (decimals === null) {
    logger.error({ ...context, rawAmount }, 'Decimals unavailable — skipping this event rather than recording it at the wrong scale');
    return null;
  }
  return rawAmount / 10 ** decimals;
}

async function getDecimals(mintAddress: string): Promise<number | null> {
  const cached = decimalsCache.get(mintAddress);
  if (cached !== undefined) return cached;
  const result = await queryTokenSupply(mintAddress);
  if (!result.success) return null;
  decimalsCache.set(mintAddress, result.data.decimals);
  return result.data.decimals;
}

function fmtQty(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Exact total value to 2 decimal places, e.g. " ($5.54)" — no rounding to whole dollars. Empty string when price is unknown. */
function fmtUsdTotal(amount: number, price: number | null): string {
  if (price === null) return '';
  return ` ($${(amount * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
}

/**
 * MIN_VAL_REPORT gates whether an alert gets POSTED, not whether it counts
 * toward the tick's eventsFound/signaturesChecked — those stay as ground
 * truth of what happened on-chain regardless of the value filter, and it
 * never affects the daily summary ledger either (see recordFlow, called
 * unconditionally before this check runs). An unknown price can't be
 * compared against the threshold, so it always reports rather than risking
 * a large mint going silent because a price lookup happened to fail.
 */
function meetsReportThreshold(amount: number, price: number | null): boolean {
  if (price === null) return true;
  return amount * price >= config.mintAlerts.minValueUsd;
}

async function getMintAlertsChannel(client: Client): Promise<SendableChannel | null> {
  const channelId = config.mintAlerts.channelId;
  if (!channelId) return null;
  return getSendableChannel(client, channelId);
}

/** Emoji + trailing space for a known symbol, or '' if that asset has no emoji configured (Asset.emoji). */
function emojiPrefix(symbol: string, assetMap: Map<string, Asset>): string {
  const emoji = assetMap.get(symbol)?.emoji;
  return emoji ? `${emoji} ` : '';
}

/** Same compact style as the eHYUSD stake alert: "<amount> <symbol> ($<usd>) Minted [→](link)". */
async function postMintAlert(client: Client, symbol: string, event: { signature: string }, amount: number, price: number | null, assetMap: Map<string, Asset>): Promise<void> {
  const channel = await getMintAlertsChannel(client);
  if (!channel) return;
  await channel.send(`${emojiPrefix(symbol, assetMap)}${fmtQty(amount)} ${symbol}${fmtUsdTotal(amount, price)} Minted [→](https://solscan.io/tx/${event.signature})`);
}

/**
 * eHYUSD gets its own verb rather than the generic mint alert — minting
 * eHYUSD IS staking hyUSD in Hylo's system, so "100 eHYUSD ($140) Staked"
 * reads more directly than "100 eHYUSD Minted". Same format otherwise.
 */
async function postStakeAlert(client: Client, event: { eHYUSDNetAmount: number; signature: string }, price: number | null, assetMap: Map<string, Asset>): Promise<void> {
  const channel = await getMintAlertsChannel(client);
  if (!channel) return;
  const amountStr = event.eHYUSDNetAmount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  await channel.send(`${emojiPrefix('EHYUSD', assetMap)}${amountStr} eHYUSD${fmtUsdTotal(event.eHYUSDNetAmount, price)} Staked [→](https://solscan.io/tx/${event.signature})`);
}

/**
 * "Stability Pool Offload: <xSOL> xSOL to <hyUSD> hyUSD ($<usd>)" (pool
 * unwinding xSOL back to hyUSD) or the reverse direction for "Deployment"
 * (pool deploying hyUSD into xSOL). USD value comes from the hyUSD side at
 * its fixed $1 peg either way. The emoji leads with the asset the pool ends
 * up holding more of — hyUSD for an Offload, xSOL for a Deployment.
 */
async function postRebalanceAlert(
  client: Client,
  type: RebalanceDirection,
  signature: string,
  xSOLAmount: number,
  hyUSDAmount: number,
  assetMap: Map<string, Asset>,
): Promise<void> {
  const channel = await getMintAlertsChannel(client);
  if (!channel) return;
  const label = type === 'OFFLOAD' ? 'Stability Pool Offload' : 'Stability Pool Deployment';
  const flow =
    type === 'OFFLOAD'
      ? `${fmtQty(xSOLAmount)} xSOL to ${fmtQty(hyUSDAmount)} hyUSD`
      : `${fmtQty(hyUSDAmount)} hyUSD to ${fmtQty(xSOLAmount)} xSOL`;
  const emoji = emojiPrefix(type === 'OFFLOAD' ? 'HYUSD' : 'XSOL', assetMap);
  await channel.send(`${emoji}${label}: ${flow}${fmtUsdTotal(hyUSDAmount, 1)} [→](https://solscan.io/tx/${signature})`);
}

/**
 * Shared processing for both rebalance directions: decide whether each
 * detected event clears MIN_VAL_REPORT and post an alert for it. Nothing is
 * persisted — the "last N" DM query reads the chain directly instead.
 */
async function processRebalanceEvents(
  client: Client,
  type: RebalanceDirection,
  events: RebalanceEvent[],
  mintedIsXSOL: boolean,
  hyUSDDecimals: number | null,
  xSOLDecimals: number | null,
  assetMap: Map<string, Asset>,
): Promise<void> {
  for (const event of events) {
    const mintedUi = toUiAmount(event.mintedAmount, mintedIsXSOL ? xSOLDecimals : hyUSDDecimals, { type, signature: event.signature, leg: 'minted' });
    const burnedUi = toUiAmount(event.burnedAmount, mintedIsXSOL ? hyUSDDecimals : xSOLDecimals, { type, signature: event.signature, leg: 'burned' });
    if (mintedUi === null || burnedUi === null) continue;
    const xSOLAmount = mintedIsXSOL ? mintedUi : burnedUi;
    const hyUSDAmount = mintedIsXSOL ? burnedUi : mintedUi;

    if (!meetsReportThreshold(hyUSDAmount, 1)) {
      logger.debug({ type, hyUSDAmount, xSOLAmount, signature: event.signature }, 'Rebalance below MIN_VAL_REPORT — not posted');
      continue;
    }
    await postRebalanceAlert(client, type, event.signature, xSOLAmount, hyUSDAmount, assetMap);
    logger.info({ type, hyUSDAmount, xSOLAmount, signature: event.signature }, 'Rebalance alert posted');
  }
}

async function tickGenericMintAsset(client: Client, asset: Asset, assetMap: Map<string, Asset>): Promise<void> {
  const lastMintSignature = checkpoints.get(asset.symbol) ?? null;
  const mintResult = await queryMintEvents(asset.tokenAddress!, lastMintSignature);
  const lastBurnSignature = burnCheckpoints.get(asset.symbol) ?? null;
  const burnResult = await queryBurnEvents(asset.tokenAddress!, lastBurnSignature);

  if (!mintResult.success) {
    // Logged server-side only — a failed check isn't worth a Discord message,
    // it's usually a transient RPC hiccup that clears up on the next tick.
    logger.warn({ symbol: asset.symbol, error: mintResult.error }, 'Mint check failed');
  }
  if (!burnResult.success) {
    logger.warn({ symbol: asset.symbol, error: burnResult.error }, 'Burn check failed');
  }
  if (!mintResult.success && !burnResult.success) return;

  const events = mintResult.success ? mintResult.data.events : [];
  const burnEvents = burnResult.success ? burnResult.data.events : [];

  logger.debug(
    {
      symbol: asset.symbol,
      eventsFound: events.length,
      burnsFound: burnEvents.length,
      ...(events.length > 0 && { signatures: events.map((e) => e.signature) }),
    },
    'Mint/burn check complete',
  );

  if (events.length > 0 || burnEvents.length > 0) {
    const decimals = await getDecimals(asset.tokenAddress!);
    const price = await resolveAssetPriceUsd(asset.symbol, assetMap);

    for (const event of events) {
      const amount = toUiAmount(event.amount, decimals, { symbol: asset.symbol, signature: event.signature, kind: 'MINT' });
      if (amount === null) continue;
      await recordFlow(asset.symbol, 'MINT', amount);
      if (!meetsReportThreshold(amount, price)) {
        logger.debug({ symbol: asset.symbol, amount, price, signature: event.signature }, 'Mint below MIN_VAL_REPORT — not posted');
        continue;
      }
      await postMintAlert(client, asset.symbol, event, amount, price, assetMap);
      logger.info({ symbol: asset.symbol, amount, signature: event.signature }, 'Mint alert posted');
    }

    // No live alert for burns — the daily summary is the only place these surface.
    for (const event of burnEvents) {
      const amount = toUiAmount(event.amount, decimals, { symbol: asset.symbol, signature: event.signature, kind: 'BURN' });
      if (amount === null) continue;
      await recordFlow(asset.symbol, 'BURN', amount);
    }
  }

  if (mintResult.success && mintResult.data.newestSignature) {
    checkpoints.set(asset.symbol, mintResult.data.newestSignature);
  }
  if (burnResult.success && burnResult.data.newestSignature) {
    burnCheckpoints.set(asset.symbol, burnResult.data.newestSignature);
  }
}

/**
 * hyUSD is special-cased like eHYUSD: alongside normal user mints, the
 * Stability Pool can burn its own xSOL and mint the hyUSD back to itself in
 * the same transaction (see queryPoolRebalanceEvents) — that's a distinct
 * "Offload" report, not a generic mint alert.
 */
async function tickHyUSDAsset(client: Client, hyUSDAsset: Asset, assetMap: Map<string, Asset>): Promise<void> {
  const xSOL = assetMap.get('XSOL');
  if (!xSOL?.tokenAddress || !hyUSDAsset.tokenAddress) {
    logger.warn({ symbol: 'HYUSD' }, 'hyUSD or xSOL mint not fully configured — skipping');
    return;
  }

  const lastSignature = checkpoints.get('HYUSD') ?? null;
  const result = await queryPoolRebalanceEvents(hyUSDAsset.tokenAddress, xSOL.tokenAddress, lastSignature);

  // Generic hyUSD burns (redemptions) — excludes Stability Pool wallet burns,
  // which are already captured (paired with their xSOL mint) as an Offload above.
  const lastBurnSignature = burnCheckpoints.get('HYUSD') ?? null;
  const burnResult = await queryBurnEvents(hyUSDAsset.tokenAddress, lastBurnSignature, { excludeStabilityPoolWallet: true });

  if (!result.success) {
    logger.warn({ symbol: 'HYUSD', error: result.error }, 'hyUSD check failed');
    return;
  }
  if (!burnResult.success) {
    logger.warn({ symbol: 'HYUSD', error: burnResult.error }, 'hyUSD burn check failed');
  }

  const { mintEvents, rebalanceEvents, newestSignature, signaturesChecked } = result.data;
  const burnEvents = burnResult.success ? burnResult.data.events : [];
  const hyUSDEventSignatures = [...mintEvents, ...rebalanceEvents].map((e) => e.signature);
  logger.debug(
    {
      symbol: 'HYUSD',
      signaturesChecked,
      mintsFound: mintEvents.length,
      burnsFound: burnEvents.length,
      offloadsFound: rebalanceEvents.length,
      ...(hyUSDEventSignatures.length > 0 && { signatures: hyUSDEventSignatures }),
    },
    'hyUSD check complete',
  );

  if (mintEvents.length > 0 || burnEvents.length > 0) {
    const decimals = await getDecimals(hyUSDAsset.tokenAddress);
    const price = await resolveAssetPriceUsd('HYUSD', assetMap);

    for (const event of mintEvents) {
      const amount = toUiAmount(event.amount, decimals, { symbol: 'HYUSD', signature: event.signature, kind: 'MINT' });
      if (amount === null) continue;
      await recordFlow('HYUSD', 'MINT', amount);
      if (!meetsReportThreshold(amount, price)) {
        logger.debug({ symbol: 'HYUSD', amount, price, signature: event.signature }, 'Mint below MIN_VAL_REPORT — not posted');
        continue;
      }
      await postMintAlert(client, 'HYUSD', event, amount, price, assetMap);
      logger.info({ symbol: 'HYUSD', amount, signature: event.signature }, 'Mint alert posted');
    }

    for (const event of burnEvents) {
      const amount = toUiAmount(event.amount, decimals, { symbol: 'HYUSD', signature: event.signature, kind: 'BURN' });
      if (amount === null) continue;
      await recordFlow('HYUSD', 'BURN', amount);
    }
  }

  if (rebalanceEvents.length > 0) {
    const [hyUSDDecimals, xSOLDecimals] = await Promise.all([getDecimals(hyUSDAsset.tokenAddress), getDecimals(xSOL.tokenAddress)]);
    // mintedAmount is hyUSD here (we scanned the hyUSD mint) — Offload.
    await processRebalanceEvents(client, 'OFFLOAD', rebalanceEvents, false, hyUSDDecimals, xSOLDecimals, assetMap);

    // Ledger gets every rebalance regardless of MIN_VAL_REPORT — an Offload mints
    // hyUSD and burns xSOL.
    for (const event of rebalanceEvents) {
      const hyUSDAmount = toUiAmount(event.mintedAmount, hyUSDDecimals, { symbol: 'HYUSD', signature: event.signature, leg: 'minted' });
      const xSOLAmount = toUiAmount(event.burnedAmount, xSOLDecimals, { symbol: 'XSOL', signature: event.signature, leg: 'burned' });
      if (hyUSDAmount === null || xSOLAmount === null) continue;
      await recordFlow('HYUSD', 'MINT', hyUSDAmount);
      await recordFlow('XSOL', 'BURN', xSOLAmount);
    }
  }

  if (newestSignature) {
    checkpoints.set('HYUSD', newestSignature);
  }
  if (burnResult.success && burnResult.data.newestSignature) {
    burnCheckpoints.set('HYUSD', burnResult.data.newestSignature);
  }
}

/**
 * xSOL is special-cased the same way: the Stability Pool can also deploy its
 * own hyUSD into xSOL (burn hyUSD, mint xSOL to itself) — the reverse
 * direction, "Deployment".
 */
async function tickXSOLAsset(client: Client, xSOLAsset: Asset, assetMap: Map<string, Asset>): Promise<void> {
  const hyUSD = assetMap.get('HYUSD');
  if (!hyUSD?.tokenAddress || !xSOLAsset.tokenAddress) {
    logger.warn({ symbol: 'XSOL' }, 'xSOL or hyUSD mint not fully configured — skipping');
    return;
  }

  const lastSignature = checkpoints.get('XSOL') ?? null;
  const result = await queryPoolRebalanceEvents(xSOLAsset.tokenAddress, hyUSD.tokenAddress, lastSignature);

  // Generic xSOL burns (redemptions) — excludes Stability Pool wallet burns,
  // which are already captured (paired with their hyUSD mint) as a Deployment above.
  const lastBurnSignature = burnCheckpoints.get('XSOL') ?? null;
  const burnResult = await queryBurnEvents(xSOLAsset.tokenAddress, lastBurnSignature, { excludeStabilityPoolWallet: true });

  if (!result.success) {
    logger.warn({ symbol: 'XSOL', error: result.error }, 'xSOL check failed');
    return;
  }
  if (!burnResult.success) {
    logger.warn({ symbol: 'XSOL', error: burnResult.error }, 'xSOL burn check failed');
  }

  const { mintEvents, rebalanceEvents, newestSignature, signaturesChecked } = result.data;
  const burnEvents = burnResult.success ? burnResult.data.events : [];
  const xSOLEventSignatures = [...mintEvents, ...rebalanceEvents].map((e) => e.signature);
  logger.debug(
    {
      symbol: 'XSOL',
      signaturesChecked,
      mintsFound: mintEvents.length,
      burnsFound: burnEvents.length,
      deploymentsFound: rebalanceEvents.length,
      ...(xSOLEventSignatures.length > 0 && { signatures: xSOLEventSignatures }),
    },
    'xSOL check complete',
  );

  if (mintEvents.length > 0 || burnEvents.length > 0) {
    const decimals = await getDecimals(xSOLAsset.tokenAddress);
    const price = await resolveAssetPriceUsd('XSOL', assetMap);

    for (const event of mintEvents) {
      const amount = toUiAmount(event.amount, decimals, { symbol: 'XSOL', signature: event.signature, kind: 'MINT' });
      if (amount === null) continue;
      await recordFlow('XSOL', 'MINT', amount);
      if (!meetsReportThreshold(amount, price)) {
        logger.debug({ symbol: 'XSOL', amount, price, signature: event.signature }, 'Mint below MIN_VAL_REPORT — not posted');
        continue;
      }
      await postMintAlert(client, 'XSOL', event, amount, price, assetMap);
      logger.info({ symbol: 'XSOL', amount, signature: event.signature }, 'Mint alert posted');
    }

    for (const event of burnEvents) {
      const amount = toUiAmount(event.amount, decimals, { symbol: 'XSOL', signature: event.signature, kind: 'BURN' });
      if (amount === null) continue;
      await recordFlow('XSOL', 'BURN', amount);
    }
  }

  if (rebalanceEvents.length > 0) {
    const [hyUSDDecimals, xSOLDecimals] = await Promise.all([getDecimals(hyUSD.tokenAddress), getDecimals(xSOLAsset.tokenAddress)]);
    // mintedAmount is xSOL here (we scanned the xSOL mint) — Deployment.
    await processRebalanceEvents(client, 'DEPLOYMENT', rebalanceEvents, true, hyUSDDecimals, xSOLDecimals, assetMap);

    // Ledger gets every rebalance regardless of MIN_VAL_REPORT — a Deployment mints
    // xSOL and burns hyUSD.
    for (const event of rebalanceEvents) {
      const xSOLAmount = toUiAmount(event.mintedAmount, xSOLDecimals, { symbol: 'XSOL', signature: event.signature, leg: 'minted' });
      const hyUSDAmount = toUiAmount(event.burnedAmount, hyUSDDecimals, { symbol: 'HYUSD', signature: event.signature, leg: 'burned' });
      if (xSOLAmount === null || hyUSDAmount === null) continue;
      await recordFlow('XSOL', 'MINT', xSOLAmount);
      await recordFlow('HYUSD', 'BURN', hyUSDAmount);
    }
  }

  if (newestSignature) {
    checkpoints.set('XSOL', newestSignature);
  }
  if (burnResult.success && burnResult.data.newestSignature) {
    burnCheckpoints.set('XSOL', burnResult.data.newestSignature);
  }
}

/**
 * eHYUSD is special-cased: a raw mintTo instruction isn't enough to know who
 * actually staked (aggregator routing, flash resells) — see queryStakeEvents.
 */
async function tickStakeAsset(client: Client, eHYUSDAsset: Asset, assetMap: Map<string, Asset>): Promise<void> {
  const hyUSD = assetMap.get('HYUSD');
  if (!hyUSD?.tokenAddress || !eHYUSDAsset.tokenAddress || !eHYUSDAsset.collateralWallet) {
    logger.warn({ symbol: 'EHYUSD' }, 'hyUSD mint, eHYUSD mint, or stake wallet not fully configured — skipping');
    return;
  }

  const lastSignature = checkpoints.get('EHYUSD') ?? null;
  const result = await queryStakeEvents(eHYUSDAsset.tokenAddress, hyUSD.tokenAddress, eHYUSDAsset.collateralWallet, lastSignature);

  if (!result.success) {
    logger.warn({ symbol: 'EHYUSD', error: result.error }, 'Stake check failed');
    return;
  }

  const { events, newestSignature, signaturesChecked } = result.data;
  logger.debug(
    {
      symbol: 'EHYUSD',
      signaturesChecked,
      eventsFound: events.length,
      ...(events.length > 0 && { signatures: events.map((e) => e.signature) }),
    },
    'Stake check complete',
  );

  if (events.length > 0) {
    const price = await resolveAssetPriceUsd('EHYUSD', assetMap);
    for (const event of events) {
      if (!meetsReportThreshold(event.eHYUSDNetAmount, price)) {
        logger.debug(
          { symbol: 'EHYUSD', amount: event.eHYUSDNetAmount, price, signature: event.signature },
          'Stake below MIN_VAL_REPORT — not posted',
        );
        continue;
      }
      await postStakeAlert(client, event, price, assetMap);
      logger.info(
        { symbol: 'EHYUSD', amount: event.eHYUSDNetAmount, beneficiary: event.beneficiary, signature: event.signature },
        'Stake alert posted',
      );
    }
  }

  if (newestSignature) {
    checkpoints.set('EHYUSD', newestSignature);
  }
}

// ─── v1-API event path (primary) ──────────────────────────────────────────────
// Alerts and the mint/burn ledger are sourced from Hylo's own indexed event
// feed (GET /v1/protocol/activity) — one HTTP call per tick replaces the
// per-mint getSignaturesForAddress polling plus per-signature getTransaction
// fetches the per-asset scanners above run every cycle. Those scanners are
// kept verbatim (tickViaRpc) as the automatic fallback:
//
//  - 3 consecutive feed fetch failures → tickViaRpc until a feed fetch
//    succeeds again. Both paths' checkpoints seed fresh without backfilling,
//    so a flip is exactly as safe as a process restart has always been.
//  - feed quiet for >10 min → one cheap RPC probe compares the chain's newest
//    hyUSD-mint signature against the feed's newest event; the feed trailing
//    real activity by >10 min also flips to RPC (a stalled indexer must not
//    silently stop alerts).
//  - HYLO_V1_EVENTS_DISABLED=1 forces RPC mode permanently (kill switch).
//
// Two things stay on RPC while the feed path is active, both deliberate:
//  - hyloSOL / hyloSOL+ mint watching: the feed does not index LST staking.
//  - Stability Pool Offload/Deployment: no dedicated feed event type yet, so
//    a light watcher on the pool wallet's own signature history (1 scan/tick)
//    classifies new transactions with the same rules as tickHyUSDAsset /
//    tickXSOLAsset applied before.

const FEED_PAGE_LIMIT = 100;
const FEED_MAX_CHASE_PAGES = 2;
const FEED_STALE_PROBE_MS = 10 * 60_000;
const FEED_MAX_CHAIN_LAG_MS = 10 * 60_000;
const FEED_SEEN_CAP = 5_000;

const feedSeenKeys = new Set<string>();
let feedSeeded = false;
let feedNewestEventMs: number | null = null;
let poolWalletCheckpoint: string | null = null;
let usingRpcFallback = false;

function feedEventKey(e: ActivityEvent): string {
  return `${e.signature}:${e.eventIndex}`;
}

function pruneFeedSeen(): void {
  if (feedSeenKeys.size <= FEED_SEEN_CAP) return;
  const excess = feedSeenKeys.size - FEED_SEEN_CAP;
  let removed = 0;
  for (const key of feedSeenKeys) {
    if (removed >= excess) break;
    feedSeenKeys.delete(key);
    removed++;
  }
}

/** Returns false when the feed fetch failed (caller decides on RPC fallback). */
async function tickViaFeed(client: Client, assets: Asset[], assetMap: Map<string, Asset>): Promise<boolean> {
  const first = await getActivityPage({ limit: FEED_PAGE_LIMIT });
  if (!first.ok) {
    markFeedFailure(first.error);
    return false;
  }
  markFeedSuccess();

  const all: ActivityEvent[] = [...(first.data.events ?? [])];

  if (!feedSeeded) {
    // First run: checkpoint at "now" WITHOUT replaying history — the same
    // no-backfill semantics the RPC scanners have always had on boot.
    for (const e of all) feedSeenKeys.add(feedEventKey(e));
    feedSeeded = true;
    feedNewestEventMs = all[0] ? Date.parse(all[0].blockTime) : null;
    logger.info({ seeded: all.length }, 'Hylo API feed checkpoint seeded — alerting from now');
    return true;
  }

  // A full page whose oldest event is still unseen means more happened between
  // ticks than one page holds — chase a couple of cursor pages before giving
  // up (the RPC path's equivalent is its one-page gap resync).
  let lastPageCount = all.length;
  let chaseCursor = first.data.cursor ?? null;
  let chased = 0;
  while (lastPageCount === FEED_PAGE_LIMIT && chaseCursor && chased < FEED_MAX_CHASE_PAGES) {
    const oldest = all[all.length - 1];
    if (oldest && feedSeenKeys.has(feedEventKey(oldest))) break; // overlapped already-seen history
    const next = await getActivityPage({ limit: FEED_PAGE_LIMIT, before: chaseCursor });
    if (!next.ok) break;
    all.push(...(next.data.events ?? []));
    lastPageCount = next.data.events?.length ?? 0;
    chaseCursor = next.data.cursor ?? null;
    chased++;
  }

  const fresh = all.filter((e) => !feedSeenKeys.has(feedEventKey(e)));
  for (const e of all) feedSeenKeys.add(feedEventKey(e));
  pruneFeedSeen();
  if (all[0]) feedNewestEventMs = Math.max(feedNewestEventMs ?? 0, Date.parse(all[0].blockTime));

  if (lastPageCount === FEED_PAGE_LIMIT && chased >= FEED_MAX_CHASE_PAGES && fresh.length > 0) {
    logger.warn({ fresh: fresh.length }, 'Feed burst deeper than chase depth — older events skipped (same resync semantics as the RPC path)');
  }

  if (fresh.length === 0) return true;

  const ordered = [...fresh].sort((a, b) => (a.slot - b.slot) || (a.eventIndex - b.eventIndex));
  const actions = mapFeedEventsToActions(ordered);
  await reportFeedActions(client, actions, assetMap);
  return true;
}

/** Applies mapped feed actions: mints → threshold-gated alert + ledger, burns → ledger only, stakes → alert. */
async function reportFeedActions(client: Client, actions: FeedAction[], assetMap: Map<string, Asset>): Promise<void> {
  for (const action of actions) {
    try {
      if (action.kind === 'mint') {
        const price = await resolveAssetPriceUsd(action.symbol, assetMap);
        await recordFlow(action.symbol, 'MINT', action.amount);
        if (!meetsReportThreshold(action.amount, price)) {
          logger.debug({ symbol: action.symbol, amount: action.amount, price, signature: action.signature }, 'Feed mint below MIN_VAL_REPORT — not posted');
          continue;
        }
        await postMintAlert(client, action.symbol, { signature: action.signature }, action.amount, price, assetMap);
        logger.info({ symbol: action.symbol, amount: action.amount, signature: action.signature }, 'Mint alert posted (Hylo API feed)');
      } else if (action.kind === 'burn') {
        // No live alert for burns — the daily summary is the only surface (unchanged).
        await recordFlow(action.symbol, 'BURN', action.amount);
      } else {
        const price = await resolveAssetPriceUsd('EHYUSD', assetMap);
        if (!meetsReportThreshold(action.amount, price)) {
          logger.debug({ amount: action.amount, price, signature: action.signature }, 'Feed stake below MIN_VAL_REPORT — not posted');
          continue;
        }
        await postStakeAlert(client, { eHYUSDNetAmount: action.amount, signature: action.signature }, price, assetMap);
        logger.info({ amount: action.amount, signature: action.signature }, 'Stake alert posted (Hylo API feed)');
      }
    } catch (err) {
      logger.error({ err, action }, 'Failed to process feed action — continuing with the rest');
    }
  }
}

/**
 * Pool-wallet watcher: provides the Offload/Deployment rebalance alerts while
 * the feed path is active (the feed has no dedicated event type for those
 * paired burn+mint legs yet). One signature scan per tick on the pool wallet,
 * then the exact same classification rules as before (classifyTransaction).
 */
async function watchPoolWalletRebalances(client: Client, assetMap: Map<string, Asset>): Promise<void> {
  const hyUSD = assetMap.get('HYUSD');
  const xSOL = assetMap.get('XSOL');
  if (!hyUSD?.tokenAddress || !xSOL?.tokenAddress) return;

  if (poolWalletCheckpoint === null) {
    const seed = await querySignaturesSince(HYLO_STABILITY_POOL_WALLET, null, 1);
    if (!seed.success) return;
    poolWalletCheckpoint = seed.data[0]?.signature ?? '';
    logger.debug({ checkpoint: poolWalletCheckpoint }, 'Pool-wallet rebalance checkpoint seeded');
    return;
  }

  const result = await querySignaturesSince(HYLO_STABILITY_POOL_WALLET, poolWalletCheckpoint, 50);
  if (!result.success) {
    logger.warn({ error: result.error }, 'Pool-wallet rebalance check failed');
    return;
  }
  const sigs = result.data;
  if (sigs.length === 0) return;
  const newest = sigs[0]?.signature;
  if (newest) poolWalletCheckpoint = newest;
  if (sigs.length >= 50) {
    logger.warn('Pool-wallet burst deeper than one page — resyncing rebalance checkpoint without processing (same gap semantics as the mint scans)');
    return;
  }

  for (const { signature, err } of [...sigs].reverse()) {
    if (err) continue;
    try {
      const classified = await classifyTransaction(signature, { HYUSD: hyUSD.tokenAddress, XSOL: xSOL.tokenAddress });
      if (!classified.success || !classified.data.rebalance) continue;
      const { direction, hyUSDAmount, xSOLAmount } = classified.data.rebalance;
      const [hyUSDDecimals, xSOLDecimals] = await Promise.all([getDecimals(hyUSD.tokenAddress), getDecimals(xSOL.tokenAddress)]);
      const hyUSDUi = toUiAmount(hyUSDAmount, hyUSDDecimals, { symbol: 'HYUSD', signature, leg: 'pool-wallet rebalance' });
      const xSOLUi = toUiAmount(xSOLAmount, xSOLDecimals, { symbol: 'XSOL', signature, leg: 'pool-wallet rebalance' });
      if (hyUSDUi === null || xSOLUi === null) continue;

      if (!meetsReportThreshold(hyUSDUi, 1)) {
        logger.debug({ direction, hyUSDUi, signature }, 'Pool rebalance below MIN_VAL_REPORT — not posted');
      } else {
        await postRebalanceAlert(client, direction, signature, xSOLUi, hyUSDUi, assetMap);
        logger.info({ direction, hyUSDUi, xSOLUi, signature }, 'Pool rebalance alert posted (pool-wallet watcher)');
      }

      // Ledger gets every rebalance regardless of MIN_VAL_REPORT — same pairs as before.
      if (direction === 'OFFLOAD') {
        await recordFlow('HYUSD', 'MINT', hyUSDUi);
        await recordFlow('XSOL', 'BURN', xSOLUi);
      } else {
        await recordFlow('XSOL', 'MINT', xSOLUi);
        await recordFlow('HYUSD', 'BURN', hyUSDUi);
      }
    } catch (err) {
      logger.error({ err, signature }, 'Pool-wallet rebalance classification failed — continuing');
    }
  }
}

/**
 * LST assets have no feed coverage (the API doesn't index staking ops) —
 * their mint/burn scanning stays on RPC in both modes.
 */
async function tickLstMintAssets(client: Client, assets: Asset[], assetMap: Map<string, Asset>): Promise<void> {
  for (const asset of assets) {
    if (asset.symbol !== 'HYLOSOL' && asset.symbol !== 'HYLOSOL+') continue;
    if (!asset.tokenAddress) continue;
    try {
      await tickGenericMintAsset(client, asset, assetMap);
    } catch (err) {
      logger.error({ err, symbol: asset.symbol }, 'LST mint scan failed — continuing with the rest');
    }
  }
}

/**
 * A quiet chain makes the feed look quiet too — only when the feed's newest
 * event is older than FEED_STALE_PROBE_MS do we spend one cheap RPC call
 * comparing against the chain's newest hyUSD-mint activity. The feed trailing
 * the chain by more than FEED_MAX_CHAIN_LAG_MS means the indexer is stalled:
 * alerts must not silently stop, so the caller flips to RPC until it recovers.
 */
async function feedLaggingRealActivity(hyUSDMint: string | null): Promise<boolean> {
  if (!feedNewestEventMs || Date.now() - feedNewestEventMs < FEED_STALE_PROBE_MS) return false;
  if (!hyUSDMint) return false;
  const probe = await queryTokenActivity(hyUSDMint, 5);
  if (!probe.success) return false; // RPC unhappy — keep trusting the feed this tick
  const newestChain = probe.data.signatures
    .filter((s) => !s.err && s.blockTime !== null)
    .reduce((max, s) => Math.max(max, (s.blockTime ?? 0) * 1000), 0);
  if (newestChain === 0) return false;
  const lag = newestChain - feedNewestEventMs;
  if (lag > FEED_MAX_CHAIN_LAG_MS) {
    logger.warn({ feedNewestEventMs, newestChain, lagMs: lag }, 'Feed is trailing real chain activity — switching to RPC fallback');
    return true;
  }
  return false;
}

/** Recovery probe while in RPC fallback: seed the feed checkpoint and report success without processing anything. */
async function trySeedFeed(): Promise<boolean> {
  const page = await getActivityPage({ limit: 1 });
  if (!page.ok) {
    markFeedFailure(page.error);
    return false;
  }
  markFeedSuccess();
  for (const e of page.data.events ?? []) feedSeenKeys.add(feedEventKey(e));
  const newest = (page.data.events ?? [])[0];
  if (newest) feedNewestEventMs = Date.parse(newest.blockTime);
  feedSeeded = true;
  return true;
}

/** Legacy path: the per-asset RPC scanners, unchanged — used while the feed is unavailable. */
async function tickViaRpc(client: Client, assets: Asset[], assetMap: Map<string, Asset>): Promise<void> {
  for (const asset of assets) {
    if (!asset.tokenAddress) continue;

    // Each asset's check is isolated so one failure (e.g. a permission
    // error specific to one alert) can't abort the rest of this cycle —
    // observed happening for real: a Discord permission error in the
    // eHYUSD cap check (below) was surfacing as a generic tick failure,
    // which would have equally masked any later asset in this loop too.
    try {
      if (asset.symbol === 'EHYUSD') {
        await tickStakeAsset(client, asset, assetMap);
      } else if (asset.symbol === 'HYUSD') {
        await tickHyUSDAsset(client, asset, assetMap);
      } else if (asset.symbol === 'XSOL') {
        await tickXSOLAsset(client, asset, assetMap);
      } else {
        await tickGenericMintAsset(client, asset, assetMap);
      }
    } catch (err) {
      logger.error({ err, symbol: asset.symbol }, 'Mint watcher tick failed for this asset — continuing with the rest');
    }
  }
}

async function tick(client: Client): Promise<void> {
  try {
    const assets = await assetRepository.findAll({ activeOnly: true });
    const assetMap = new Map(assets.map((a) => [a.symbol, a]));

    // Independently gated on its own channel — mint alerts being disabled
    // shouldn't also silence the (unrelated) cap-progress poster.
    if (config.mintAlerts.channelId) {
      if (!usingRpcFallback && feedUsable()) {
        const ok = await tickViaFeed(client, assets, assetMap);
        if (ok) {
          await watchPoolWalletRebalances(client, assetMap);
          await tickLstMintAssets(client, assets, assetMap);
          if (await feedLaggingRealActivity(assetMap.get('HYUSD')?.tokenAddress ?? null)) {
            usingRpcFallback = true;
          }
        } else if (!feedUsable()) {
          usingRpcFallback = true;
          logger.warn('Hylo API feed unavailable — switching mint-watcher to Helius RPC scanning until it recovers');
        }
      } else {
        await tickViaRpc(client, assets, assetMap);
        if (!config.hyloApi.eventsDisabled) {
          const recovered = await trySeedFeed();
          if (recovered) {
            usingRpcFallback = false;
            logger.info('Hylo API feed recovered — resuming the API-primary event path');
          }
        }
      }
    }

    try {
      await checkEHYUSDCapMilestone(client, assetMap);
    } catch (err) {
      logger.error({ err }, 'eHYUSD cap milestone check failed — unrelated to mint/burn detection above, which already completed this cycle');
    }
  } catch (err) {
    logger.error({ err }, 'Mint watcher tick failed unexpectedly');
  }
}

// ─── Daily inflow/outflow summary ──────────────────────────────────────────────
// Sums whatever's accumulated in the rolling MintFlowEvent table (written to by
// every tick above), posts it, then wipes the table — see mint-flow.repository.
// eHYUSD is deliberately excluded: staking hyUSD into the pool is a transfer of
// already-minted hyUSD represented by a new eHYUSD receipt, not a fresh
// economic inflow/outflow, so it has no place in a supply-flow summary.

const DISPLAY_ORDER: Array<{ symbol: string; label: string }> = [
  { symbol: 'HYUSD', label: 'hyUSD' },
  { symbol: 'XSOL', label: 'xSOL' },
  { symbol: 'XBTC', label: 'xBTC' },
  { symbol: 'XHYPE', label: 'xHYPE' },
  { symbol: 'HYLOSOL', label: 'hyloSOL' },
  { symbol: 'HYLOSOL+', label: 'hyloSOL+' },
];

/** hyUSD reads as currency (2dp); everything else as a token quantity (4dp), matching fmtQty elsewhere in this file. */
function fmtFlowQty(symbol: string, n: number): string {
  const digits = symbol === 'HYUSD' ? 2 : 4;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact signed USD, e.g. 944312 -> "$944.3K", -0.4 -> "−$0". Sign comes from `n` itself. */
function fmtUsdCompact(n: number): string {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  if (abs < 1) return `${sign}$0`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
}

/**
 * `dryRun: true` previews the exact message the real post would send, without
 * any side effects: uses summarize() (read-only) instead of
 * summarizeAndClear() — the rolling window is left untouched — and logs the
 * message instead of calling channel.send(), so it can be run any time
 * against the live bot without risk of a real Discord post or X post.
 */
export async function postDailySummary(client: Client, opts?: { dryRun?: boolean }): Promise<void> {
  try {
    if (!config.mintAlerts.channelId) return;
    const channel = await getMintAlertsChannel(client);
    if (!channel) return;

    const { windowStart, totals } = opts?.dryRun
      ? await mintFlowRepository.summarize()
      : await mintFlowRepository.summarizeAndClear();
    const assets = await assetRepository.findAll({ activeOnly: true });
    const assetMap = new Map(assets.map((a) => [a.symbol, a]));

    // Computed once, shared by both the Discord message (bold + emoji) and
    // the plain-text X post (no markdown, no custom emoji — X doesn't render either).
    const rows: Array<{ symbol: string; label: string; mint: number; burn: number; inUsd: number | null; outUsd: number | null }> = [];
    let netUsd = 0;
    let netUsdKnown = false;

    for (const { symbol, label } of DISPLAY_ORDER) {
      const t = totals.get(symbol) ?? { mint: 0, burn: 0 };
      const price = await resolveAssetPriceUsd(symbol, assetMap);

      let inUsd: number | null = null;
      let outUsd: number | null = null;
      if (price !== null) {
        inUsd = t.mint * price;
        outUsd = t.burn * price;
        netUsd += inUsd - outUsd;
        netUsdKnown = true;
      }

      rows.push({ symbol, label, mint: t.mint, burn: t.burn, inUsd, outUsd });
    }

    const windowAgeMs = windowStart ? Date.now() - windowStart.getTime() : null;
    const netLabel = netUsdKnown ? `~${fmtUsdCompact(netUsd)}` : 'unknown';

    const discordLines = rows.map(
      (r) =>
        `${emojiPrefix(r.symbol, assetMap)}${r.label}: **+${fmtFlowQty(r.symbol, r.mint)}**${r.inUsd !== null ? ` (~${fmtUsdCompact(r.inUsd)})` : ''} / **−${fmtFlowQty(r.symbol, r.burn)}**${r.outUsd !== null ? ` (~${fmtUsdCompact(r.outUsd)})` : ''}`,
    );
    const discordMessage = [`## Daily mint/burn (Net: ${netLabel})`, ...discordLines].join('\n');

    // dryRun must be a true no-op against Discord — previewing this must never risk a
    // real post landing in the live channel. Log the exact text instead of sending it.
    if (opts?.dryRun) {
      logger.info({ netUsd: netUsdKnown ? netUsd : null, windowAgeMs, preview: discordMessage }, 'Daily summary preview (dry run — not posted)');
      return;
    }

    await channel.send(discordMessage);
    logger.info({ netUsd: netUsdKnown ? netUsd : null, windowAgeMs }, 'Daily summary posted');

    // X (Twitter): only the daily summary, never live alerts (rate limits), and only
    // when the net move clears TWITTER_MIN_NET_USD — quiet days stay Discord-only.
    if (twitterService.enabled) {
      if (!netUsdKnown) {
        logger.debug('Skipping X post — net USD unresolvable (price data unavailable)');
      } else if (Math.abs(netUsd) < config.twitter.minNetUsd) {
        logger.debug({ netUsd, minNetUsd: config.twitter.minNetUsd }, 'Skipping X post — below TWITTER_MIN_NET_USD');
      } else {
        const twitterLines = rows.map(
          (r) =>
            `${r.label}: +${fmtFlowQty(r.symbol, r.mint)} / −${fmtFlowQty(r.symbol, r.burn)}${r.inUsd !== null && r.outUsd !== null ? ` (~${fmtUsdCompact(r.inUsd)}/−${fmtUsdCompact(r.outUsd)})` : ''}`,
        );
        const tweetText = [`Daily mint/burn — Net: ${netLabel}`, '', ...twitterLines].join('\n');
        const result = await twitterService.postTweet(tweetText);
        if (!result.success) {
          logger.warn({ error: result.error }, 'X post failed — Discord summary already posted successfully');
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Daily summary failed unexpectedly');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_SUMMARY_HOUR_UTC = 23;

function msUntilNextUtcHour(hour: number): number {
  const now = new Date();
  let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hour, 0, 0, 0));
  }
  return next.getTime() - now.getTime();
}

function startDailySummaryScheduler(client: Client): void {
  const delayMs = msUntilNextUtcHour(DAILY_SUMMARY_HOUR_UTC);
  logger.info({ nextRunInMs: delayMs }, `Daily summary scheduled for next ${DAILY_SUMMARY_HOUR_UTC}:00 UTC`);
  setTimeout(() => {
    void postDailySummary(client);
    setInterval(() => { void postDailySummary(client); }, DAY_MS);
  }, delayMs);
}

// A hung await inside tick() (a stuck RPC/DB/Discord call that never settles)
// would otherwise stall this self-scheduling loop forever — tick()'s own
// try/catch only handles rejections, not a promise that just never resolves.
// Observed happening for real: the loop went completely silent for over an
// hour with live on-chain activity the whole time, and only a full process
// restart recovered it. This timeout is the recovery path for that case —
// generous enough (3x POLL_INTERVAL_MS) to never cut off a tick that's just
// legitimately slow processing a burst of events.
const TICK_TIMEOUT_MS = 180_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Self-scheduling loop instead of setInterval: a tick that does real on-chain
 * work can occasionally run longer than POLL_INTERVAL_MS, and setInterval
 * would fire the next tick before the previous one finishes — both would see
 * the same stale checkpoint, both detect the same "new" events, both post,
 * duplicate alerts for every event. Scheduling the next tick only after the
 * current one resolves (or times out) guarantees they never overlap, however
 * long a tick takes, while still guaranteeing the schedule itself can never
 * get stuck.
 */
async function loop(client: Client): Promise<void> {
  try {
    await withTimeout(tick(client), TICK_TIMEOUT_MS, 'mint watcher tick');
  } catch (err) {
    logger.error({ err }, 'Mint watcher tick did not complete in time — recovering and scheduling the next tick anyway');
  }
  setTimeout(() => { void loop(client); }, POLL_INTERVAL_MS).unref();
}

export function startMintWatcher(client: Client): void {
  if (!config.mintAlerts.channelId && !config.ehyusdCap.channelId) {
    logger.info('Neither MINT_ALERTS_CHANNEL_ID nor EHYUSD_CAP_CHANNEL_ID is set — mint watcher disabled');
    return;
  }
  logger.info(
    { intervalMs: POLL_INTERVAL_MS, mintAlertsChannelId: config.mintAlerts.channelId, ehyusdCapChannelId: config.ehyusdCap.channelId },
    'Mint watcher started',
  );
  void loop(client);
  if (config.mintAlerts.channelId) startDailySummaryScheduler(client);
}
