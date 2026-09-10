/**
 * xSOL price derivation, plus two protocol-health metrics computed from the
 * same intermediate values — no extra RPC calls needed. All three formulas
 * are from https://docs.hylo.so/technical-addendum/hylo-equations :
 *
 * Collateral TVL = (jitoSOL held in collateral wallet × jitoSOL/USD)
 *                + (hyloSOL held in collateral wallet × hyloSOL/USD)
 *
 * xSOL price         = (Collateral TVL − SOL pool's virtual stablecoin supply) / xSOL supply
 * Collateral Ratio   = Collateral TVL / SOL pool's virtual stablecoin supply  ("health of the SOL pool")
 * Effective Leverage = Collateral TVL / (xSOL price × xSOL supply)
 *
 * "SOL pool's virtual stablecoin supply" is read directly from the Hylo
 * Exchange program's global `Hylo` account (see hylo-accounts.service.ts) —
 * it's the hyUSD backing attributed to the SOL pool specifically, NOT the
 * same thing as hyUSD's total SPL supply. Now that a second (BTC) pool
 * exists with its own share, subtracting the *global* supply here (as this
 * file used to) would double-count hyUSD the BTC pool already accounts for
 * in xbtc.service.ts's calculation.
 *
 * All six external calls (2 balances, 2 prices, 1 pool-account read, 1 supply) run in parallel.
 */
import { queryTokenBalance, queryTokenSupply } from '@/services/onchain/helius.service.js';
import { queryPrice } from '@/services/price/jupiter-price.service.js';
import { queryLSTPrice } from '@/services/price/hylo.service.js';
import { querySolPoolVirtualStablecoinUsd } from '@/services/onchain/hylo-accounts.service.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('xsol-price');

// ─── Collateral config ────────────────────────────────────────────────────────
// Wallets holding the external collateral that backs xSOL and hyUSD.
// Hylo-specific addresses — update here if wallets ever rotate.

const JITOSOL_COLLATERAL_WALLET = '82MNhUCha26wY4kohTUEC965b4ypEe7RPa4itp9UMrKK';
const JITOSOL_MINT               = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const HYLOSOL_COLLATERAL_WALLET  = 'FD4gzYopoeeQYzYiyV62VjCRkyYD36uoVaRnZGE9kwZF';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface XSOLPriceParams {
  hyloSOLMint: string;
  hyloSOLStakeAccounts: string[];
  xSOLMint: string;
}

export interface XSOLPrice {
  price: number;
  formatted: string;
  collateralTVL: number;
  jitoSOLBalance: number;
  jitoSOLPrice: number;
  jitoSOLValue: number;
  hyloSOLBalance: number;
  hyloSOLPrice: number;
  hyloSOLValue: number;
  /** SOL pool's own virtual stablecoin supply (hyUSD backing attributed to this pool specifically) — NOT hyUSD's total SPL supply. */
  solPoolVirtualStablecoinUsd: number;
  xSOLSupply: number;
  /** Collateral TVL / SOL pool virtual stablecoin supply — protocol's stated "health level" of the SOL pool. */
  collateralRatio: number;
  /** Collateral TVL / xSOL market cap. */
  effectiveLeverage: number;
}

// ─── Main calculation ─────────────────────────────────────────────────────────

export async function queryXSOLPrice(params: XSOLPriceParams): Promise<PriceResult<XSOLPrice>> {
  const [
    jitoSOLBalResult,
    jitoSOLPriceResult,
    hyloSOLBalResult,
    hyloSOLPriceResult,
    virtualStablecoinResult,
    xSOLSupplyResult,
  ] = await Promise.all([
    queryTokenBalance(JITOSOL_COLLATERAL_WALLET, JITOSOL_MINT),
    queryPrice('JITOSOL'),
    queryTokenBalance(HYLOSOL_COLLATERAL_WALLET, params.hyloSOLMint),
    queryLSTPrice(params.hyloSOLStakeAccounts, params.hyloSOLMint),
    querySolPoolVirtualStablecoinUsd(),
    queryTokenSupply(params.xSOLMint),
  ]);

  if (!jitoSOLBalResult.success)      return { success: false, error: `jitoSOL balance query failed: ${jitoSOLBalResult.error}` };
  if (!jitoSOLPriceResult.success)    return { success: false, error: `jitoSOL price unavailable: ${jitoSOLPriceResult.error}` };
  if (!hyloSOLBalResult.success)      return { success: false, error: `hyloSOL balance query failed: ${hyloSOLBalResult.error}` };
  if (!hyloSOLPriceResult.success)    return { success: false, error: `hyloSOL price unavailable: ${hyloSOLPriceResult.error}` };
  if (!virtualStablecoinResult.success) return { success: false, error: `SOL pool virtual stablecoin supply unavailable: ${virtualStablecoinResult.error}` };
  if (!xSOLSupplyResult.success)      return { success: false, error: `xSOL supply query failed: ${xSOLSupplyResult.error}` };

  const jitoSOLBalance = jitoSOLBalResult.data.uiAmount;
  const jitoSOLPrice   = jitoSOLPriceResult.data.price;
  const jitoSOLValue   = jitoSOLBalance * jitoSOLPrice;

  const hyloSOLBalance = hyloSOLBalResult.data.uiAmount;
  const hyloSOLPrice   = hyloSOLPriceResult.data.price;
  const hyloSOLValue   = hyloSOLBalance * hyloSOLPrice;

  const solPoolVirtualStablecoinUsd = virtualStablecoinResult.data;
  const xSOLSupply = xSOLSupplyResult.data.uiAmount;

  if (xSOLSupply === 0) {
    return { success: false, error: 'xSOL supply is zero — cannot compute price.' };
  }

  const collateralTVL = jitoSOLValue + hyloSOLValue;
  const price         = (collateralTVL - solPoolVirtualStablecoinUsd) / xSOLSupply;

  // solPoolVirtualStablecoinUsd === 0 would also make collateralRatio undefined/Infinity —
  // guard separately from the xSOLSupply check above since either denominator can
  // independently be zero.
  const collateralRatio   = solPoolVirtualStablecoinUsd > 0 ? collateralTVL / solPoolVirtualStablecoinUsd : Infinity;
  const xSOLMarketCap     = price * xSOLSupply;
  const effectiveLeverage = xSOLMarketCap > 0 ? collateralTVL / xSOLMarketCap : Infinity;

  logger.debug(
    { jitoSOLBalance, jitoSOLPrice, hyloSOLBalance, hyloSOLPrice, collateralTVL, solPoolVirtualStablecoinUsd, xSOLSupply, price, collateralRatio, effectiveLeverage },
    'xSOL price computed',
  );

  return {
    success: true,
    data: {
      price,
      formatted: `$${price.toFixed(4)}`,
      collateralTVL,
      jitoSOLBalance,
      jitoSOLPrice,
      jitoSOLValue,
      hyloSOLBalance,
      hyloSOLPrice,
      hyloSOLValue,
      solPoolVirtualStablecoinUsd,
      xSOLSupply,
      collateralRatio,
      effectiveLeverage,
    },
  };
}
