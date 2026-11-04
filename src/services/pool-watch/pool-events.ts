/**
 * Pure detection rules for the pool watcher — no Discord, config, or network in here, so the
 * exact rules can be replayed against recorded pool history (see pool-watch.service.ts for the
 * loop that feeds it live data and sends the DMs).
 *
 * Three kinds of "something changed that a human should know about":
 *  - debt:     the pool's hyUSD backing jumped or collapsed (e.g. nearly all of it redeemed, or a
 *              large mint). This is what made xZEC go from 2.37x to 1.00x in one step.
 *  - leverage: the x-token's effective leverage (TVL / equity) moved sharply.
 *  - zone:     the pool entered or left a Sell Zone / destabilized state — de-leveraging stress.
 *              Buy zones are deliberately NOT alerted on: they're a routine state (high CR).
 *
 * Thresholds were chosen against 7 days of real 5-minute history (2026-10-28 → 11-03): SOL, cbBTC
 * and HYPE never exceeded 22% debt / 15% leverage movement in any 15-minute window, so these
 * rules stay silent for them while still catching both ZEC incidents on 2026-11-03.
 */

export type PoolZone = 'Depeg' | 'SellZone2' | 'SellZone1' | 'Neutral' | 'BuyZone1' | 'BuyZone2';

export interface PoolObservation {
  /** Epoch ms. */
  at: number;
  tvlUsd: number;
  /** The pool's own hyUSD backing (virtual stablecoin supply). */
  debtUsd: number;
  collateralRatio: number | null;
  /** TVL / (TVL − debt); null when there is no equity left. */
  leverage: number | null;
  zone: PoolZone | null;
}

export type FindingKind = 'debt' | 'leverage' | 'zone';

export interface PoolFinding {
  kind: FindingKind;
  /** One bullet line for the DM. */
  line: string;
  /** Optional plain-English meaning, shown once under the bullets. */
  note?: string | undefined;
}

export const WATCH_RULES = {
  /** How far back a "sudden" change is measured against. */
  windowMs: 15 * 60_000,
  /** Debt must move by at least this fraction of its earlier value AND by at least debtAbsUsd. */
  debtRel: 0.5,
  debtAbsUsd: 25_000,
  /** Leverage must move by at least this fraction AND at least leverageAbs (in x). */
  leverageRel: 0.3,
  leverageAbs: 0.5,
  /** Ignore dust pools: at least one side of the comparison must hold this much. */
  minTvlUsd: 25_000,
} as const;

const RISK_ZONES: ReadonlySet<PoolZone> = new Set(['Depeg', 'SellZone2', 'SellZone1']);

export function isRiskZone(zone: PoolZone | null): boolean {
  return zone !== null && RISK_ZONES.has(zone);
}

/** Zone boundaries from Hylo's docs (Hylo Equations → Rebalance Zones). */
export function zoneFromCr(cr: number): PoolZone {
  if (cr < 1.0) return 'Depeg';
  if (cr < 1.2) return 'SellZone2';
  if (cr < 1.35) return 'SellZone1';
  if (cr < 1.65) return 'Neutral';
  if (cr < 1.75) return 'BuyZone1';
  return 'BuyZone2';
}

/** Prefers Hylo's own label; falls back to deriving it from CR. Unknown labels → derive. */
export function normalizeZone(label: string | null, cr: number | null): PoolZone | null {
  const l = (label ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (l.startsWith('depeg') || l.startsWith('destab')) return 'Depeg';
  if (l === 'sellzone2') return 'SellZone2';
  if (l === 'sellzone1') return 'SellZone1';
  if (l === 'neutral') return 'Neutral';
  if (l === 'buyzone1') return 'BuyZone1';
  if (l === 'buyzone2') return 'BuyZone2';
  return cr !== null && Number.isFinite(cr) ? zoneFromCr(cr) : null;
}

export function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(ratio: number): string {
  const pct = ratio * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`;
}

function fmtLev(l: number | null): string {
  return l === null ? 'undefined (no equity left)' : `${l.toFixed(2)}x`;
}

/**
 * `reference` is the oldest observation still inside the window (null on the first poll, when
 * there's nothing to compare against). `previousZone` is the zone seen on the last poll.
 */
export function detectPoolFindings(
  reference: PoolObservation | null,
  current: PoolObservation,
  previousZone: PoolZone | null,
): PoolFinding[] {
  const findings: PoolFinding[] = [];

  if (reference && (current.tvlUsd >= WATCH_RULES.minTvlUsd || reference.tvlUsd >= WATCH_RULES.minTvlUsd)) {
    const debtDelta = current.debtUsd - reference.debtUsd;
    const debtMoved = Math.abs(debtDelta);
    const debtReported = debtMoved >= WATCH_RULES.debtAbsUsd && debtMoved >= WATCH_RULES.debtRel * Math.max(reference.debtUsd, 1);
    if (debtReported) {
      findings.push({
        kind: 'debt',
        line: `hyUSD backing: ${fmtUsd(reference.debtUsd)} → ${fmtUsd(current.debtUsd)} (${fmtPct(debtDelta / Math.max(reference.debtUsd, 1))})`,
        note: debtDelta < 0
          ? 'hyUSD was redeemed out of this pool, so it carries less debt behind its collateral.'
          : 'hyUSD was minted against this pool, so it carries more debt behind its collateral.',
      });
    }

    if (reference.leverage !== null && current.leverage !== null) {
      const levMoved = Math.abs(current.leverage - reference.leverage);
      if (levMoved >= WATCH_RULES.leverageAbs && levMoved >= WATCH_RULES.leverageRel * reference.leverage) {
        // Say why when the debt moved noticeably but not enough to get its own bullet.
        const debtShifted = !debtReported && debtMoved >= 0.25 * Math.max(reference.debtUsd, 1);
        findings.push({
          kind: 'leverage',
          line: `Leverage: ${fmtLev(reference.leverage)} → ${fmtLev(current.leverage)}${
            debtShifted ? ` (hyUSD backing ${fmtUsd(reference.debtUsd)} → ${fmtUsd(current.debtUsd)})` : ''
          }`,
          note: current.leverage < 1.05
            ? 'Almost no hyUSD debt is left, so the x-token now tracks its collateral roughly 1:1.'
            : undefined,
        });
      }
    } else if ((reference.leverage === null) !== (current.leverage === null)) {
      findings.push({
        kind: 'leverage',
        line: `Leverage: ${fmtLev(reference.leverage)} → ${fmtLev(current.leverage)}`,
        note: current.leverage === null
          ? "This pool's debt now exceeds its collateral (undercollateralized)."
          : undefined,
      });
    }
  }

  if (current.zone && previousZone && current.zone !== previousZone && (isRiskZone(current.zone) || isRiskZone(previousZone))) {
    findings.push({
      kind: 'zone',
      line: `Rebalance zone: ${previousZone} → ${current.zone}`,
      note: current.zone === 'Depeg'
        ? 'The pool is below 100% collateral (destabilized): rebalancing halts and the Earn Pool backstop can be drawn on.'
        : isRiskZone(current.zone)
          ? 'The pool is in a Sell Zone, so the protocol is selling collateral to de-leverage.'
          : 'The pool is back out of the Sell Zones.',
    });
  }

  return findings;
}
