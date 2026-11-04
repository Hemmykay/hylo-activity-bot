/**
 * Pool watcher — DMs the dev when a collateral pool changes sharply.
 *
 * Why it exists: on 2026-11-03 almost all of the ZEC pool's hyUSD backing was redeemed in a single
 * step ($107K → $1), which took xZEC from 2.37x to 1.00x leverage. The bot's ticker showed it, but
 * nobody was told. This polls Hylo's market-state API once a minute, keeps a short in-memory
 * history per pool, and runs the pure rules in pool-events.ts against it.
 *
 * Delivery reuses the existing dev-alert DM (config.devAlert.userId), with its own headline.
 *
 * Quiet by design:
 *  - The first poll after a restart only records a baseline — it never alerts.
 *  - Per pool and per kind of change, one alert per COOLDOWN_MS. After an alert the pool's history
 *    resets, so the next comparison is against the new level rather than re-announcing the same step.
 *  - If the API stays unreachable for BLIND_AFTER_POLLS polls in a row, the dev is told once that
 *    the watcher is blind — otherwise silence would look like "all clear".
 *
 * Never throws; every failure is a log line.
 */
import { config } from '@/config/index.js';
import { createLogger } from '@/lib/logger.js';
import { notifyDev } from '@/services/dev-alert/dev-alert.service.js';
import { queryAllPoolHealth, type LevercoinSymbol, type PoolHealth } from '@/services/price/market-state.service.js';
import {
  WATCH_RULES,
  detectPoolFindings,
  fmtUsd,
  normalizeZone,
  type FindingKind,
  type PoolFinding,
  type PoolObservation,
  type PoolZone,
} from './pool-events.js';

const logger = createLogger('pool-watch');

const POLL_INTERVAL_MS = 60_000;
/** Debt and leverage moves repeat while a pool settles, so they're throttled. */
const COOLDOWN_MS = 30 * 60_000;
/**
 * Zone changes only fire on an actual transition, are rare, and a recovery matters as much as the
 * original alert — so they get a short cooldown that only exists to stop flapping across a
 * boundary from sending a DM every minute.
 */
const ZONE_COOLDOWN_MS = 5 * 60_000;
const BLIND_AFTER_POLLS = 10;
const BLIND_COOLDOWN_MS = 60 * 60_000;
const ALERT_LABEL = '📊 **Pool alert**';

const history = new Map<LevercoinSymbol, PoolObservation[]>();
const lastZone = new Map<LevercoinSymbol, PoolZone | null>();
const lastAlertAt = new Map<string, number>();
let missedPolls = 0;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** "XZEC" → "xZEC". */
function tokenName(symbol: LevercoinSymbol): string {
  return `x${symbol.slice(1)}`;
}

function toObservation(h: PoolHealth, at: number): PoolObservation {
  return {
    at,
    tvlUsd: h.tvlUsd,
    debtUsd: h.debtUsd,
    collateralRatio: h.collateralRatio,
    leverage: h.leverage,
    zone: normalizeZone(h.zone, h.collateralRatio),
  };
}

function formatAlert(symbol: LevercoinSymbol, findings: PoolFinding[], obs: PoolObservation): { title: string; details: string } {
  const bullets = findings.map((f) => `• ${f.line}`);
  const notes = [...new Set(findings.map((f) => f.note).filter((n): n is string => Boolean(n)))];
  const cr = obs.collateralRatio === null ? 'n/a' : obs.collateralRatio >= 100 ? '≫ 10,000%' : `${(obs.collateralRatio * 100).toFixed(0)}%`;
  const at = new Date(obs.at).toISOString().slice(11, 16);
  return {
    title: `${tokenName(symbol)} pool`,
    details: [
      ...bullets,
      ...(notes.length > 0 ? ['', notes.join(' ')] : []),
      '',
      `CR ${cr} · TVL ${fmtUsd(obs.tvlUsd)} · zone ${obs.zone ?? 'unknown'} · seen ${at} UTC`,
    ].join('\n'),
  };
}

/** Exported for tests: processes one poll's worth of pool data. Returns the alerts it would send. */
export function processPoll(
  pools: Partial<Record<LevercoinSymbol, PoolHealth>>,
  now: number,
): Array<{ symbol: LevercoinSymbol; kinds: FindingKind[]; title: string; details: string }> {
  const out: Array<{ symbol: LevercoinSymbol; kinds: FindingKind[]; title: string; details: string }> = [];

  for (const symbol of Object.keys(pools) as LevercoinSymbol[]) {
    const h = pools[symbol];
    if (!h) continue;

    const obs = toObservation(h, now);
    const recent = (history.get(symbol) ?? []).filter((o) => now - o.at <= WATCH_RULES.windowMs);
    const reference = recent[0] ?? null;
    const previousZone = lastZone.get(symbol) ?? null;
    lastZone.set(symbol, obs.zone);

    const fresh = detectPoolFindings(reference, obs, previousZone).filter(
      (f) => now - (lastAlertAt.get(`${symbol}:${f.kind}`) ?? -Infinity) >= (f.kind === 'zone' ? ZONE_COOLDOWN_MS : COOLDOWN_MS),
    );

    if (fresh.length === 0) {
      history.set(symbol, [...recent, obs]);
      continue;
    }

    for (const f of fresh) lastAlertAt.set(`${symbol}:${f.kind}`, now);
    history.set(symbol, [obs]); // compare future moves against the new level
    out.push({ symbol, kinds: fresh.map((f) => f.kind), ...formatAlert(symbol, fresh, obs) });
  }

  return out;
}

async function poll(): Promise<void> {
  const pools = await queryAllPoolHealth();
  if (!pools) {
    missedPolls++;
    if (missedPolls === BLIND_AFTER_POLLS) {
      logger.warn({ missedPolls }, 'Hylo market-state unavailable — pool watch is blind');
      await notifyDev(
        'Pool watch is blind',
        `Hylo's market-state API has been unreachable or stale for ${BLIND_AFTER_POLLS} minutes, so pool changes cannot be detected until it recovers.`,
        'pool-watch-blind',
        { cooldownMs: BLIND_COOLDOWN_MS },
      );
    }
    return;
  }
  missedPolls = 0;

  for (const alert of processPoll(pools, Date.now())) {
    logger.info({ symbol: alert.symbol, kinds: alert.kinds }, 'Pool alert — DMing dev');
    await notifyDev(alert.title, alert.details, `pool-watch:${alert.symbol}`, { cooldownMs: 0, label: ALERT_LABEL });
  }
}

async function loop(): Promise<void> {
  if (!running) return;
  try {
    await poll();
  } catch (err) {
    logger.error({ err }, 'Pool watch poll failed — will retry next cycle');
  }
  if (running) timer = setTimeout(() => { void loop(); }, POLL_INTERVAL_MS).unref();
}

export function startPoolWatch(): void {
  if (config.poolWatch.disabled) {
    logger.info('Pool watch disabled (POOL_WATCH_DISABLED=1)');
    return;
  }
  if (running) return;
  running = true;
  logger.info({ pollMs: POLL_INTERVAL_MS, cooldownMs: COOLDOWN_MS }, 'Pool watch started');
  void loop();
}

export function stopPoolWatch(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Test helper: clears all in-memory state. */
export function resetPoolWatchForTests(): void {
  history.clear();
  lastZone.clear();
  lastAlertAt.clear();
  missedPolls = 0;
}
