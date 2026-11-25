/**
 * Durable progress for the mint watcher: what survives a redeploy and what lets the API-feed path and
 * the RPC fallback hand over to each other without losing or double-posting events.
 *
 *  - feed high-water mark (slot): everything at or below it has been handled. After any restart,
 *    fall-back stint or outage the feed reader pages back until it reaches this slot, so the gap is
 *    filled instead of skipped.
 *  - ledger floor (ms): when the daily window was last wiped. Backfilled events older than this
 *    belong to an already-posted summary and must not re-enter the new one.
 *  - RPC scan checkpoints (newest signature per asset) plus a heartbeat written on every RPC-mode tick:
 *    a restart while in RPC fall-back resumes from where it stopped. They are only trusted when the
 *    heartbeat is recent — checkpoints go stale while the feed path is in charge, and replaying from a
 *    stale one would announce hours of old history as "new" alerts. (A quiet pool leaves its checkpoint
 *    unchanged for hours, which is why the heartbeat, not the checkpoint's own age, is the signal.)
 *  - alert claims: one row per posted alert (see AlertedEvent), so the same event reported by two
 *    sources, or re-read after a restart, is announced once.
 *
 * Everything here is best-effort and never throws: a database hiccup degrades to the old in-memory
 * behaviour (and fails open for alerts — a rare duplicate beats a missed alert).
 */
import { alertedEventRepository, watcherStateRepository } from '@/db/repositories/watcher-state.repository.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('watcher-progress');

const KEY_FEED_HWM = 'feed.hwmSlot';
const KEY_LEDGER_FLOOR = 'ledger.floorMs';
const RPC_PREFIX = 'rpc.';
const KEY_RPC_HEARTBEAT = 'rpcActive.atMs';
/** A redeploy takes minutes; anything older than this is more likely stale than useful. */
export const RPC_CHECKPOINT_MAX_AGE_MS = 30 * 60_000;
const ALERT_RETENTION_MS = 3 * 24 * 60 * 60_000;

export interface LoadedProgress {
  feedHwmSlot: number | null;
  ledgerFloorMs: number;
  rpcMint: Map<string, string>;
  rpcBurn: Map<string, string>;
}

export async function loadProgress(): Promise<LoadedProgress> {
  const out: LoadedProgress = { feedHwmSlot: null, ledgerFloorMs: 0, rpcMint: new Map(), rpcBurn: new Map() };
  try {
    const hwm = Number(await watcherStateRepository.get(KEY_FEED_HWM));
    if (Number.isFinite(hwm) && hwm > 0) out.feedHwmSlot = hwm;
    const floor = Number(await watcherStateRepository.get(KEY_LEDGER_FLOOR));
    if (Number.isFinite(floor) && floor > 0) out.ledgerFloorMs = floor;

    const heartbeat = Number(await watcherStateRepository.get(KEY_RPC_HEARTBEAT));
    const rpcFresh = Number.isFinite(heartbeat) && Date.now() - heartbeat <= RPC_CHECKPOINT_MAX_AGE_MS;
    const rows = rpcFresh ? await watcherStateRepository.getMany(RPC_PREFIX) : [];
    for (const row of rows) {
      // key: rpc.mint.<SYMBOL> | rpc.burn.<SYMBOL>
      const [, kind, ...rest] = row.key.split('.');
      const symbol = rest.join('.');
      if (!symbol || (kind !== 'mint' && kind !== 'burn')) continue;
      (kind === 'mint' ? out.rpcMint : out.rpcBurn).set(symbol, row.value);
    }
    logger.info(
      { feedHwmSlot: out.feedHwmSlot, ledgerFloorMs: out.ledgerFloorMs || null, rpcCheckpoints: out.rpcMint.size + out.rpcBurn.size },
      'Watcher progress loaded',
    );
  } catch (err) {
    logger.warn({ err }, 'Could not load watcher progress — starting from "now" like a fresh install');
  }
  return out;
}

async function safeSet(key: string, value: string): Promise<void> {
  try {
    await watcherStateRepository.set(key, value);
  } catch (err) {
    logger.warn({ err, key }, 'Could not persist watcher progress — a restart may re-read a little history');
  }
}

export const saveFeedHwm = (slot: number): Promise<void> => safeSet(KEY_FEED_HWM, String(slot));
export const saveLedgerFloor = (ms: number): Promise<void> => safeSet(KEY_LEDGER_FLOOR, String(ms));
export const saveRpcHeartbeat = (): Promise<void> => safeSet(KEY_RPC_HEARTBEAT, String(Date.now()));
export const saveRpcCheckpoint = (kind: 'mint' | 'burn', symbol: string, signature: string): Promise<void> =>
  safeSet(`${RPC_PREFIX}${kind}.${symbol}`, signature);

/** True when this caller should post the alert. Fails open (true) if the claim can't be recorded. */
export async function claimAlert(key: string): Promise<boolean> {
  try {
    return await alertedEventRepository.claim(key);
  } catch (err) {
    logger.warn({ err, key }, 'Alert claim failed — posting anyway (a rare duplicate beats a missed alert)');
    return true;
  }
}

export async function releaseAlert(key: string): Promise<void> {
  try {
    await alertedEventRepository.release(key);
  } catch (err) {
    logger.warn({ err, key }, 'Could not release alert claim');
  }
}

export async function pruneAlertClaims(): Promise<void> {
  try {
    const n = await alertedEventRepository.prune(new Date(Date.now() - ALERT_RETENTION_MS));
    if (n > 0) logger.debug({ pruned: n }, 'Pruned old alert claims');
  } catch (err) {
    logger.warn({ err }, 'Could not prune alert claims');
  }
}
