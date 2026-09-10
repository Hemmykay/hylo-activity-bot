/**
 * Maps Hylo Public API v1 activity events (eventType + eventData, amounts
 * already decimal-adjusted) to the mint-watcher's alert/ledger actions.
 *
 * The mapping preserves exactly what the bot's raw-transaction scanners
 * (queryMintEvents / queryBurnEvents / queryStakeEvents) reported before the
 * API became the primary source — verified instruction-by-instruction against
 * the live feed on 2026-09-02 before cutover:
 *  - every non-revenue, non-stability-pool mintTo  → 'mint'   (alert + ledger)
 *  - every non-stability-pool burn                 → 'burn'   (ledger only —
 *    burns have never had a live alert, the daily summary is their surface)
 *  - UserDeposit (eHYUSD staking)                  → 'stake'  (alert, no ledger —
 *    staking is a transfer of already-minted hyUSD, not a supply flow)
 *  - swaps appear as a mint of one side + a burn of the other, same as the
 *    raw mintTo/burn pairs the scanners used to classify from those txs
 *  - HarvestYield / HarvestBorrowRate / SettleRebalancePnl / SwapExoToUsdc /
 *    UserWithdraw are protocol or pool-level flows the scanners always
 *    excluded → ignored
 *
 * Stability Pool Offload/Deployment is NOT mapped here: those alerts come
 * from the dedicated pool-wallet watcher (see mint-watcher.service.ts), since
 * the feed does not yet expose a dedicated event type for the paired
 * burn+mint rebalance legs.
 */
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('feed-events');

export type FeedAction =
  | { kind: 'mint'; symbol: string; amount: number; signature: string }
  | { kind: 'burn'; symbol: string; amount: number; signature: string }
  | { kind: 'stake'; amount: number; signature: string };

export interface FeedEvent {
  signature: string;
  eventIndex: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

// Exogenous-collateral mint → levercoin the bot tracks. A new pool going live
// needs a row here, same as the hardcoded ExoPair accounts in
// hylo-accounts.service.ts.
const EXO_SYMBOL_BY_COLLATERAL: Record<string, string> = {
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 'XBTC', // cbBTC
  '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g': 'XHYPE', // HYPE
};

function num(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function exoSymbol(collateralMint: unknown): string | null {
  const sym = typeof collateralMint === 'string' ? EXO_SYMBOL_BY_COLLATERAL[collateralMint] : undefined;
  if (!sym) {
    logger.warn({ collateralMint }, 'Feed event references an unknown exogenous collateral — skipping (add it to EXO_SYMBOL_BY_COLLATERAL)');
  }
  return sym ?? null;
}

function mint(action: FeedAction[], ev: FeedEvent, symbol: string, key: string): void {
  const amount = num(ev.eventData[key]);
  if (amount === null || amount <= 0) {
    logger.debug({ eventType: ev.eventType, key, value: ev.eventData[key] }, 'Feed event missing usable amount — skipping');
    return;
  }
  action.push({ kind: 'mint', symbol, amount, signature: ev.signature });
}

function burn(action: FeedAction[], ev: FeedEvent, symbol: string, key: string): void {
  const amount = num(ev.eventData[key]);
  if (amount === null || amount <= 0) return; // silent: zero-amount legs are ordinary
  action.push({ kind: 'burn', symbol, amount, signature: ev.signature });
}

/**
 * Maps a batch of feed events (any order; output preserves input order) to
 * alert/ledger actions. Unknown event types are ignored — the API "may add
 * fields without notice" (its own docs), so forward compatibility means
 * doing nothing rather than guessing.
 */
export function mapFeedEventsToActions(events: FeedEvent[]): FeedAction[] {
  const actions: FeedAction[] = [];

  for (const ev of events) {
    const d = ev.eventData ?? {};
    switch (ev.eventType) {
      case 'MintStablecoin':
        mint(actions, ev, 'HYUSD', 'stablecoin_minted');
        break;
      case 'SwapLeverToStable':
        mint(actions, ev, 'HYUSD', 'stablecoin_minted_user');
        burn(actions, ev, 'XSOL', 'levercoin_burned');
        break;
      case 'MintLevercoin':
        mint(actions, ev, 'XSOL', 'minted');
        break;
      case 'SwapStableToLever':
        mint(actions, ev, 'XSOL', 'levercoin_minted');
        burn(actions, ev, 'HYUSD', 'stablecoin_burned');
        break;
      case 'RedeemStablecoin':
        burn(actions, ev, 'HYUSD', 'stablecoin_burned');
        break;
      case 'RedeemLevercoin':
        burn(actions, ev, 'XSOL', 'redeemed');
        break;
      case 'MintLevercoinExo': {
        const sym = exoSymbol(d.collateral_mint);
        if (sym) mint(actions, ev, sym, 'minted');
        break;
      }
      case 'RedeemLevercoinExo': {
        const sym = exoSymbol(d.collateral_mint);
        if (sym) burn(actions, ev, sym, 'redeemed');
        break;
      }
      case 'SwapStableToLeverExo': {
        const sym = exoSymbol(d.collateral_mint);
        if (sym) mint(actions, ev, sym, 'levercoin_minted');
        burn(actions, ev, 'HYUSD', 'stablecoin_burned');
        break;
      }
      case 'SwapLeverToStableExo': {
        mint(actions, ev, 'HYUSD', 'stablecoin_minted_user');
        const sym = exoSymbol(d.collateral_mint);
        if (sym) burn(actions, ev, sym, 'levercoin_burned');
        break;
      }
      case 'UserDeposit': {
        const amount = num(d.lp_token_minted);
        if (amount !== null && amount > 0) actions.push({ kind: 'stake', amount, signature: ev.signature });
        break;
      }
      default:
        // UserWithdraw, HarvestYield, HarvestBorrowRate, SettleRebalancePnl,
        // SwapExoToUsdc, and anything new — no bot-facing action today.
        break;
    }
  }

  return actions;
}
