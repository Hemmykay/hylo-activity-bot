/**
 * xHYPE price derivation, mirroring xbtc.service.ts's formula but for the
 * HYPE (exogenous-collateral) pool:
 *
 * Collateral value = HYPE held in the HYPE pool's collateral wallet × HYPE/USD
 * xHYPE price       = (Collateral value − HYPE pool's virtual stablecoin supply) / xHYPE supply
 *
 * "HYPE pool's virtual stablecoin supply" is that pool's own on-chain
 * accounting of how much hyUSD backing is attributed to it specifically,
 * read directly from the Hylo Exchange program's ExoPair account (see
 * hylo-accounts.service.ts) — not the global hyUSD supply.
 *
 * HYPE/USD price comes from Jupiter (jupiter-price.service.ts). A prior
 * version matched Pyth's HYPE/USD feed byte-for-byte against the HYPE
 * ExoPair account's own `oracle_feed_id` — Pyth's Hermes API started
 * requiring a paid API key on 2026-08-26, so pricing now comes from
 * Jupiter's free public price API instead, which won't track the
 * protocol's own oracle number exactly tick-for-tick.
 */
import { queryTokenBalance, queryTokenSupply } from '@/services/onchain/helius.service.js';
import { queryPrice } from '@/services/price/jupiter-price.service.js';
import { queryExoPoolVirtualStablecoinUsd } from '@/services/onchain/hylo-accounts.service.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('xhype-price');

// HYPE isn't a Hylo-native asset (no DB row) — same treatment as cbBTC's fixed mint constant in xbtc.service.ts.
const HYPE_MINT = '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g';

export interface XHYPEPriceParams {
  collateralWallet: string;
  xHYPEMint: string;
}

export interface XHYPEPrice {
  price: number;
  formatted: string;
  collateralValueUsd: number;
  hypeBalance: number;
  hypeUsdPrice: number;
  hypePoolVirtualStablecoinUsd: number;
  xHYPESupply: number;
  /** Collateral value / xHYPE market cap — same definition as xSOL's effectiveLeverage. */
  effectiveLeverage: number;
}

export async function queryXHYPEPrice(params: XHYPEPriceParams): Promise<PriceResult<XHYPEPrice>> {
  const [balResult, priceResult, virtualStablecoinResult, supplyResult] = await Promise.all([
    queryTokenBalance(params.collateralWallet, HYPE_MINT),
    queryPrice('HYPE'),
    queryExoPoolVirtualStablecoinUsd(HYPE_MINT),
    queryTokenSupply(params.xHYPEMint),
  ]);

  if (!balResult.success) return { success: false, error: `HYPE balance query failed: ${balResult.error}` };
  if (!priceResult.success) return { success: false, error: `HYPE price unavailable: ${priceResult.error}` };
  if (!virtualStablecoinResult.success) return { success: false, error: `HYPE pool virtual stablecoin supply unavailable: ${virtualStablecoinResult.error}` };
  if (!supplyResult.success) return { success: false, error: `xHYPE supply query failed: ${supplyResult.error}` };

  const hypeBalance = balResult.data.uiAmount;
  const hypeUsdPrice = priceResult.data.price;
  const collateralValueUsd = hypeBalance * hypeUsdPrice;

  const hypePoolVirtualStablecoinUsd = virtualStablecoinResult.data;
  const xHYPESupply = supplyResult.data.uiAmount;

  if (xHYPESupply === 0) {
    return { success: false, error: 'xHYPE supply is zero — cannot compute price.' };
  }

  const price = (collateralValueUsd - hypePoolVirtualStablecoinUsd) / xHYPESupply;
  const xHYPEMarketCap = price * xHYPESupply;
  const effectiveLeverage = xHYPEMarketCap > 0 ? collateralValueUsd / xHYPEMarketCap : Infinity;

  logger.debug(
    { hypeBalance, hypeUsdPrice, collateralValueUsd, hypePoolVirtualStablecoinUsd, xHYPESupply, price, effectiveLeverage },
    'xHYPE price computed',
  );

  return {
    success: true,
    data: {
      price,
      formatted: `$${price.toFixed(4)}`,
      collateralValueUsd,
      hypeBalance,
      hypeUsdPrice,
      hypePoolVirtualStablecoinUsd,
      xHYPESupply,
      effectiveLeverage,
    },
  };
}
