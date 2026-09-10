/**
 * Hylo Public API v1 client (https://api.hylo.so — interactive docs at /docs).
 *
 * Primary data source for the mint-watcher event stream and asset pricing;
 * Helius RPC stays wired in behind it as the automatic fallback (see
 * mint-watcher.service.ts's mode switching and asset-price.service.ts's
 * resolution chains). Same conventions as market-state.service.ts: never
 * throws, short timeouts, small reuse caches, and staleness gates — a down,
 * stale, or rate-limited API degrades to the caller's existing on-chain path
 * instead of taking a feature offline.
 *
 * Field notes from the live API (verified 2026-09-02):
 *  - Activity events are newest-first, one row per on-chain instruction event;
 *    amounts in eventData are already decimal-adjusted strings.
 *  - State/price buckets are 5m/1h/1d; absent buckets/markets/fields are
 *    omitted (never zero-filled), so callers walk back for the freshest
 *    non-sparse value.
 *  - The API rate-limits (HTTP 429, plain-text body) under bursty polling —
 *    keep callers at ≥60s cadence; request() backs off on 429/5xx regardless.
 */
import { config } from '@/config/index.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('hylo-api');

const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 600;

// ─── Result envelope ──────────────────────────────────────────────────────────

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

// ─── Shapes (subset the bot consumes) ─────────────────────────────────────────

export interface ActivityEvent {
  signature: string;
  eventName: string;
  eventType: string;
  program: string;
  blockTime: string; // ISO timestamp
  slot: number;
  eventIndex: number;
  eventData: Record<string, unknown>;
}

export interface ActivityPage {
  events: ActivityEvent[];
  cursor: string | null;
}

export interface UFixJson { bits?: string; exp?: number }

function ufixToNumber(value: UFixJson | string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (typeof value.bits === 'string' && typeof value.exp === 'number') {
    const n = Number(value.bits) * Math.pow(10, value.exp);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface StateMarket {
  market: string;
  collateralRatio: number | null;
  levercoinLeverage: number | null;
  levercoinNav: number | null;
  virtualStablecoinSupply: number | null;
  levercoinSupply: number | null;
  tvlUsd: number | null;
}

export interface EarnPoolSnapshot {
  /** Bucket timestamp (ISO) the values came from — sparse fields are omitted from newer buckets. */
  asOf: string;
  hyusdPoolBalance: number | null;
  ehyusdSupply: number | null;
  ehyusdNav: number | null;
}

export interface StateSnapshot {
  fetchedAt: number;
  bucketTs: string | null;
  markets: Map<string, StateMarket>;
  earnPool: EarnPoolSnapshot | null;
}

export interface TokenPricePoint { usd: number; ts: number }

// Raw response shapes — the API serves decimals either as {bits,exp} objects
// or plain strings/numbers, and omits absent fields entirely (sparse buckets).
type Decimalish = UFixJson | string | number | undefined;

interface ActivityEventJson {
  signature?: string;
  eventName?: string;
  eventType?: string;
  program?: string;
  blockTime?: string;
  slot?: number;
  eventIndex?: number;
  eventData?: Record<string, unknown>;
}

interface ActivityResponse {
  events?: ActivityEventJson[];
  cursor?: string | null;
}

interface MarketJson {
  market?: unknown;
  collateralRatio?: Decimalish;
  levercoinLeverage?: Decimalish;
  levercoinNav?: Decimalish;
  virtualStablecoinSupply?: Decimalish;
  levercoinSupply?: Decimalish;
  tvlUsd?: Decimalish;
}

interface EarnPoolJson {
  hyusdPoolBalance?: Decimalish;
  ehyusdSupply?: Decimalish;
  ehyusdNav?: Decimalish;
}

interface StateResponse {
  series?: Array<{ ts?: string; markets?: MarketJson[]; earnPool?: EarnPoolJson }>;
}

interface PricesResponse {
  tokens?: Array<{ token?: unknown; series?: Array<{ ts?: string; usd?: Decimalish }> }>;
}

// ─── Request core ─────────────────────────────────────────────────────────────

async function request<T>(path: string): Promise<ApiResult<T>> {
  const url = `${config.hyloApi.baseUrl}${path}`;
  let lastError = 'unknown error';
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'hylo-asset-live-bot/1.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 429 || res.status >= 500) {
        lastStatus = res.status;
        lastError = `HTTP ${res.status} ${res.statusText}`;
        continue; // transient — back off and retry
      }
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} ${res.statusText}`, status: res.status };
      }
      // A 200 with a non-JSON body has been observed from the edge under rate
      // pressure ("Too Many Requests") — treat as transient rather than crashing.
      const text = await res.text();
      try {
        return { ok: true, data: JSON.parse(text) as T };
      } catch {
        lastStatus = 503;
        lastError = `non-JSON response body: ${text.slice(0, 60)}`;
        continue;
      }
    } catch (err) {
      lastStatus = 0;
      lastError = String(err instanceof Error ? err.message : err);
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

// ─── Feed health (drives the mint-watcher's RPC fallback switch) ──────────────

const FEED_FAILURES_BEFORE_FALLBACK = 3;

const feedHealth = { consecutiveFailures: 0, lastSuccessAt: 0, lastFailureError: '' };

export function markFeedSuccess(): void {
  if (feedHealth.consecutiveFailures > 0) {
    logger.info({ afterFailures: feedHealth.consecutiveFailures }, 'Hylo API feed recovered — leaving RPC fallback');
  }
  feedHealth.consecutiveFailures = 0;
  feedHealth.lastSuccessAt = Date.now();
}

export function markFeedFailure(error: string): void {
  feedHealth.consecutiveFailures++;
  feedHealth.lastFailureError = error;
  logger.warn({ consecutiveFailures: feedHealth.consecutiveFailures, error }, 'Hylo API feed fetch failed');
}

export function feedUsable(): boolean {
  return !config.hyloApi.eventsDisabled && feedHealth.consecutiveFailures < FEED_FAILURES_BEFORE_FALLBACK;
}

// ─── /v1/protocol/activity ────────────────────────────────────────────────────

function parseActivityPage(json: ActivityResponse): ActivityPage {
  const events: ActivityEvent[] = (json?.events ?? []).map((e) => ({
    signature: String(e.signature ?? ''),
    eventName: String(e.eventName ?? ''),
    eventType: String(e.eventType ?? ''),
    program: String(e.program ?? ''),
    blockTime: String(e.blockTime ?? ''),
    slot: Number(e.slot ?? 0),
    eventIndex: Number(e.eventIndex ?? 0),
    eventData: e.eventData ?? {},
  }));
  return { events, cursor: json?.cursor ?? null };
}

export async function getActivityPage(opts: { limit: number; before?: string }): Promise<ApiResult<ActivityPage>> {
  const qs = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.before) qs.set('before', opts.before);
  const r = await request<ActivityResponse>(`/v1/protocol/activity?${qs.toString()}`);
  return r.ok ? { ok: true, data: parseActivityPage(r.data) } : r;
}

// ─── /v1/protocol/state (cached; sparse earnPool walked back) ─────────────────

const STATE_CACHE_TTL_MS = 5 * 60_000; // buckets are 5m — polling faster buys nothing
let stateCache: ApiResult<StateSnapshot> | null = null;
let stateInflight: Promise<ApiResult<StateSnapshot>> | null = null;

function parseState(json: StateResponse): StateSnapshot {
  const series = json?.series ?? [];
  const latest = series[series.length - 1] ?? null;

  const markets = new Map<string, StateMarket>();
  for (const m of latest?.markets ?? []) {
    markets.set(String(m.market ?? ''), {
      market: String(m.market ?? ''),
      collateralRatio: ufixToNumber(m.collateralRatio),
      levercoinLeverage: ufixToNumber(m.levercoinLeverage),
      levercoinNav: ufixToNumber(m.levercoinNav),
      virtualStablecoinSupply: ufixToNumber(m.virtualStablecoinSupply),
      levercoinSupply: ufixToNumber(m.levercoinSupply),
      tvlUsd: ufixToNumber(m.tvlUsd),
    });
  }

  // Sparse fields: walk back to the newest bucket that actually carries earnPool data.
  let earnPool: EarnPoolSnapshot | null = null;
  for (let i = series.length - 1; i >= 0; i--) {
    const bucket = series[i];
    const ep = bucket?.earnPool;
    if (bucket && ep && (ep.ehyusdSupply !== undefined || ep.ehyusdNav !== undefined)) {
      earnPool = {
        asOf: String(bucket.ts ?? ''),
        hyusdPoolBalance: ufixToNumber(ep.hyusdPoolBalance),
        ehyusdSupply: ufixToNumber(ep.ehyusdSupply),
        ehyusdNav: ufixToNumber(ep.ehyusdNav),
      };
      break;
    }
  }

  return {
    fetchedAt: Date.now(),
    bucketTs: latest?.ts ?? null,
    markets,
    earnPool,
  };
}

export async function getStateSnapshot(): Promise<ApiResult<StateSnapshot>> {
  if (stateCache && Date.now() - (stateCache.ok ? stateCache.data.fetchedAt : 0) < STATE_CACHE_TTL_MS && stateCache.ok) {
    return stateCache;
  }
  if (stateInflight) return stateInflight;

  stateInflight = request<StateResponse>('/v1/protocol/state?granularity=5m&days=1').then((r) => {
    const result: ApiResult<StateSnapshot> = r.ok ? { ok: true, data: parseState(r.data) } : r;
    stateCache = result;
    stateInflight = null;
    return result;
  }).catch((err) => {
    stateInflight = null;
    return { ok: false as const, error: String(err instanceof Error ? err.message : err), status: 0 };
  });
  return stateInflight;
}

/** Null when the earn-pool data is missing or older than `maxAgeMs` — caller falls back to RPC. */
export async function queryEhyusdEarnPool(maxAgeMs: number): Promise<{ supply: number; nav: number; asOf: string } | null> {
  const r = await getStateSnapshot();
  if (!r.ok || !r.data.earnPool) return null;
  const { ehyusdSupply, ehyusdNav, asOf } = r.data.earnPool;
  if (ehyusdSupply === null || ehyusdNav === null || !asOf) return null;
  const age = Date.now() - Date.parse(asOf);
  if (!Number.isFinite(age) || age > maxAgeMs) return null;
  return { supply: ehyusdSupply, nav: ehyusdNav, asOf };
}

// ─── /v1/protocol/prices (cached, small token-filtered fetch) ─────────────────

const PRICES_CACHE_TTL_MS = 2 * 60_000;
let pricesCache: { at: number; result: ApiResult<Map<string, TokenPricePoint>> } | null = null;
let pricesInflight: Promise<ApiResult<Map<string, TokenPricePoint>>> | null = null;

function parsePrices(json: PricesResponse): Map<string, TokenPricePoint> {
  const out = new Map<string, TokenPricePoint>();
  for (const t of json?.tokens ?? []) {
    const series = t?.series ?? [];
    const last = series[series.length - 1];
    const usd = ufixToNumber(last?.usd);
    const ts = last?.ts ? Date.parse(last.ts) : NaN;
    if (usd !== null && Number.isFinite(ts)) out.set(String(t.token ?? ''), { usd, ts });
  }
  return out;
}

export async function getLatestTokenPrices(tokens: string[]): Promise<ApiResult<Map<string, TokenPricePoint>>> {
  if (pricesCache && pricesCache.result.ok && Date.now() - pricesCache.at < PRICES_CACHE_TTL_MS) {
    return pricesCache.result;
  }
  if (pricesInflight) return pricesInflight;

  const qs = new URLSearchParams({ granularity: '5m', days: '1', token: tokens.join(',') });
  pricesInflight = request<PricesResponse>(`/v1/protocol/prices?${qs.toString()}`).then((r) => {
    const result: ApiResult<Map<string, TokenPricePoint>> = r.ok ? { ok: true, data: parsePrices(r.data) } : r;
    pricesCache = { at: Date.now(), result };
    pricesInflight = null;
    return result;
  }).catch((err) => {
    pricesInflight = null;
    return { ok: false as const, error: String(err instanceof Error ? err.message : err), status: 0 };
  });
  return pricesInflight;
}

/** Latest 5m close for one API token label, or null when missing/stale — caller falls back to RPC. */
export async function queryLatestTokenPrice(token: string, maxAgeMs: number): Promise<number | null> {
  const r = await getLatestTokenPrices([token]);
  if (!r.ok) return null;
  const point = r.data.get(token);
  if (!point) return null;
  if (Date.now() - point.ts > maxAgeMs) return null;
  return point.usd;
}
