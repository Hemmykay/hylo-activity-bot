/**
 * xBTC price derivation, mirroring xsol.service.ts's formula but for the BTC
 * (exogenous-collateral) pool:
 *
 * Collateral value = cbBTC held in the BTC pool's collateral wallet × BTC/USD
 * xBTC price        = (Collateral value − BTC pool's virtual stablecoin supply) / xBTC supply
 *
 * "BTC pool's virtual stablecoin supply" is NOT the global hyUSD supply — it's
 * that pool's own on-chain accounting of how much hyUSD backing is
 * attributed to it specifically, read directly from the Hylo Exchange
 * program's ExoPair account (see hylo-accounts.service.ts). Reusing the
 * global hyUSD supply here (as an earlier version of this file did) would
 * double-count the same backing that's already fully subtracted in xSOL's
 * calculation.
 *
 * Uses cbBTC's own price via Jupiter (jupiter-price.service.ts), not the
 * plain BTC/USD feed Hylo's own program reads on-chain — a prior version of
 * this matched Pyth's BTC/USD feed exactly (verified byte-for-byte against
 * the ExoPair account's `oracle_feed_id`), but Pyth's Hermes API started
 * requiring a paid API key on 2026-08-26, so pricing now comes from Jupiter's
 * free public price API instead. cbBTC trades close to BTC but isn't
 * guaranteed identical, so this number can drift slightly from what the
 * protocol's own formula would compute.
 */
import { queryTokenBalance, queryTokenSupply } from '@/services/onchain/helius.service.js';
import { queryPrice } from '@/services/price/jupiter-price.service.js';
import { queryExoPoolVirtualStablecoinUsd } from '@/services/onchain/hylo-accounts.service.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('xbtc-price');

// cbBTC isn't a Hylo-native asset (no DB row) — same treatment as jitoSOL's
// fixed mint constant in xsol.service.ts.
const CBBTC_MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';

export interface XBTCPriceParams {
  collateralWallet: string;
  xBTCMint: string;
}

export interface XBTCPrice {
  price: number;
  formatted: string;
  collateralValueUsd: number;
  cbBTCBalance: number;
  btcUsdPrice: number;
  btcPoolVirtualStablecoinUsd: number;
  xBTCSupply: number;
  /** Collateral value / xBTC market cap — same definition as xSOL's effectiveLeverage. */
  effectiveLeverage: number;
}

export async function queryXBTCPrice(params: XBTCPriceParams): Promise<PriceResult<XBTCPrice>> {
  const [balResult, priceResult, virtualStablecoinResult, supplyResult] = await Promise.all([
    queryTokenBalance(params.collateralWallet, CBBTC_MINT),
    queryPrice('BTC'),
    queryExoPoolVirtualStablecoinUsd(CBBTC_MINT),
    queryTokenSupply(params.xBTCMint),
  ]);

  if (!balResult.success) return { success: false, error: `cbBTC balance query failed: ${balResult.error}` };
  if (!priceResult.success) return { success: false, error: `BTC price unavailable: ${priceResult.error}` };
  if (!virtualStablecoinResult.success) return { success: false, error: `BTC pool virtual stablecoin supply unavailable: ${virtualStablecoinResult.error}` };
  if (!supplyResult.success) return { success: false, error: `xBTC supply query failed: ${supplyResult.error}` };

  const cbBTCBalance = balResult.data.uiAmount;
  const btcUsdPrice = priceResult.data.price;
  const collateralValueUsd = cbBTCBalance * btcUsdPrice;

  const btcPoolVirtualStablecoinUsd = virtualStablecoinResult.data;
  const xBTCSupply = supplyResult.data.uiAmount;

  if (xBTCSupply === 0) {
    return { success: false, error: 'xBTC supply is zero — cannot compute price.' };
  }

  const price = (collateralValueUsd - btcPoolVirtualStablecoinUsd) / xBTCSupply;
  const xBTCMarketCap = price * xBTCSupply;
  const effectiveLeverage = xBTCMarketCap > 0 ? collateralValueUsd / xBTCMarketCap : Infinity;

  logger.debug(
    { cbBTCBalance, btcUsdPrice, collateralValueUsd, btcPoolVirtualStablecoinUsd, xBTCSupply, price, effectiveLeverage },
    'xBTC price computed',
  );

  return {
    success: true,
    data: {
      price,
      formatted: `$${price.toFixed(4)}`,
      collateralValueUsd,
      cbBTCBalance,
      btcUsdPrice,
      btcPoolVirtualStablecoinUsd,
      xBTCSupply,
      effectiveLeverage,
    },
  };
}
