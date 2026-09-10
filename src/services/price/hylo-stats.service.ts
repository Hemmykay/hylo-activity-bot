/**
 * Hylo's own protocol stats API — used here only for Stability Pool APY,
 * since that figure isn't derivable from the data we otherwise query
 * directly: it depends on Solana epoch timing, which isn't a constant we
 * can safely assume for a number shown to customers.
 *
 * Stability Pool APY = (1 + epoch yield rate)^182 − 1
 *   epoch yield rate  = stablecoinYieldToPool / stabilityPoolCap
 * 182 ≈ epochs/year (Hylo-confirmed annualization basis).
 */
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('hylo-stats');

const STATS_URL = 'https://api.hylo.so/stats';
const TIMEOUT_MS = 5_000;
const EPOCHS_PER_YEAR = 182;

// The ticker asks for this every ~60s. Hylo's stats endpoint can stall past
// TIMEOUT_MS, so reuse a recent success rather than dropping APY from status.
let apyCache: { data: StabilityPoolAPY; asOf: number } | null = null;
const FRESH_REUSE_MAX_AGE_MS = 55_000;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

export interface StabilityPoolAPY {
  apy: number;       // e.g. 0.1014 = 10.14%
  formatted: string;  // "10.14%"
  epochRate: number;  // per-epoch yield rate, pre-annualization
  epoch: string;
  stabilityPoolCap: number;
  stablecoinYieldToPool: number;
}

interface HyloStatsResponse {
  exchangeStats: {
    yieldHarvestCache: {
      epoch: string;
      stabilityPoolCap: number;
      stablecoinYieldToPool: number;
    };
  };
}

export async function queryStabilityPoolAPY(): Promise<PriceResult<StabilityPoolAPY>> {
  const cached = apyCache;
  if (cached && Date.now() - cached.asOf <= FRESH_REUSE_MAX_AGE_MS) {
    return { success: true, data: cached.data };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(STATS_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const json = (await res.json()) as HyloStatsResponse;
    const harvest = json.exchangeStats?.yieldHarvestCache;
    if (!harvest) throw new Error('yieldHarvestCache missing from response');
    const { epoch, stabilityPoolCap, stablecoinYieldToPool } = harvest;
    if (!stabilityPoolCap) throw new Error('stabilityPoolCap is zero or missing');

    const epochRate = stablecoinYieldToPool / stabilityPoolCap;
    const apy = Math.pow(1 + epochRate, EPOCHS_PER_YEAR) - 1;
    const data: StabilityPoolAPY = {
      apy,
      formatted: `${(apy * 100).toFixed(2)}%`,
      epochRate,
      epoch,
      stabilityPoolCap,
      stablecoinYieldToPool,
    };
    apyCache = { data, asOf: Date.now() };
    return { success: true, data };
  } catch (err) {
    if (cached && Date.now() - cached.asOf <= CACHE_MAX_AGE_MS) {
      logger.warn({ err, ageMs: Date.now() - cached.asOf }, 'queryStabilityPoolAPY failed — using last known-good APY');
      return { success: true, data: cached.data };
    }
    logger.warn({ err }, 'queryStabilityPoolAPY failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}
