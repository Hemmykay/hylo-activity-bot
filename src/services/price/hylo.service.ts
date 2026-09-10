/**
 * Hylo-specific price calculations.
 *
 * hyloSOL / hyloSOL+ price derivation:
 *   1. staked_SOL  = sum of active delegation.stake across all vault stake accounts
 *   2. token_supply = getTokenSupply on the LST mint
 *   3. exchange_rate = staked_SOL / token_supply  (starts at 1.0, grows with yield)
 *   4. price = SOL/USD × exchange_rate
 *
 * Stake accounts are stored per-asset in the DB (set via /asset configure).
 * All three external calls run in parallel and each is independently fallible.
 */
import { queryStakeAccounts, queryTokenSupply } from '@/services/onchain/helius.service.js';
import { queryPrice } from '@/services/price/jupiter-price.service.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';

const logger = createLogger('hylo-price');

export interface HyloSOLPrice {
  price: number;
  formatted: string;
  exchangeRate: number;
  stakedSOL: number;
  tokenSupply: number;
  solPrice: number;
}

/**
 * Compute the USD price of any Hylo LST given its stake account addresses and mint.
 * Stake accounts are comma-separated strings stored on the Asset DB record.
 */
export async function queryLSTPrice(
  stakeAccounts: string[],
  mintAddress: string,
): Promise<PriceResult<HyloSOLPrice>> {
  const [stakeResult, supplyResult, solPriceResult] = await Promise.all([
    queryStakeAccounts(stakeAccounts),
    queryTokenSupply(mintAddress),
    queryPrice('SOL'),
  ]);

  if (!stakeResult.success) {
    logger.warn({ error: stakeResult.error }, 'LST: stake accounts query failed');
    return { success: false, error: `Could not fetch vault stake balance: ${stakeResult.error}` };
  }
  if (!supplyResult.success) {
    logger.warn({ error: supplyResult.error }, 'LST: token supply query failed');
    return { success: false, error: `Could not fetch token supply: ${supplyResult.error}` };
  }
  if (!solPriceResult.success) {
    logger.warn({ error: solPriceResult.error }, 'LST: SOL price query failed');
    return { success: false, error: `Could not fetch SOL price: ${solPriceResult.error}` };
  }

  const stakedSOL   = stakeResult.data.sol;
  const tokenSupply = supplyResult.data.uiAmount;
  const solPrice    = solPriceResult.data.price;

  if (tokenSupply === 0) {
    return { success: false, error: 'Token total supply is zero — cannot compute exchange rate.' };
  }

  const exchangeRate = stakedSOL / tokenSupply;
  const price        = solPrice * exchangeRate;

  logger.debug({ stakedSOL, tokenSupply, exchangeRate, solPrice, price }, 'LST price computed');

  return {
    success: true,
    data: { price, formatted: `$${price.toFixed(4)}`, exchangeRate, stakedSOL, tokenSupply, solPrice },
  };
}
