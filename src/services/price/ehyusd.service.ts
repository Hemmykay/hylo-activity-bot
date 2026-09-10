/**
 * eHYUSD price derivation.
 *
 * eHYUSD price = (xSOL value in the collateral wallet + hyUSD value in the
 * collateral wallet) / eHYUSD supply.
 *
 * hyUSD is a $1-pegged stablecoin, so its supply in tokens equals its USD value.
 * xSOL has no direct price feed — its price is itself derived (see xsol.service.ts) —
 * so computing eHYUSD's price requires computing xSOL's price first.
 */
import { queryTokenBalance, queryTokenSupply } from '@/services/onchain/helius.service.js';
import { queryXSOLPrice, type XSOLPriceParams } from '@/services/price/xsol.service.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('ehyusd-price');

// hyUSD is a 1:1 USD-pegged stablecoin — its price is fixed by design, not fetched.
const HYUSD_PEG_PRICE = 1;

export interface EHYUSDPriceParams {
  collateralWallet: string;
  xSOLMint: string;
  hyUSDMint: string;
  eHYUSDMint: string;
  xSOLPriceParams: XSOLPriceParams;
  /** Skip the nested xSOL RPC stack when the caller already resolved xSOL/USD. */
  xSOLUsdPrice?: number;
}

export interface EHYUSDPrice {
  price: number;
  formatted: string;
  xSOLBalance: number;
  xSOLPrice: number;
  xSOLValue: number;
  hyUSDBalance: number;
  hyUSDValue: number;
  eHYUSDSupply: number;
}

export async function queryEHYUSDPrice(params: EHYUSDPriceParams): Promise<PriceResult<EHYUSDPrice>> {
  const xSOLPricePromise = params.xSOLUsdPrice !== undefined
    ? Promise.resolve({ success: true as const, data: { price: params.xSOLUsdPrice } })
    : queryXSOLPrice(params.xSOLPriceParams);

  const [xSOLBalResult, xSOLPriceResult, hyUSDBalResult, supplyResult] = await Promise.all([
    queryTokenBalance(params.collateralWallet, params.xSOLMint),
    xSOLPricePromise,
    queryTokenBalance(params.collateralWallet, params.hyUSDMint),
    queryTokenSupply(params.eHYUSDMint),
  ]);

  if (!xSOLBalResult.success)   return { success: false, error: `xSOL balance query failed: ${xSOLBalResult.error}` };
  if (!xSOLPriceResult.success) return { success: false, error: `xSOL price unavailable: ${xSOLPriceResult.error}` };
  if (!hyUSDBalResult.success)  return { success: false, error: `hyUSD balance query failed: ${hyUSDBalResult.error}` };
  if (!supplyResult.success)    return { success: false, error: `eHYUSD supply query failed: ${supplyResult.error}` };

  const xSOLBalance = xSOLBalResult.data.uiAmount;
  const xSOLPrice   = xSOLPriceResult.data.price;
  const xSOLValue   = xSOLBalance * xSOLPrice;

  const hyUSDBalance = hyUSDBalResult.data.uiAmount;
  const hyUSDValue   = hyUSDBalance * HYUSD_PEG_PRICE;

  const eHYUSDSupply = supplyResult.data.uiAmount;
  if (eHYUSDSupply === 0) {
    return { success: false, error: 'eHYUSD supply is zero — cannot compute price.' };
  }

  const price = (xSOLValue + hyUSDValue) / eHYUSDSupply;

  logger.debug(
    { xSOLBalance, xSOLPrice, hyUSDBalance, eHYUSDSupply, price },
    'eHYUSD price computed',
  );

  return {
    success: true,
    data: {
      price,
      formatted: `$${price.toFixed(4)}`,
      xSOLBalance,
      xSOLPrice,
      xSOLValue,
      hyUSDBalance,
      hyUSDValue,
      eHYUSDSupply,
    },
  };
}
