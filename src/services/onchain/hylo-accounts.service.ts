/**
 * Reads Hylo Exchange program accounts directly (not via the generic
 * SPL-token RPC calls used elsewhere in this service layer) to get each
 * collateral pool's own "virtual stablecoin" supply — the hyUSD backing
 * specifically attributed to that pool.
 *
 * This matters because xASSET pricing is per-pool: `xASSET price =
 * (pool collateral value − that pool's virtual stablecoin supply) / xASSET
 * supply`. Subtracting the *global* hyUSD supply (as if one pool backed all
 * of it) was a fine approximation when SOL was the only pool, but is now
 * measurably wrong with a second (BTC) pool holding its own share.
 *
 * Account addresses are fixed PDAs (program ID + a constant seed, optionally
 * + a collateral mint) — derived once with @solana/web3.js and hardcoded
 * here, the same pattern already used for fixed collateral wallet addresses
 * in xsol.service.ts. See hylo-idl/src/pda.rs in https://github.com/hylo-so/sdk
 * for the derivation (seeds "hylo" and "exo_pair"+mint, both under the
 * Exchange program HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn).
 */
import { queryAccountData } from '@/services/onchain/helius.service.js';
import { decodeAccount, getPath, ufixValue64ToNumber, type HyloIdl } from '@/services/onchain/idl-decoder.js';
import { createLogger } from '@/lib/logger.js';
import type { PriceResult } from '@/services/price/jupiter-price.service.js';
import hyloExchangeIdl from './idl/hylo_exchange.json' with { type: 'json' };

const logger = createLogger('hylo-accounts');

const idl = hyloExchangeIdl as HyloIdl;

// Fixed PDAs — see file header for derivation.
const HYLO_ACCOUNT = '9cd2sAfbBvKs4SX9YKo4dcjwP3TgTVQ8dT5koshGcDND';
const EXO_PAIR_ACCOUNTS: Record<string, string> = {
  // cbBTC's exo_pair — live since 2026-07.
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: '8mgw2TsNxTMndWPyswLELw3V2tPrPvtqS7Ex9RyiGhML',
  // HYPE's exo_pair — live since 2026-08. Both addresses derived from the Exchange program's
  // own PDA seeds (EXO_PAIR / EXO_VAULT_AUTH, see hylo-idl/src/pda.rs in
  // https://github.com/hylo-so/sdk) and cross-checked against the account's own on-chain
  // fields: collateral_mint round-trips to this same HYPE mint, and levercoin_mint round-trips
  // to XHYPE's own token address — so this isn't just "a valid PDA", it's confirmed live.
  '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g': '42GzNWvZ1H1hwXaBZ8mbeVZaSEgh6zMm8BABdS3v1BEB',
};

/** The SOL/LST pool's own virtual-stablecoin supply — the hyUSD backing attributed to the SOL pool specifically. */
export async function querySolPoolVirtualStablecoinUsd(): Promise<PriceResult<number>> {
  const result = await queryAccountData(HYLO_ACCOUNT);
  if (!result.success) return { success: false, error: `Hylo account fetch failed: ${result.error}` };
  try {
    const decoded = decodeAccount(idl, 'Hylo', result.data);
    const supply = ufixValue64ToNumber(getPath(decoded, 'virtual_stablecoin.supply'));
    logger.debug({ supply }, 'SOL pool virtual stablecoin supply decoded');
    return { success: true, data: supply };
  } catch (err) {
    logger.warn({ err }, 'Failed to decode Hylo account');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/** An exogenous pool's own virtual-stablecoin supply, keyed by its collateral mint (e.g. cbBTC). Returns an error if that mint has no live pool yet. */
export async function queryExoPoolVirtualStablecoinUsd(collateralMint: string): Promise<PriceResult<number>> {
  const exoPairAddress = EXO_PAIR_ACCOUNTS[collateralMint];
  if (!exoPairAddress) return { success: false, error: `No known exo_pair account for collateral mint ${collateralMint} — pool may not be live yet.` };

  const result = await queryAccountData(exoPairAddress);
  if (!result.success) return { success: false, error: `ExoPair account fetch failed: ${result.error}` };
  try {
    const decoded = decodeAccount(idl, 'ExoPair', result.data);
    const supply = ufixValue64ToNumber(getPath(decoded, 'virtual_stablecoin.supply'));
    logger.debug({ collateralMint, supply }, 'Exo pool virtual stablecoin supply decoded');
    return { success: true, data: supply };
  } catch (err) {
    logger.warn({ err, collateralMint }, 'Failed to decode ExoPair account');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}
