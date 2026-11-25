/**
 * One HTTP door for every api.hylo.so call (v1 client, market-state, stats).
 *
 * Why it exists: from the production server's IP the API answers 403 to every path, while the same
 * requests succeed from elsewhere. That is an edge-level block, not something a request header
 * changes, so the useful behaviour is:
 *  - say exactly what the edge returned (status, server, vercel/cf ids, a body snippet) once per
 *    state change, so the operator can hand Hylo something concrete to allow-list;
 *  - stop hammering a blocked path: after a 403 the path goes into a cool-down that doubles on every
 *    failed probe (2 → 5 → 15 → 30 min), and the first success resets it. Callers see an immediate
 *    HyloBlockedError instead of a network round trip, so their existing fall-back paths (Helius RPC,
 *    on-chain price formulas) kick in without adding load;
 *  - honour Retry-After on 429.
 *
 * Breaker state is per path group ("market-state", "v1", "stats"), not per host, so one blocked
 * endpoint doesn't hide a healthy one.
 */
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('hylo-http');

const USER_AGENT = 'hylo-asset-live-bot/1.0';
const DEFAULT_TIMEOUT_MS = 8_000;
const BLOCK_STEPS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const DIAGNOSTIC_HEADERS = ['server', 'x-vercel-id', 'x-vercel-mitigated', 'x-vercel-cache', 'cf-ray', 'cf-mitigated', 'retry-after', 'content-type', 'via'];

interface PathState {
  blockedUntil: number;
  strikes: number;
  lastStatus: number;
}

const paths = new Map<string, PathState>();

export class HyloBlockedError extends Error {
  readonly status: number;
  readonly retryInMs: number;
  constructor(group: string, status: number, retryInMs: number) {
    super(`api.hylo.so/${group} blocked (HTTP ${status}) — cooling down ${Math.ceil(retryInMs / 1000)}s`);
    this.name = 'HyloBlockedError';
    this.status = status;
    this.retryInMs = retryInMs;
  }
}

function groupOf(url: string): string {
  try {
    return new URL(url).pathname.split('/')[1] || 'root';
  } catch {
    return 'unknown';
  }
}

function stateOf(group: string): PathState {
  let s = paths.get(group);
  if (!s) {
    s = { blockedUntil: 0, strikes: 0, lastStatus: 0 };
    paths.set(group, s);
  }
  return s;
}

async function describeBlock(group: string, res: Response, strikes: number, cooldownMs: number): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const v = res.headers.get(name);
    if (v) headers[name] = v;
  }
  let body = '';
  try {
    body = (await res.clone().text()).replace(/\s+/g, ' ').slice(0, 240);
  } catch {
    // body is best-effort diagnostics only
  }
  logger.warn(
    { group, status: res.status, strikes, cooldownMs, headers, body },
    'api.hylo.so refused this request — backing off (this is an edge/IP-level response, not a client bug)',
  );
}

/**
 * fetch() with a standard User-Agent/Accept, a timeout, and the circuit breaker above.
 * Returns the Response for any HTTP status (callers keep their own status handling); throws
 * HyloBlockedError without touching the network while a path is cooling down, and throws the
 * usual fetch errors on network failure/timeouts.
 */
export async function hyloFetch(url: string, opts?: { timeoutMs?: number }): Promise<Response> {
  const group = groupOf(url);
  const state = stateOf(group);
  const now = Date.now();
  if (state.blockedUntil > now) throw new HyloBlockedError(group, state.lastStatus, state.blockedUntil - now);

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (res.status === 403 || res.status === 401) {
    state.strikes++;
    state.lastStatus = res.status;
    const cooldownMs = BLOCK_STEPS_MS[Math.min(state.strikes - 1, BLOCK_STEPS_MS.length - 1)]!;
    state.blockedUntil = Date.now() + cooldownMs;
    // Full detail on the first strike and whenever the cool-down escalates; one line otherwise.
    if (state.strikes === 1 || state.strikes <= BLOCK_STEPS_MS.length) await describeBlock(group, res, state.strikes, cooldownMs);
  } else if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : 0;
    if (waitMs > 0) {
      state.lastStatus = 429;
      state.blockedUntil = Date.now() + waitMs;
    }
  } else if (res.ok) {
    if (state.strikes > 0) logger.info({ group, afterStrikes: state.strikes }, 'api.hylo.so is accepting requests again');
    state.strikes = 0;
    state.blockedUntil = 0;
    state.lastStatus = 0;
  }
  return res;
}

/** For diagnostics/health lines: which path groups are currently cooling down. */
export function hyloBlockedGroups(): Array<{ group: string; status: number; retryInMs: number }> {
  const now = Date.now();
  const out: Array<{ group: string; status: number; retryInMs: number }> = [];
  for (const [group, s] of paths) {
    if (s.blockedUntil > now) out.push({ group, status: s.lastStatus, retryInMs: s.blockedUntil - now });
  }
  return out;
}

/** Test helper. */
export function resetHyloHttpForTests(): void {
  paths.clear();
}
