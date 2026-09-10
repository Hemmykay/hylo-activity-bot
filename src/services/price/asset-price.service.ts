/**
 * Shared raw-USD-price resolution for Hylo's own assets. Extracted from what
 * used to be near-identical private copies in mint-watcher.service.ts and
 * intent-router.ts — a third caller (rag.service.ts, converting a token count
 * to a dollar amount for XP math) made a shared helper worth it.
 *
 * xSOL/xBTC/xHYPE try https://api.hylo.so/market-state first (same NAV
 * identity as the on-chain formula). A down, malformed, or stale payload
 * falls through to the Helius path so pricing stays live.
 */
import type { Asset } from '@prisma/client';
import { queryLSTPrice } from './hylo.service.js';
import { queryXSOLPrice, type XSOLPriceParams } from './xsol.service.js';
import { queryEHYUSDPrice } from './ehyusd.service.js';
import { queryXBTCPrice } from './xbtc.service.js';
import { queryXHYPEPrice } from './xhype.service.js';
import { queryPrice } from './jupiter-price.service.js';
import { queryMarketStateLevercoin, type LevercoinSymbol } from './market-state.service.js';
import { queryEhyusdEarnPool, queryLatestTokenPrice } from '@/services/hylo-api/hylo-api.service.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('asset-price');

interface CachedPrice {
  price: number;
  asOf: number;
  /** Present for leverage tokens (xSOL/xBTC/xHYPE) when the live formula produced a finite value. */
  effectiveLeverage?: number;
  /** eHYUSD supply, so the cap watcher can reuse the ticker's last resolution. */
  supply?: number;
}

interface LivePrice {
  price: number;
  effectiveLeverage?: number;
  supply?: number;
}

// Last successfully-resolved price per symbol. A burst of near-simultaneous
// on-chain activity (e.g. an arbitrage bot cluster) can transiently overload
// the RPC/price calls right when there's the most mint/burn volume to price —
// exactly the moments a threshold filter and a daily $ total matter most.
// Falling back to the last known-good price beats showing no $ value at all,
// as long as it's not so old it's more likely wrong than useful.
const priceCache = new Map<string, CachedPrice>();
const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Staleness gates for the v1-API price sources. The price series is 5m-bucketed
// (15 min tolerance ≈ three buckets). The state snapshot's earn-pool fields are
// sparse — they can lag the newest bucket by up to ~an hour (observed) — but
// eHYUSD supply moves slowly and the cap watcher's milestones are $100K, so 60
// minutes is comfortably safe; anything staler falls through to the on-chain
// stack (which the old code also backed with a 1-hour last-known-good cache).
const API_PRICE_MAX_AGE_MS = 15 * 60_000;
const API_EARNPOOL_MAX_AGE_MS = 60 * 60_000;

/** Leverage-token ticker symbols → the underlying Jupiter-tracked symbol used to bootstrap a 24h NAV when no snapshot exists yet. */
const LEVERAGED_UNDERLYING: Record<string, string> = {
  XSOL: 'SOL',
  XBTC: 'BTC',
  XHYPE: 'HYPE',
};

function finitePositive(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

function livePrice(price: number, leverage?: number, supply?: number): LivePrice {
  const effectiveLeverage = finitePositive(leverage);
  return {
    price,
    ...(effectiveLeverage !== undefined && { effectiveLeverage }),
    ...(supply !== undefined && { supply }),
  };
}

const DEXSCREENER_TOKEN_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const DEXSCREENER_TIMEOUT_MS = 5_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

interface DexScreenerPair {
  dexId?: string;
  baseToken: { address: string };
  quoteToken: { address: string };
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
}

/**
 * Most-liquid stable pair's 24h % change for a token (e.g. -0.15 meaning -0.15%).
 * Used to bootstrap eHYUSD's ticker until our own NAV snapshots are 24h old.
 */
async function queryDexStable24hPct(mint: string, extraStableMints: string[]): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEXSCREENER_TIMEOUT_MS);
  try {
    const res = await fetch(`${DEXSCREENER_TOKEN_URL}/${mint}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json() as { pairs?: DexScreenerPair[] | null };
    const pairs = json.pairs ?? [];
    const stables = new Set([USDC_MINT, USDT_MINT, ...extraStableMints]);
    const candidates = pairs.filter((p) =>
      p.baseToken.address === mint
      && stables.has(p.quoteToken.address)
      && typeof p.priceChange?.h24 === 'number'
      && Number.isFinite(p.priceChange.h24),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = candidates[0]!;
    logger.debug(
      { mint, dexId: best.dexId, quote: best.quoteToken.address, h24: best.priceChange?.h24, liquidityUsd: best.liquidity?.usd },
      'Picked DEX stable pair for 24h change',
    );
    return best.priceChange!.h24!;
  } catch (err) {
    logger.warn({ err, mint }, 'DexScreener 24h lookup failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Both the mint-watcher tick and the price-ticker bots (see price-ticker.service.ts)
// poll roughly every 60s and call resolveAssetPriceUsd for the same symbols — without
// this, they'd double the RPC/Jupiter calls for no benefit. Any call within this window
// of the last resolution (from EITHER caller) reuses it instead of re-querying live.
const FRESH_REUSE_MAX_AGE_MS = 55_000;

/**
 * Shared param assembly for both xSOL and eHYUSD, which both derive from the
 * same hyloSOL/hyUSD/xSOL collateral data. Returns null if any of those
 * assets aren't fully configured yet.
 */
function buildXSOLPriceParams(assets: Map<string, Asset>): XSOLPriceParams | null {
  const hyloSOL = assets.get('HYLOSOL');
  const hyUSD = assets.get('HYUSD');
  const xSOL = assets.get('XSOL');
  if (!hyloSOL?.tokenAddress || !hyloSOL.stakeVault || !hyUSD?.tokenAddress || !xSOL?.tokenAddress) return null;
  const stakeAccounts = hyloSOL.stakeVault.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    hyloSOLMint: hyloSOL.tokenAddress,
    hyloSOLStakeAccounts: stakeAccounts,
    xSOLMint: xSOL.tokenAddress,
  };
}

/**
 * eHYUSD price AND supply in one call — used directly by callers (e.g. the
 * cap-progress display) that need the raw supply, not just the price
 * resolveAssetPriceUsd returns. Reuses the shared price cache (including a
 * just-resolved xSOL/USD) so the cap watcher doesn't redo the ticker's RPCs.
 *
 * v1 API first: price = latest 5m close for eHYUSD, supply = the state
 * snapshot's earn-pool ehyusdSupply (verified identical to live
 * getTokenSupply to every decimal). Both are protocol-derived versions of
 * the same identity the on-chain stack computes; either being missing or
 * stale falls through to that stack so pricing stays live.
 */
export async function resolveEHYUSDPriceAndSupply(assets: Map<string, Asset>): Promise<{ price: number; supply: number } | null> {
  const cached = priceCache.get('EHYUSD');
  if (cached?.supply !== undefined && Date.now() - cached.asOf <= FRESH_REUSE_MAX_AGE_MS) {
    return { price: cached.price, supply: cached.supply };
  }

  const [priceFromApi, poolFromApi] = await Promise.all([
    queryLatestTokenPrice('eHYUSD', API_PRICE_MAX_AGE_MS),
    queryEhyusdEarnPool(API_EARNPOOL_MAX_AGE_MS),
  ]);
  if (priceFromApi !== null && poolFromApi !== null) {
    const resolved = { price: priceFromApi, supply: poolFromApi.supply };
    priceCache.set('EHYUSD', { price: resolved.price, asOf: Date.now(), supply: resolved.supply });
    logger.debug({ price: resolved.price, supply: resolved.supply, asOf: poolFromApi.asOf }, 'eHYUSD priced+supplied from Hylo v1 API');
    return resolved;
  }

  const xSOLPriceParams = buildXSOLPriceParams(assets);
  const hyUSD = assets.get('HYUSD');
  const xSOL = assets.get('XSOL');
  const eHYUSD = assets.get('EHYUSD');
  if (!xSOLPriceParams || !hyUSD?.tokenAddress || !xSOL?.tokenAddress) return null;
  if (!eHYUSD?.tokenAddress || !eHYUSD.collateralWallet) return null;

  const xsolPrice = await resolveAssetPriceUsd('XSOL', assets);
  if (xsolPrice === null) return null;

  const result = await queryEHYUSDPrice({
    collateralWallet: eHYUSD.collateralWallet,
    xSOLMint: xSOL.tokenAddress,
    hyUSDMint: hyUSD.tokenAddress,
    eHYUSDMint: eHYUSD.tokenAddress,
    xSOLPriceParams,
    xSOLUsdPrice: xsolPrice,
  });
  if (!result.success) return null;

  const resolved = { price: result.data.price, supply: result.data.eHYUSDSupply };
  priceCache.set('EHYUSD', { price: resolved.price, asOf: Date.now(), supply: resolved.supply });
  return resolved;
}

/**
 * xSOL/xBTC/xHYPE: Hylo market-state first (one HTTP call, same NAV identity
 * as the on-chain formula). Null/stale/down → existing Helius path so
 * tickers stay live. LST / eHYUSD NAV are not in that payload.
 */
async function resolveLevercoinLive(
  symbol: LevercoinSymbol,
  fallback: () => Promise<LivePrice | null>,
): Promise<LivePrice | null> {
  const fromApi = await queryMarketStateLevercoin(symbol);
  if (fromApi) {
    logger.debug(
      { symbol, price: fromApi.price, leverage: fromApi.effectiveLeverage, source: 'market-state' },
      'Priced from market-state API',
    );
    return livePrice(fromApi.price, fromApi.effectiveLeverage);
  }
  return fallback();
}

/** Live lookup — returns price plus effectiveLeverage when the formula produces a finite value. */
async function resolveLivePriceUsd(symbol: string, assets: Map<string, Asset>): Promise<LivePrice | null> {
  if (symbol === 'HYLOSOL' || symbol === 'HYLOSOL+') {
    const asset = assets.get(symbol);
    if (!asset?.tokenAddress || !asset.stakeVault) return null;
    // hyloSOL's NAV is served directly by the v1 price series (verified against
    // the on-chain exchange-rate derivation); HYLOSOL+ has no API label yet, so
    // it always derives on-chain below.
    if (symbol === 'HYLOSOL') {
      const fromApi = await queryLatestTokenPrice('HyloSOL', API_PRICE_MAX_AGE_MS);
      if (fromApi !== null) return livePrice(fromApi);
    }
    const stakeAccounts = asset.stakeVault.split(',').map((s) => s.trim()).filter(Boolean);
    if (stakeAccounts.length === 0) return null;
    const result = await queryLSTPrice(stakeAccounts, asset.tokenAddress);
    return result.success ? livePrice(result.data.price) : null;
  }

  if (symbol === 'HYUSD') return livePrice(1);

  if (symbol === 'XSOL') {
    return resolveLevercoinLive('XSOL', async () => {
      const xSOLPriceParams = buildXSOLPriceParams(assets);
      if (!xSOLPriceParams) return null;
      const result = await queryXSOLPrice(xSOLPriceParams);
      return result.success ? livePrice(result.data.price, result.data.effectiveLeverage) : null;
    });
  }

  if (symbol === 'EHYUSD') {
    const resolved = await resolveEHYUSDPriceAndSupply(assets);
    return resolved ? livePrice(resolved.price, undefined, resolved.supply) : null;
  }

  if (symbol === 'XBTC') {
    return resolveLevercoinLive('XBTC', async () => {
      const xBTC = assets.get('XBTC');
      if (!xBTC?.tokenAddress || !xBTC.collateralWallet) return null;
      const result = await queryXBTCPrice({ collateralWallet: xBTC.collateralWallet, xBTCMint: xBTC.tokenAddress });
      return result.success ? livePrice(result.data.price, result.data.effectiveLeverage) : null;
    });
  }

  if (symbol === 'XHYPE') {
    return resolveLevercoinLive('XHYPE', async () => {
      const xHYPE = assets.get('XHYPE');
      if (!xHYPE?.tokenAddress || !xHYPE.collateralWallet) return null;
      const result = await queryXHYPEPrice({ collateralWallet: xHYPE.collateralWallet, xHYPEMint: xHYPE.tokenAddress });
      return result.success ? livePrice(result.data.price, result.data.effectiveLeverage) : null;
    });
  }

  return null;
}

/**
 * Returns null (not an error) when the asset isn't fully configured yet, its
 * price formula needs assets that aren't in `assets`, AND no usably-fresh
 * cached price exists either — callers decide how to handle "price
 * unavailable" themselves.
 */
const priceInflight = new Map<string, Promise<number | null>>();

export async function resolveAssetPriceUsd(symbol: string, assets: Map<string, Asset>): Promise<number | null> {
  const cached = priceCache.get(symbol);
  if (cached && Date.now() - cached.asOf <= FRESH_REUSE_MAX_AGE_MS) {
    return cached.price;
  }

  const pending = priceInflight.get(symbol);
  if (pending) return pending;

  const request = (async (): Promise<number | null> => {
    const live = await resolveLivePriceUsd(symbol, assets);
    if (live !== null) {
      priceCache.set(symbol, { ...live, asOf: Date.now() });
      return live.price;
    }

    const stale = priceCache.get(symbol);
    if (stale && Date.now() - stale.asOf <= CACHE_MAX_AGE_MS) {
      logger.warn(
        { symbol, price: stale.price, ageMs: Date.now() - stale.asOf },
        'Live price lookup failed — using last known-good price',
      );
      return stale.price;
    }

    return null;
  })().finally(() => { priceInflight.delete(symbol); });

  priceInflight.set(symbol, request);
  return request;
}

/**
 * Effective leverage for a leverage token, read from the same cache
 * resolveAssetPriceUsd populates. Call after (or instead of — this ensures
 * freshness itself) resolveAssetPriceUsd so the on-chain work isn't duplicated.
 * Returns null for non-leverage tokens and when no usable price/leverage exists.
 */
export async function resolveAssetLeverage(symbol: string, assets: Map<string, Asset>): Promise<number | null> {
  const price = await resolveAssetPriceUsd(symbol, assets);
  if (price === null) return null;
  return priceCache.get(symbol)?.effectiveLeverage ?? null;
}

/**
 * Bootstrap-only 24h-ago NAV for a leverage token, used until we have a
 * real snapshot from a day ago. Do not treat this as the live 24h figure:
 * effective leverage is not constant, so (underlying % × live leverage)
 * is the wrong model.
 *
 * This instead inverts today's NAV through the oracle move under a
 * constant-composition pool (balances and vUSD unchanged). Because
 * L = TVL / (TVL − vUSD), leverage itself moves with the oracle, and
 * yesterday's NAV is:
 *
 *   r  = underlying's 24h % change (Jupiter reports this directly)
 *   past = currentPrice × (1 − L_now × r / (1 + r))
 *
 * Mints, burns, and rebalances over the window are still invisible here —
 * that's why the ticker prefers a recorded NAV once one exists.
 *
 * Returns null for non-leverage tokens and when any input is missing or the
 * move would imply a non-positive past price.
 */
export async function resolveLeveragedImpliedPastPrice(
  symbol: string,
  currentPrice: number,
  assets: Map<string, Asset>,
): Promise<number | null> {
  const underlying = LEVERAGED_UNDERLYING[symbol];
  if (!underlying) return null;

  const leverage = await resolveAssetLeverage(symbol, assets);
  if (leverage === null) {
    logger.warn({ symbol }, 'Leverage unavailable for implied 24h price — falling back to snapshot');
    return null;
  }

  const underlyingResult = await queryPrice(underlying);
  if (!underlyingResult.success || underlyingResult.data.priceChange24hPct === null) return null;
  if (currentPrice <= 0) return null;

  const underlyingPctChange = underlyingResult.data.priceChange24hPct / 100;
  const denom = 1 + underlyingPctChange;
  if (denom <= 0) return null;

  const impliedPast = currentPrice * (1 - (leverage * underlyingPctChange) / denom);
  if (impliedPast <= 0) return null;

  logger.debug(
    { symbol, underlying, leverage, underlyingPctChange, currentPrice, impliedPast },
    'Implied 24h-ago NAV from composition-constant oracle move (bootstrap only)',
  );
  return impliedPast;
}

/**
 * eHYUSD has no oracle history to bootstrap from; until our NAV snapshots are 24h old, bootstrap
 * an implied 24h-ago price from the most liquid DEX stable pair's 24h %.
 * formatChange consumes this the same way it consumes a snapshot.
 */
async function resolveEHYUSDImpliedPastPrice(
  currentPrice: number,
  assets: Map<string, Asset>,
): Promise<number | null> {
  const mint = assets.get('EHYUSD')?.tokenAddress;
  if (!mint || currentPrice <= 0) return null;

  const hyUSDMint = assets.get('HYUSD')?.tokenAddress;
  const h24Pct = await queryDexStable24hPct(mint, hyUSDMint ? [hyUSDMint] : []);
  if (h24Pct === null) return null;

  const denom = 1 + h24Pct / 100;
  if (denom <= 0) return null;

  const impliedPast = currentPrice / denom;
  logger.debug({ currentPrice, h24Pct, impliedPast }, 'Implied 24h-ago eHYUSD price from DEX');
  return impliedPast;
}

/**
 * Bootstrap 24h-ago USD price for ticker status, used only until a real
 * NAV snapshot from ~24h ago exists. Leverage tokens reconstruct yesterday's
 * NAV from the oracle move (leverage is not held constant); eHYUSD uses a
 * DEX 24h %.
 */
export async function resolveImpliedPastPrice(
  symbol: string,
  currentPrice: number,
  assets: Map<string, Asset>,
): Promise<number | null> {
  if (symbol === 'EHYUSD') return resolveEHYUSDImpliedPastPrice(currentPrice, assets);
  return resolveLeveragedImpliedPastPrice(symbol, currentPrice, assets);
}
