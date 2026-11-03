/**
 * xZEC price derivation, mirroring xhype.service.ts's formula but for the
 * ZEC (exogenous-collateral) pool:
 *
 * Collateral value = ZEC held in the ZEC pool's collateral wallet × ZEC/USD
 * xZEC price       = (Collateral value − ZEC pool's virtual stablecoin supply) / xZEC supply
 *
 * "ZEC pool's virtual stablecoin supply" is that pool's own on-chain
 * accounting of how much hyUSD backing is attributed to it specifically,
 * read directly from the Hylo Exchange program's ExoPair account (see
 * hylo-accounts.service.ts) — not the global hyUSD supply.
 *
 * ZEC/USD price comes from Jupiter (jupiter-price.service.ts), so it won't
 * track the protocol's own oracle number exactly tick-for-tick (the same
 * trade-off as xHYPE; see xhype.service.ts for why Pyth is no longer used).
 */
import { queryTokenBalance, queryTokenSupply } from '@/services/onchain/helius.service.js';
import { queryPrice } from '@/services/price/jupiter-price.service.js';
import { queryExoPoolVirtualStablecoinUsd } from '@/services/onchain/hylo-accounts.service.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('xzec-price');

// ZEC isn't a Hylo-native asset (no DB row) — same treatment as HYPE's fixed mint constant in xhype.service.ts.
const ZEC_MINT = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS';

export interface XZECPriceParams {
  collateralWallet: string;
  xZECMint: string;
}

export interface XZECPrice {
  price: number;
  formatted: string;
  collateralValueUsd: number;
  zecBalance: number;
  zecUsdPrice: number;
  zecPoolVirtualStablecoinUsd: number;
  xZECSupply: number;
  /** Collateral value / xZEC market cap — same definition as xSOL's effectiveLeverage. */
  effectiveLeverage: number;
}

export async function queryXZECPrice(params: XZECPriceParams): Promise<PriceResult<XZECPrice>> {
  const [balResult, priceResult, virtualStablecoinResult, supplyResult] = await Promise.all([
    queryTokenBalance(params.collateralWallet, ZEC_MINT),
    queryPrice('ZEC'),
    queryExoPoolVirtualStablecoinUsd(ZEC_MINT),
    queryTokenSupply(params.xZECMint),
  ]);

  if (!balResult.success) return { success: false, error: `ZEC balance query failed: ${balResult.error}` };
  if (!priceResult.success) return { success: false, error: `ZEC price unavailable: ${priceResult.error}` };
  if (!virtualStablecoinResult.success) return { success: false, error: `ZEC pool virtual stablecoin supply unavailable: ${virtualStablecoinResult.error}` };
  if (!supplyResult.success) return { success: false, error: `xZEC supply query failed: ${supplyResult.error}` };

  const zecBalance = balResult.data.uiAmount;
  const zecUsdPrice = priceResult.data.price;
  const collateralValueUsd = zecBalance * zecUsdPrice;

  const zecPoolVirtualStablecoinUsd = virtualStablecoinResult.data;
  const xZECSupply = supplyResult.data.uiAmount;

  if (xZECSupply === 0) {
    return { success: false, error: 'xZEC supply is zero — cannot compute price.' };
  }

  const price = (collateralValueUsd - zecPoolVirtualStablecoinUsd) / xZECSupply;
  const xZECMarketCap = price * xZECSupply;
  const effectiveLeverage = xZECMarketCap > 0 ? collateralValueUsd / xZECMarketCap : Infinity;

  logger.debug(
    { zecBalance, zecUsdPrice, collateralValueUsd, zecPoolVirtualStablecoinUsd, xZECSupply, price, effectiveLeverage },
    'xZEC price computed',
  );

  return {
    success: true,
    data: {
      price,
      formatted: `$${price.toFixed(4)}`,
      collateralValueUsd,
      zecBalance,
      zecUsdPrice,
      zecPoolVirtualStablecoinUsd,
      xZECSupply,
      effectiveLeverage,
    },
  };
}
