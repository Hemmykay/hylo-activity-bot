/**
 * Hylo market-state API — a single HTTP snapshot of every collateral pool
 * (SOL / cbBTC / HYPE / ZEC). xASSET NAV is the same identity we compute on-chain:
 *
 *   price    = (TVL − virtual stablecoin) / levercoin supply
 *   leverage = TVL / (price × supply)
 *
 * Used as the cheap primary source for ticker xSOL/xBTC/xHYPE/xZEC prices.
 * Failures are never thrown: the caller falls back to the Helius path so a
 * down or stale API cannot take pricing offline.
 */
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('market-state');

const MARKET_STATE_URL = 'https://api.hylo.so/market-state';
const TIMEOUT_MS = 5_000;
const FRESH_REUSE_MAX_AGE_MS = 55_000;
/** If Hylo's payload itself is older than this, treat it as a miss and RPC. */
const MAX_PAYLOAD_AGE_SEC = 120;

export type LevercoinSymbol = 'XSOL' | 'XBTC' | 'XHYPE' | 'XZEC';

export interface MarketStateLevercoin {
  price: number;
  effectiveLeverage: number;
  tvl: number;
  virtualStablecoinUsd: number;
  supply: number;
  collateralRatio: number;
}

interface UFixJson {
  bits: string;
  exp: number;
}

interface PoolContextJson {
  rebalance_mode?: string;
  total_value_locked?: UFixJson;
  virtual_stablecoin_supply?: UFixJson;
  levercoin_supply?: UFixJson;
  collateral_ratio?: UFixJson;
}

interface MarketStateJson {
  schema_version?: number;
  unix_timestamp?: number;
  contexts?: {
    sol?: PoolContextJson;
    cbbtc?: PoolContextJson;
    hype?: PoolContextJson;
    zec?: PoolContextJson;
  };
}

const POOL_BY_SYMBOL: Record<LevercoinSymbol, keyof NonNullable<MarketStateJson['contexts']>> = {
  XSOL: 'sol',
  XBTC: 'cbbtc',
  XHYPE: 'hype',
  XZEC: 'zec',
};

/**
 * Looser read of a pool than MarketStateLevercoin: kept even when the pool is so unhealthy that
 * the NAV identity breaks (debt >= collateral), which parsePool rejects but a monitor most needs.
 */
export interface PoolHealth {
  tvlUsd: number;
  /** The pool's own hyUSD backing (virtual stablecoin supply). */
  debtUsd: number;
  collateralRatio: number | null;
  /** TVL / (TVL − debt); null when there is no equity left. */
  leverage: number | null;
  /** Hylo's own rebalance-zone label, e.g. "Neutral", "BuyZone1", "SellZone2". */
  zone: string | null;
}

interface Snapshot {
  fetchedAt: number;
  payloadUnix: number;
  levercoins: Partial<Record<LevercoinSymbol, MarketStateLevercoin>>;
  health: Partial<Record<LevercoinSymbol, PoolHealth>>;
}

let snapshotCache: Snapshot | null = null;
let inflight: Promise<Snapshot | null> | null = null;

function ufixToNumber(value: UFixJson | undefined): number | null {
  if (!value || typeof value.bits !== 'string' || typeof value.exp !== 'number') return null;
  const n = Number(value.bits) * Math.pow(10, value.exp);
  return Number.isFinite(n) ? n : null;
}

function parsePool(ctx: PoolContextJson | undefined): MarketStateLevercoin | null {
  if (!ctx) return null;
  const tvl = ufixToNumber(ctx.total_value_locked);
  const vUsd = ufixToNumber(ctx.virtual_stablecoin_supply);
  const supply = ufixToNumber(ctx.levercoin_supply);
  if (tvl === null || vUsd === null || supply === null) return null;
  if (!(tvl > 0) || !(supply > 0) || tvl <= vUsd) return null;

  const equity = tvl - vUsd;
  const price = equity / supply;
  const effectiveLeverage = tvl / equity;
  if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(effectiveLeverage) || !(effectiveLeverage > 0)) {
    return null;
  }

  const cr = ufixToNumber(ctx.collateral_ratio);
  const collateralRatio = cr !== null && cr > 0 ? cr : tvl / vUsd;

  return { price, effectiveLeverage, tvl, virtualStablecoinUsd: vUsd, supply, collateralRatio };
}

function parseHealth(ctx: PoolContextJson | undefined): PoolHealth | null {
  if (!ctx) return null;
  const tvlUsd = ufixToNumber(ctx.total_value_locked);
  const debtUsd = ufixToNumber(ctx.virtual_stablecoin_supply);
  if (tvlUsd === null || debtUsd === null || !(tvlUsd >= 0) || !(debtUsd >= 0)) return null;
  const cr = ufixToNumber(ctx.collateral_ratio);
  const equity = tvlUsd - debtUsd;
  return {
    tvlUsd,
    debtUsd,
    collateralRatio: cr !== null && cr > 0 ? cr : debtUsd > 0 ? tvlUsd / debtUsd : null,
    leverage: equity > 0 && tvlUsd > 0 ? tvlUsd / equity : null,
    zone: typeof ctx.rebalance_mode === 'string' ? ctx.rebalance_mode : null,
  };
}

function parseSnapshot(json: MarketStateJson, fetchedAt: number): Snapshot | null {
  if (json.schema_version !== 1) return null;
  if (typeof json.unix_timestamp !== 'number' || !Number.isFinite(json.unix_timestamp)) return null;
  if (fetchedAt / 1000 - json.unix_timestamp > MAX_PAYLOAD_AGE_SEC) {
    logger.warn(
      { payloadUnix: json.unix_timestamp, ageSec: fetchedAt / 1000 - json.unix_timestamp },
      'market-state payload is stale — ignoring',
    );
    return null;
  }

  const levercoins: Snapshot['levercoins'] = {};
  const health: Snapshot['health'] = {};
  for (const symbol of Object.keys(POOL_BY_SYMBOL) as LevercoinSymbol[]) {
    const ctx = json.contexts?.[POOL_BY_SYMBOL[symbol]];
    const parsed = parsePool(ctx);
    if (parsed) levercoins[symbol] = parsed;
    const h = parseHealth(ctx);
    if (h) health[symbol] = h;
  }
  if (Object.keys(levercoins).length === 0 && Object.keys(health).length === 0) return null;

  return { fetchedAt, payloadUnix: json.unix_timestamp, levercoins, health };
}

async function fetchSnapshot(): Promise<Snapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(MARKET_STATE_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = (await res.json()) as MarketStateJson;
    return parseSnapshot(json, Date.now());
  } catch (err) {
    logger.warn({ err }, 'market-state fetch failed — caller will use on-chain fallback');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getSnapshot(): Promise<Snapshot | null> {
  const cached = snapshotCache;
  if (cached && Date.now() - cached.fetchedAt <= FRESH_REUSE_MAX_AGE_MS) return cached;
  if (inflight) return inflight;

  inflight = fetchSnapshot()
    .then((snapshot) => {
      if (snapshot) snapshotCache = snapshot;
      return snapshot;
    })
    .finally(() => { inflight = null; });

  return inflight;
}

/** Null means "don't use this source" — never throws. */
export async function queryMarketStateLevercoin(symbol: LevercoinSymbol): Promise<MarketStateLevercoin | null> {
  const snapshot = await getSnapshot();
  return snapshot?.levercoins[symbol] ?? null;
}

/** Per-pool health for the pool watcher. Null means the API was unavailable or stale — never throws. */
export async function queryAllPoolHealth(): Promise<Partial<Record<LevercoinSymbol, PoolHealth>> | null> {
  const snapshot = await getSnapshot();
  return snapshot ? snapshot.health : null;
}
