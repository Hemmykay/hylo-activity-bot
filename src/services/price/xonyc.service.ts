/**
 * xONYC price derivation, mirroring xhype.service.ts's formula but for the
 * ONYC (exogenous-collateral) pool:
 *
 * Collateral value = ONYC held in the ONYC pool's collateral wallet × ONYC/USD
 * xONYC price       = (Collateral value − ONYC pool's virtual stablecoin supply) / xONYC supply
 *
 * "ONYC pool's virtual stablecoin supply" is that pool's own on-chain
 * accounting of how much hyUSD backing is attributed to it specifically,
 * read directly from the Hylo Exchange program's ExoPair account (see
 * hylo-accounts.service.ts) — not the global hyUSD supply.
 *
 * ONyc/USD price comes from Jupiter (jupiter-price.service.ts), so it won't
 * track the protocol's own oracle number exactly tick-for-tick (the same
 * trade-off as xHYPE; see xhype.service.ts for why Pyth is no longer used).
 */
import { queryTokenBalance, queryTokenSupply } from '@/services/onchain/helius.service.js';
import { queryPrice } from '@/services/price/jupiter-price.service.js';
import { queryExoPoolVirtualStablecoinUsd } from '@/services/onchain/hylo-accounts.service.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('xonyc-price');

// ONyc (OnRe's yield-bearing reinsurance token) isn't a Hylo-native asset — same treatment as HYPE's fixed mint constant in xhype.service.ts.
const ONYC_MINT = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5';

export interface XONYCPriceParams {
  collateralWallet: string;
  xONYCMint: string;
}

export interface XONYCPrice {
  price: number;
  formatted: string;
  collateralValueUsd: number;
  onycBalance: number;
  onycUsdPrice: number;
  onycPoolVirtualStablecoinUsd: number;
  xONYCSupply: number;
  /** Collateral value / xONYC market cap — same definition as xSOL's effectiveLeverage. */
  effectiveLeverage: number;
}

export async function queryXONYCPrice(params: XONYCPriceParams): Promise<PriceResult<XONYCPrice>> {
  const [balResult, priceResult, virtualStablecoinResult, supplyResult] = await Promise.all([
    queryTokenBalance(params.collateralWallet, ONYC_MINT),
    queryPrice('ONYC'),
    queryExoPoolVirtualStablecoinUsd(ONYC_MINT),
    queryTokenSupply(params.xONYCMint),
  ]);

  if (!balResult.success) return { success: false, error: `ONYC balance query failed: ${balResult.error}` };
  if (!priceResult.success) return { success: false, error: `ONYC price unavailable: ${priceResult.error}` };
  if (!virtualStablecoinResult.success) return { success: false, error: `ONYC pool virtual stablecoin supply unavailable: ${virtualStablecoinResult.error}` };
  if (!supplyResult.success) return { success: false, error: `xONYC supply query failed: ${supplyResult.error}` };

  const onycBalance = balResult.data.uiAmount;
  const onycUsdPrice = priceResult.data.price;
  const collateralValueUsd = onycBalance * onycUsdPrice;

  const onycPoolVirtualStablecoinUsd = virtualStablecoinResult.data;
  const xONYCSupply = supplyResult.data.uiAmount;

  if (xONYCSupply === 0) {
    return { success: false, error: 'xONYC supply is zero — cannot compute price.' };
  }

  const price = (collateralValueUsd - onycPoolVirtualStablecoinUsd) / xONYCSupply;
  const xONYCMarketCap = price * xONYCSupply;
  const effectiveLeverage = xONYCMarketCap > 0 ? collateralValueUsd / xONYCMarketCap : Infinity;

  logger.debug(
    { onycBalance, onycUsdPrice, collateralValueUsd, onycPoolVirtualStablecoinUsd, xONYCSupply, price, effectiveLeverage },
    'xONYC price computed',
  );

  return {
    success: true,
    data: {
      price,
      formatted: `$${price.toFixed(4)}`,
      collateralValueUsd,
      onycBalance,
      onycUsdPrice,
      onycPoolVirtualStablecoinUsd,
      xONYCSupply,
      effectiveLeverage,
    },
  };
}
