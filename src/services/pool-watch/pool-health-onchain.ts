/**
 * Pool health straight from the chain — the pool watcher's fall-back when Hylo's market-state API is
 * unreachable (blocked, stale or down), so pool alerts keep working instead of going blind.
 *
 * It reuses the same on-chain price modules the tickers fall back to, so there is one implementation
 * of "collateral value" and "pool virtual stablecoin supply" per pool, not two:
 *   TVL = collateral value (pool wallet balance × USD price)    — SOL pool: LST balances × LST prices
 *   debt = the pool's own virtual stablecoin supply (ExoPair / Hylo account)
 * The zone label is left null on purpose: the watcher derives it from the collateral ratio
 * (pool-events zoneFromCr), the same thresholds Hylo's own labels follow.
 *
 * Prices come from Jupiter rather than Hylo's oracle, so TVL can differ from market-state by a
 * fraction of a percent — far inside the watcher's thresholds (30% leverage / 50% debt moves).
 * Pools that can't be read this cycle are simply omitted; callers treat an empty result as "blind".
 */
import type { Asset } from '@prisma/client';
import { createLogger } from '@/lib/logger.js';
import type { LevercoinSymbol, PoolHealth } from '@/services/price/market-state.service.js';
import { buildXSOLPriceParams } from '@/services/price/asset-price.service.js';
import { queryXSOLPrice } from '@/services/price/xsol.service.js';
import { queryXBTCPrice } from '@/services/price/xbtc.service.js';
import { queryXHYPEPrice } from '@/services/price/xhype.service.js';
import { queryXZECPrice } from '@/services/price/xzec.service.js';
import { queryXONYCPrice } from '@/services/price/xonyc.service.js';

const logger = createLogger('pool-health-onchain');

function health(tvlUsd: number, debtUsd: number): PoolHealth | null {
  if (!Number.isFinite(tvlUsd) || !Number.isFinite(debtUsd) || tvlUsd < 0 || debtUsd < 0) return null;
  const equity = tvlUsd - debtUsd;
  return {
    tvlUsd,
    debtUsd,
    collateralRatio: debtUsd > 0 ? tvlUsd / debtUsd : null,
    leverage: equity > 0 && tvlUsd > 0 ? tvlUsd / equity : null,
    zone: null,
  };
}

type Reader = (assets: Map<string, Asset>) => Promise<PoolHealth | null>;

function exo<T extends { collateralValueUsd: number }>(
  symbol: string,
  run: (wallet: string, mint: string) => Promise<{ success: true; data: T } | { success: false; error: string }>,
  debt: (d: T) => number,
): Reader {
  return async (assets) => {
    const a = assets.get(symbol);
    if (!a?.tokenAddress || !a.collateralWallet) return null;
    const r = await run(a.collateralWallet, a.tokenAddress);
    return r.success ? health(r.data.collateralValueUsd, debt(r.data)) : null;
  };
}

const READERS: Record<LevercoinSymbol, Reader> = {
  XSOL: async (assets) => {
    const params = buildXSOLPriceParams(assets);
    if (!params) return null;
    const r = await queryXSOLPrice(params);
    return r.success ? health(r.data.collateralTVL, r.data.solPoolVirtualStablecoinUsd) : null;
  },
  XBTC: exo('XBTC', (w, m) => queryXBTCPrice({ collateralWallet: w, xBTCMint: m }), (d) => d.btcPoolVirtualStablecoinUsd),
  XHYPE: exo('XHYPE', (w, m) => queryXHYPEPrice({ collateralWallet: w, xHYPEMint: m }), (d) => d.hypePoolVirtualStablecoinUsd),
  XZEC: exo('XZEC', (w, m) => queryXZECPrice({ collateralWallet: w, xZECMint: m }), (d) => d.zecPoolVirtualStablecoinUsd),
  XONYC: exo('XONYC', (w, m) => queryXONYCPrice({ collateralWallet: w, xONYCMint: m }), (d) => d.onycPoolVirtualStablecoinUsd),
};

/** Null when no pool at all could be read (RPC down too); otherwise whichever pools succeeded. */
export async function queryPoolHealthOnchain(assets: Map<string, Asset>): Promise<Partial<Record<LevercoinSymbol, PoolHealth>> | null> {
  const symbols = Object.keys(READERS) as LevercoinSymbol[];
  const settled = await Promise.allSettled(symbols.map((s) => READERS[s](assets)));
  const out: Partial<Record<LevercoinSymbol, PoolHealth>> = {};
  settled.forEach((r, i) => {
    const symbol = symbols[i]!;
    if (r.status === 'fulfilled') {
      if (r.value) out[symbol] = r.value;
    } else {
      logger.warn({ err: r.reason, symbol }, 'On-chain pool health read failed for this pool');
    }
  });
  return Object.keys(out).length > 0 ? out : null;
}
