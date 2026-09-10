/**
 * Isolated Helius on-chain data service.
 *
 * Every public function returns { success, data?, error? } — never throws.
 * A failure in this service cannot propagate to or crash the main bot flow.
 */
import { config } from '@/config/index.js';
import { createLogger } from '@/lib/logger.js';
import { notifyDev } from '@/services/dev-alert/dev-alert.service.js';

const logger = createLogger('helius');

const TIMEOUT_MS = 10_000;

// ─── Result envelope ──────────────────────────────────────────────────────────

export type OnchainResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ─── Public data shapes ───────────────────────────────────────────────────────

export interface TokenSupply {
  raw: string;
  uiAmount: number;
  decimals: number;
  formatted: string;
}

export interface TokenHolders {
  total: number;
  formatted: string;
}

export interface TokenMeta {
  name: string;
  symbol: string;
  uri?: string;
}

export interface RecentActivity {
  signatures: Array<{ signature: string; blockTime: number | null; err: boolean }>;
}

export interface TokenOnchainData {
  mintAddress: string;
  supply?: TokenSupply;
  holders?: TokenHolders;
  meta?: TokenMeta;
  recentTxCount: number;
  recentTxSample: Array<{ signature: string; blockTime: number | null; err: boolean }>;
  queriedAt: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const RPC_MAX_RETRIES = 4;
const RPC_RETRY_BASE_MS = 400;

// Pricing reads (balances, supplies, account data) are reused across the
// mint-watcher tick, four ticker bots, and the eHYUSD cap check — all of
// which fire ~every 60s and often overlap. 50s is just under that interval
// so each tick still goes to chain, but the duplicates inside one minute
// don't. getTransaction is immutable once confirmed, so mint+burn scans of
// the same signature share one fetch. getSignaturesForAddress is NOT cached:
// that's the live "anything new?" poll and must see the next slot.
const PRICING_CACHE_METHODS = new Set([
  'getTokenSupply',
  'getTokenAccountsByOwner',
  'getAccountInfo',
  'getMultipleAccounts',
]);
const PRICING_CACHE_TTL_MS = 50_000;
const TX_CACHE_TTL_MS = 10 * 60 * 1000;

interface RpcCacheEntry {
  value: unknown;
  expiresAt: number;
}

const rpcCache = new Map<string, RpcCacheEntry>();
const rpcInflight = new Map<string, Promise<unknown>>();

function rpcCacheKey(method: string, params: unknown): string {
  return `${method}:${JSON.stringify(params)}`;
}

function rpcCacheTtlMs(method: string): number | null {
  if (method === 'getTransaction') return TX_CACHE_TTL_MS;
  if (PRICING_CACHE_METHODS.has(method)) return PRICING_CACHE_TTL_MS;
  return null;
}

function pruneRpcCache(): void {
  if (rpcCache.size < 400) return;
  const now = Date.now();
  for (const [key, entry] of rpcCache) {
    if (entry.expiresAt <= now) rpcCache.delete(key);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cached/coalesced entry point. Confirmed transactions and pricing-account
 * reads are reused; signature polling is always live. In-flight identical
 * calls share one HTTP request so a ticker + cap-watcher stampede doesn't
 * multiply credits.
 */
async function rpc<T>(method: string, params: unknown): Promise<T> {
  const ttlMs = rpcCacheTtlMs(method);
  if (ttlMs === null) return rpcFetch<T>(method, params);

  const key = rpcCacheKey(method, params);
  const hit = rpcCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;

  const pending = rpcInflight.get(key);
  if (pending) return pending as Promise<T>;

  const request = rpcFetch<T>(method, params)
    .then((value) => {
      // A null getTransaction means the tx isn't visible yet — don't remember
      // that, the next poll should ask again.
      if (!(method === 'getTransaction' && value == null)) {
        rpcCache.set(key, { value, expiresAt: Date.now() + ttlMs });
        pruneRpcCache();
      }
      return value;
    })
    .finally(() => { rpcInflight.delete(key); });
  rpcInflight.set(key, request);
  return request;
}

/**
 * Retries on 429 (with exponential backoff) and on a timed-out request —
 * Helius occasionally takes longer than TIMEOUT_MS to respond to an
 * otherwise-ordinary read, and since every call here is a read (getTransaction/
 * getSignaturesForAddress/etc.), retrying costs nothing extra in correctness.
 * Needed now that some callers (queryRecentPoolRebalanceEvents) issue several
 * of these concurrently, which routinely draws a rate limit even at modest
 * concurrency.
 *
 * `endpointIdx` picks which of config.helius.rpcUrls this attempt is against.
 * Once that endpoint's own retries are exhausted (429s, or a persistently
 * timed-out/non-OK response), failover() moves to the next configured
 * endpoint from a clean slate rather than surfacing the failure — a
 * single bad/rate-limited key shouldn't take on-chain data down as long as a
 * second one (HELIUS_API_KEY_2) is configured. A JSON-RPC-level error
 * (`json.error`) is a request problem, not an endpoint problem, so it's
 * never retried against another endpoint.
 */
async function rpcFetch<T>(method: string, params: unknown, endpointIdx = 0, attempt = 0): Promise<T> {
  if (!config.helius.enabled) throw new Error('Helius API key not configured');
  const url = config.helius.rpcUrls[endpointIdx];
  if (!url) throw new Error('No Helius RPC endpoints configured');

  const failover = (reason: string): Promise<T> | null => {
    const nextIdx = endpointIdx + 1;
    if (nextIdx >= config.helius.rpcUrls.length) {
      // Every endpoint (Helius keys + public fallback) is down for this
      // method — that needs a human, not just a log line.
      void notifyDev(
        `Helius RPC exhausted for ${method}`,
        `${reason} — all ${config.helius.rpcUrls.length} endpoint(s) failed`,
        `helius-exhausted-${method}`,
      );
      return null;
    }
    logger.warn({ method, failedEndpointIdx: endpointIdx, reason }, 'Helius endpoint failed — failing over to next configured endpoint');
    return rpcFetch<T>(method, params, nextIdx, 0);
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      if (attempt < RPC_MAX_RETRIES) {
        await sleep(RPC_RETRY_BASE_MS * 2 ** attempt);
        return rpcFetch<T>(method, params, endpointIdx, attempt + 1);
      }
      const next = failover('429 rate limited, retries exhausted');
      if (next) return next;
      throw new Error('HTTP 429: rate limited (all endpoints exhausted)');
    }

    if (!res.ok) {
      // 5xx errors can be transient (node overload, brief outage) — retry
      // with backoff before failing over. 401/403 are key/endpoint-specific
      // and should fail over immediately.
      if (res.status >= 500 && res.status < 600 && attempt < RPC_MAX_RETRIES) {
        await sleep(RPC_RETRY_BASE_MS * 2 ** attempt);
        return rpcFetch<T>(method, params, endpointIdx, attempt + 1);
      }
      const next = failover(`HTTP ${res.status}: ${res.statusText}`);
      if (next) return next;
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const json = await res.json() as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    if (json.result === undefined) throw new Error('Empty result from RPC');

    return json.result as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (attempt < RPC_MAX_RETRIES) {
        await sleep(RPC_RETRY_BASE_MS * 2 ** attempt);
        return rpcFetch<T>(method, params, endpointIdx, attempt + 1);
      }
      const next = failover('request timed out, retries exhausted');
      if (next) return next;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString();
}

// ─── Individual queries (exported) ───────────────────────────────────────────
// Pricing reads are cached ~50s (see rpc()). Event polling is always live.

export interface TokenBalance {
  uiAmount: number;
  decimals: number;
  formatted: string;
}

/**
 * Returns how many tokens (identified by `mint`) are held in `ownerWallet`.
 * Returns uiAmount=0 if the wallet has no account for that mint.
 */
export async function queryTokenBalance(
  ownerWallet: string,
  mint: string,
): Promise<OnchainResult<TokenBalance>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const result = await rpc<{
      value: Array<{
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
              };
            };
          };
        };
      }>;
    }>('getTokenAccountsByOwner', [ownerWallet, { mint }, { encoding: 'jsonParsed' }]);

    const tokenAccount = result.value[0];
    if (!tokenAccount) {
      // Wallet has no ATA for this mint — balance is zero
      return { success: true, data: { uiAmount: 0, decimals: 0, formatted: '0' } };
    }

    const ta = tokenAccount.account.data.parsed.info.tokenAmount;
    const uiAmount = ta.uiAmount ?? Number(ta.amount) / 10 ** ta.decimals;
    return {
      success: true,
      data: { uiAmount, decimals: ta.decimals, formatted: fmt(uiAmount) },
    };
  } catch (err) {
    logger.warn({ err, ownerWallet, mint }, 'getTokenAccountsByOwner failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Raw account bytes for a program-owned account (e.g. a Hylo Exchange
 * program account) — not a token account. Callers decode the returned
 * buffer themselves (see idl-decoder.ts).
 */
export async function queryAccountData(address: string): Promise<OnchainResult<Buffer>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const result = await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [
      address,
      { encoding: 'base64' },
    ]);
    if (!result.value) return { success: false, error: `Account ${address} not found.` };
    const [dataB64] = result.value.data;
    return { success: true, data: Buffer.from(dataB64, 'base64') };
  } catch (err) {
    logger.warn({ err, address }, 'getAccountInfo failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

export async function queryTokenSupply(mint: string): Promise<OnchainResult<TokenSupply>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const result = await rpc<{ value: { amount: string; decimals: number; uiAmount: number | null } }>(
      'getTokenSupply',
      [mint],
    );
    const ui = result.value.uiAmount ?? Number(result.value.amount) / 10 ** result.value.decimals;
    return {
      success: true,
      data: {
        raw: result.value.amount,
        uiAmount: ui,
        decimals: result.value.decimals,
        formatted: fmt(ui),
      },
    };
  } catch (err) {
    logger.warn({ err, mint }, 'getTokenSupply failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

export async function queryTokenHolders(mint: string): Promise<OnchainResult<TokenHolders>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const result = await rpc<{ total: number }>(
      'getTokenAccounts',
      { mint, limit: 1, page: 1 },
    );
    return {
      success: true,
      data: { total: result.total, formatted: result.total.toLocaleString() },
    };
  } catch (err) {
    logger.warn({ err, mint }, 'getTokenAccounts failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

export async function queryTokenActivity(mint: string, limit = 5): Promise<OnchainResult<RecentActivity>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const result = await rpc<Array<{ signature: string; blockTime: number | null; err: unknown }>>(
      'getSignaturesForAddress',
      [mint, { limit }],
    );
    return {
      success: true,
      data: {
        signatures: result.map((s) => ({
          signature: s.signature,
          blockTime: s.blockTime,
          err: Boolean(s.err),
        })),
      },
    };
  } catch (err) {
    logger.warn({ err, mint }, 'getSignaturesForAddress failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Signatures on `address` newer than `sinceSignature` (newest-first, like the
 * RPC returns them). unlike fetchNewSignatures below there is no seed/gap
 * handling — callers own their checkpoint lifecycle. `limit` bounds the page;
 * a full page means the caller may need to resync (same semantics as the
 * mint scans).
 */
export async function querySignaturesSince(
  address: string,
  sinceSignature: string | null,
  limit: number,
): Promise<OnchainResult<SignatureInfo[]>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const sigs = await rpc<SignatureInfo[]>('getSignaturesForAddress', [
      address,
      { limit, ...(sinceSignature ? { until: sinceSignature } : {}) },
    ]);
    return { success: true, data: sigs };
  } catch (err) {
    logger.warn({ err, address }, 'getSignaturesForAddress failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// u64::MAX — Solana uses this sentinel to mark a delegation that is not deactivating
const EPOCH_NOT_DEACTIVATING = '18446744073709551615';

type ParsedStakeInfo = {
  type: string;
  info: {
    stake?: {
      delegation: { stake: string; deactivationEpoch: string };
    };
  };
} | null;

const GET_MULTIPLE_ACCOUNTS_MAX = 100;

/**
 * Queries a list of known stake accounts, then sums the lamports of every
 * ACTIVE delegation (deactivationEpoch === u64::MAX).
 *
 * One getMultipleAccounts per 100 addresses instead of N getAccountInfo
 * calls — same parsed accounts, one (or a few) RPC credits. Helius shared
 * nodes block getProgramAccounts on the Stake Program, which is why we still
 * pass the known addresses rather than scanning the program.
 */
export async function queryStakeAccounts(
  stakeAccounts: string[],
): Promise<OnchainResult<{ sol: number; lamports: bigint; formatted: string; activeAccounts: number }>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const chunks: string[][] = [];
    for (let i = 0; i < stakeAccounts.length; i += GET_MULTIPLE_ACCOUNTS_MAX) {
      chunks.push(stakeAccounts.slice(i, i + GET_MULTIPLE_ACCOUNTS_MAX));
    }
    const parsedChunks = await Promise.all(
      chunks.map(async (chunk) => {
        const result = await rpc<{ value: Array<{ data: { parsed: ParsedStakeInfo } } | null> }>(
          'getMultipleAccounts',
          [chunk, { encoding: 'jsonParsed' }],
        );
        return (result.value ?? []).map((account) => account?.data?.parsed ?? null);
      }),
    );
    const parsedList = parsedChunks.flat();

    let totalLamports = BigInt(0);
    let activeAccounts = 0;

    for (const parsed of parsedList) {
      if (!parsed || parsed.type !== 'delegated') continue;
      const delegation = parsed.info.stake?.delegation;
      if (!delegation) continue;
      if (delegation.deactivationEpoch !== EPOCH_NOT_DEACTIVATING) continue;
      totalLamports += BigInt(delegation.stake);
      activeAccounts++;
    }

    const sol = Number(totalLamports) / 1e9;
    return { success: true, data: { sol, lamports: totalLamports, formatted: fmt(sol), activeAccounts } };
  } catch (err) {
    logger.warn({ err, stakeAccounts }, 'queryStakeAccounts failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// kept private — only used by getTokenOnchainData below
async function fetchMeta(mint: string): Promise<OnchainResult<TokenMeta>> {
  try {
    const result = await rpc<{ content?: { metadata?: { name?: string; symbol?: string } }; token_info?: { symbol?: string } }>(
      'getAsset',
      { id: mint },
    );
    const name = result.content?.metadata?.name ?? 'Unknown';
    const symbol = result.content?.metadata?.symbol ?? result.token_info?.symbol ?? '';
    return { success: true, data: { name, symbol } };
  } catch (err) {
    logger.warn({ err, mint }, 'getAsset failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// ─── Bulk query (all data at once) ───────────────────────────────────────────

/**
 * Fetches all on-chain data in parallel. Use only when the user explicitly
 * asks for a full overview — for specific questions, use the individual
 * queryToken* functions above to avoid unnecessary API calls.
 */
export async function getTokenOnchainData(mintAddress: string): Promise<OnchainResult<TokenOnchainData>> {
  if (!config.helius.enabled) {
    return { success: false, error: 'On-chain queries are not configured (HELIUS_API_KEY missing).' };
  }

  try {
    const [supplyResult, holdersResult, metaResult, activityResult] = await Promise.all([
      queryTokenSupply(mintAddress),
      queryTokenHolders(mintAddress),
      fetchMeta(mintAddress),
      queryTokenActivity(mintAddress),
    ]);

    const activity = activityResult.success ? activityResult.data.signatures : [];

    const data: TokenOnchainData = {
      mintAddress,
      recentTxCount: activity.length,
      recentTxSample: activity,
      queriedAt: Date.now(),
    };
    if (supplyResult.success) data.supply = supplyResult.data;
    if (holdersResult.success) data.holders = holdersResult.data;
    if (metaResult.success) data.meta = metaResult.data;

    return { success: true, data };
  } catch (err) {
    logger.error({ err, mintAddress }, 'getTokenOnchainData unexpected failure');
    return { success: false, error: 'Unexpected error fetching on-chain data.' };
  }
}

// ─── Mint event detection ─────────────────────────────────────────────────────
// Used by the mint-watcher background service. Detects MintTo/MintToChecked
// instructions — including ones invoked via CPI (inner instructions), which is
// how Hylo's own Exchange program mints xSOL/hyUSD/eHYUSD on user deposits.

export interface MintEvent {
  signature: string;
  blockTime: number | null;
  mint: string;
  amount: number; // raw integer, NOT decimal-adjusted — caller applies the mint's decimals
  destinationAccount: string;
}

interface ParsedInstruction {
  program?: string;
  parsed?: {
    type?: string;
    info?: {
      mint?: string;
      account?: string;
      amount?: string;
      tokenAmount?: { amount: string; decimals: number };
    };
  };
}

interface ParsedTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmount: number | null };
}

interface ParsedTransaction {
  meta: {
    err: unknown;
    innerInstructions?: Array<{ instructions: ParsedInstruction[] }>;
    preTokenBalances?: ParsedTokenBalance[];
    postTokenBalances?: ParsedTokenBalance[];
  } | null;
  transaction: {
    message: {
      instructions: ParsedInstruction[];
      accountKeys: Array<{ pubkey: string; signer: boolean }>;
    };
  };
  blockTime?: number | null;
}

type SignatureInfo = { signature: string; blockTime: number | null; err: unknown };

// This is informational monitoring, not an accounting ledger — a downtime
// gap is never backfilled. One page is all we ever look at; if it comes back
// completely full without reaching `sinceSignature`, that means there's more
// history behind it than we're willing to process, so the caller resyncs the
// checkpoint straight to "now" and reports nothing for the gap period.
const SIGNATURE_PAGE_SIZE = 100;

// Hylo Stability Pool revenue wallet. Some mint operations (e.g. redeeming
// xSOL for hyUSD) split the mint across the actual recipient AND a protocol
// fee portion sent here in the same transaction, as a separate mintTo
// instruction. That fee portion isn't a real user-facing mint — reporting it
// as its own event would misrepresent a fee payment as a fresh mint.
const HYLO_REVENUE_WALLET = '3HT6dD6APJh89XJs9rkn3BmsvkXE9jPG9dWJmUjWu6TS';

/**
 * Resolves the owner of a token account referenced by a parsed instruction
 * (e.g. a mintTo's destination). Instructions give the token account address
 * itself, not its owner — postTokenBalances indexes by position in
 * accountKeys, so the address has to be mapped to an index first.
 * Returns null when ownership can't be determined (never treated as a match).
 */
function resolveTokenAccountOwner(tx: ParsedTransaction, tokenAccount: string): string | null {
  const accountIndex = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === tokenAccount);
  if (accountIndex === -1) return null;
  const balance = tx.meta?.postTokenBalances?.find((b) => b.accountIndex === accountIndex);
  return balance?.owner ?? null;
}

/** Runs `fn` over `items` with at most `limit` in flight at once — a flat Promise.all over a full page (100) triggers 429s. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Raw integer amount moved by a parsed spl-token instruction (mintTo/mintToChecked/burn/burnChecked/transfer/transferChecked). */
function instructionAmount(ix: ParsedInstruction): number {
  const info = ix.parsed?.info;
  return info?.tokenAmount ? Number(info.tokenAmount.amount) : Number(info?.amount ?? 0);
}

/** Decimal-adjusted (pre -> post) balance change for one owner+mint pair. */
function netBalanceChange(
  pre: ParsedTokenBalance[] | undefined,
  post: ParsedTokenBalance[] | undefined,
  owner: string,
  mint: string,
): number {
  const preAmt = pre?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.uiAmount ?? 0;
  const postAmt = post?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.uiAmount ?? 0;
  return postAmt - preAmt;
}


type SignaturePage =
  | { status: 'seeded' | 'gap'; newestSignature: string | null }
  | { status: 'empty' }
  | { status: 'ok'; sigs: SignatureInfo[]; newestSignature: string };

/**
 * Shared first step for every event-detection query below: seed on first run
 * (no backfill), fetch one page since the checkpoint, and resync-without-
 * backfilling if that page came back completely full (a gap bigger than one
 * page can see — see SIGNATURE_PAGE_SIZE's comment).
 */
async function fetchNewSignatures(address: string, sinceSignature: string | null): Promise<SignaturePage> {
  if (sinceSignature === null) {
    const seed = await rpc<SignatureInfo[]>('getSignaturesForAddress', [address, { limit: 1 }]);
    return { status: 'seeded', newestSignature: seed[0]?.signature ?? null };
  }

  const sigs = await rpc<SignatureInfo[]>('getSignaturesForAddress', [
    address,
    { limit: SIGNATURE_PAGE_SIZE, until: sinceSignature },
  ]);

  if (sigs.length === 0) return { status: 'empty' };

  const newestSignature = sigs[0]!.signature; // API returns newest-first

  if (sigs.length === SIGNATURE_PAGE_SIZE) {
    logger.info({ address }, 'Gap larger than one page since last check — resyncing to now without backfilling');
    return { status: 'gap', newestSignature };
  }

  return { status: 'ok', sigs, newestSignature };
}

/**
 * Finds mint events newer than `sinceSignature` for the given mint.
 * Pass sinceSignature=null on first run — this seeds a checkpoint (returns the
 * newest signature) WITHOUT backfilling/returning historical events, so the
 * watcher doesn't replay a mint's entire history the first time it runs.
 *
 * `signaturesChecked` lets callers distinguish "quiet, no new activity at all"
 * from "activity happened, none of it was a mint" — both look like an empty
 * `events` array otherwise.
 */
export async function queryMintEvents(
  mintAddress: string,
  sinceSignature: string | null,
): Promise<OnchainResult<{ events: MintEvent[]; newestSignature: string | null; signaturesChecked: number }>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const page = await fetchNewSignatures(mintAddress, sinceSignature);
    if (page.status !== 'ok') {
      const newestSignature = page.status === 'empty' ? sinceSignature : page.newestSignature;
      return { success: true, data: { events: [], newestSignature, signaturesChecked: 0 } };
    }
    const { sigs, newestSignature } = page;

    const events: MintEvent[] = [];
    // Oldest → newest so callers post alerts in chronological order
    for (const { signature, blockTime, err } of [...sigs].reverse()) {
      if (err) continue;
      const tx = await rpc<ParsedTransaction | null>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx) continue;

      const allInstructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
      ];

      for (const ix of allInstructions) {
        const info = ix.parsed?.info;
        if (ix.program !== 'spl-token' || !info) continue;
        if (ix.parsed?.type !== 'mintTo' && ix.parsed?.type !== 'mintToChecked') continue;
        if (info.mint !== mintAddress) continue;

        const destination = info.account ?? '';
        const destinationOwner = resolveTokenAccountOwner(tx, destination);
        if (destinationOwner === HYLO_REVENUE_WALLET) {
          logger.debug({ signature, mintAddress, destination }, 'Skipping mintTo to revenue wallet — fee portion, not a real mint');
          continue;
        }

        const amount = instructionAmount(ix);
        events.push({
          signature,
          blockTime,
          mint: mintAddress,
          amount,
          destinationAccount: destination,
        });
      }
    }

    return { success: true, data: { events, newestSignature, signaturesChecked: sigs.length } };
  } catch (err) {
    logger.warn({ err, mintAddress }, 'queryMintEvents failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// ─── Burn event detection ──────────────────────────────────────────────────────
// Symmetric to queryMintEvents, for the daily inflow/outflow summary — burns
// (redemptions/withdrawals) were never tracked before this, since the live
// alert stream only ever cared about mints/stakes/rebalances.

export interface BurnEvent {
  signature: string;
  blockTime: number | null;
  mint: string;
  amount: number; // raw integer, NOT decimal-adjusted
  sourceAccount: string;
}

/**
 * Finds burn events newer than `sinceSignature` for the given mint. Same
 * seed/gap/checkpoint semantics as queryMintEvents.
 *
 * `excludeStabilityPoolWallet` skips burns sourced from the Stability Pool's
 * own wallet — those are Offload/Deployment rebalances, already captured (and
 * paired with their mint side) by queryPoolRebalanceEvents. Without this,
 * a rebalance's burn leg would be double-counted here as a second, unrelated
 * burn event.
 */
export async function queryBurnEvents(
  mintAddress: string,
  sinceSignature: string | null,
  opts?: { excludeStabilityPoolWallet?: boolean },
): Promise<OnchainResult<{ events: BurnEvent[]; newestSignature: string | null; signaturesChecked: number }>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const page = await fetchNewSignatures(mintAddress, sinceSignature);
    if (page.status !== 'ok') {
      const newestSignature = page.status === 'empty' ? sinceSignature : page.newestSignature;
      return { success: true, data: { events: [], newestSignature, signaturesChecked: 0 } };
    }
    const { sigs, newestSignature } = page;

    const events: BurnEvent[] = [];
    for (const { signature, blockTime, err } of [...sigs].reverse()) {
      if (err) continue;
      const tx = await rpc<ParsedTransaction | null>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx) continue;

      const allInstructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
      ];

      for (const ix of allInstructions) {
        const info = ix.parsed?.info;
        if (ix.program !== 'spl-token' || !info) continue;
        if (ix.parsed?.type !== 'burn' && ix.parsed?.type !== 'burnChecked') continue;
        if (info.mint !== mintAddress) continue;

        const source = info.account ?? '';
        if (opts?.excludeStabilityPoolWallet && resolveTokenAccountOwner(tx, source) === HYLO_STABILITY_POOL_WALLET) {
          logger.debug({ signature, mintAddress, source }, 'Skipping burn from stability pool wallet — already counted as a rebalance');
          continue;
        }

        events.push({ signature, blockTime, mint: mintAddress, amount: instructionAmount(ix), sourceAccount: source });
      }
    }

    return { success: true, data: { events, newestSignature, signaturesChecked: sigs.length } };
  } catch (err) {
    logger.warn({ err, mintAddress }, 'queryBurnEvents failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// ─── Stability Pool rebalance detection ────────────────────────────────────────
// The Stability Pool rebalances its own xSOL/hyUSD exposure in both directions:
//  - "Offload": burns its own xSOL, mints the equivalent hyUSD to itself
//    (unwinding xSOL exposure — the reverse of "deposited hyUSD may be
//    converted to xSOL"). Detected by scanning the hyUSD mint.
//  - "Deployment": burns its own hyUSD, mints the equivalent xSOL to itself
//    (deploying capital into xSOL exposure). Detected by scanning the xSOL mint.
// Both are protocol rebalancing, not a user mint — they get their own report
// instead of a generic mint alert. A fee to the revenue wallet may apply on
// either side, same as any mint.

const HYLO_STABILITY_POOL_WALLET = '5YrRAQag9BbJkauDtJkd1vsTquXT6N46oU8rJ66GDxHd';
// The feed-based event path watches this wallet for Stability Pool
// Offload/Deployment rebalances (see mint-watcher.service.ts) — the v1 API
// has no dedicated event type for those paired burn+mint legs yet.
export { HYLO_STABILITY_POOL_WALLET };

export interface RebalanceEvent {
  signature: string;
  blockTime: number | null;
  mintedAmount: number; // raw integer, NOT decimal-adjusted — pool's portion of `mintAddress`, excludes any fee
  burnedAmount: number; // raw integer, NOT decimal-adjusted — of `burnMateMint`
}

/**
 * Scans `mintAddress`'s mint activity once and classifies every mintTo
 * instruction:
 *  - destination owned by the revenue wallet          -> excluded (fee)
 *  - destination owned by the stability pool wallet,
 *    with a matching burn of `burnMateMint` FROM that
 *    same wallet in the same transaction               -> RebalanceEvent
 *  - destination owned by the stability pool wallet,
 *    no matching burn found                            -> excluded (same
 *                                                          treatment as the
 *                                                          revenue wallet —
 *                                                          not a user-facing event)
 *  - anything else                                     -> normal MintEvent
 *
 * Call with (hyUSDMint, xSOLMint) to detect "Stability Pool Offload".
 * Call with (xSOLMint, hyUSDMint) to detect "Stability Pool Deployment" — the
 * reverse direction, same shape.
 */
export async function queryPoolRebalanceEvents(
  mintAddress: string,
  burnMateMint: string,
  sinceSignature: string | null,
): Promise<OnchainResult<{
  mintEvents: MintEvent[];
  rebalanceEvents: RebalanceEvent[];
  newestSignature: string | null;
  signaturesChecked: number;
}>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const page = await fetchNewSignatures(mintAddress, sinceSignature);
    if (page.status !== 'ok') {
      const newestSignature = page.status === 'empty' ? sinceSignature : page.newestSignature;
      return { success: true, data: { mintEvents: [], rebalanceEvents: [], newestSignature, signaturesChecked: 0 } };
    }
    const { sigs, newestSignature } = page;

    const mintEvents: MintEvent[] = [];
    const rebalanceEvents: RebalanceEvent[] = [];

    for (const { signature, blockTime, err } of [...sigs].reverse()) {
      if (err) continue;
      const tx = await rpc<ParsedTransaction | null>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx) continue;

      const allInstructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
      ];

      // burnMateMint burned from the pool's own holdings in this same transaction, if any.
      const poolBurned = allInstructions
        .filter((ix) => {
          const info = ix.parsed?.info;
          if (ix.program !== 'spl-token' || !info) return false;
          if (ix.parsed?.type !== 'burn' && ix.parsed?.type !== 'burnChecked') return false;
          if (info.mint !== burnMateMint) return false;
          return resolveTokenAccountOwner(tx, info.account ?? '') === HYLO_STABILITY_POOL_WALLET;
        })
        .reduce((sum, ix) => sum + instructionAmount(ix), 0);

      for (const ix of allInstructions) {
        const info = ix.parsed?.info;
        if (ix.program !== 'spl-token' || !info) continue;
        if (ix.parsed?.type !== 'mintTo' && ix.parsed?.type !== 'mintToChecked') continue;
        if (info.mint !== mintAddress) continue;

        const destination = info.account ?? '';
        const owner = resolveTokenAccountOwner(tx, destination);
        const amount = instructionAmount(ix);

        if (owner === HYLO_REVENUE_WALLET) {
          logger.debug({ signature, mintAddress, destination }, 'Skipping mintTo to revenue wallet — fee portion');
          continue;
        }

        if (owner === HYLO_STABILITY_POOL_WALLET) {
          if (poolBurned > 0) {
            rebalanceEvents.push({ signature, blockTime, mintedAmount: amount, burnedAmount: poolBurned });
          } else {
            logger.debug({ signature, mintAddress, destination }, 'Skipping mintTo to stability pool wallet — no matching burn found');
          }
          continue;
        }

        mintEvents.push({
          signature,
          blockTime,
          mint: mintAddress,
          amount,
          destinationAccount: destination,
        });
      }
    }

    return { success: true, data: { mintEvents, rebalanceEvents, newestSignature, signaturesChecked: sigs.length } };
  } catch (err) {
    logger.warn({ err, mintAddress }, 'queryPoolRebalanceEvents failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// ─── Stability Pool rebalance history (on-demand, no DB) ──────────────────────
// Answers "last N Offload/Deployment events" straight from the chain, for the
// DM query. Unlike queryPoolRebalanceEvents above (checkpoint-based, scans a
// MINT's history for the tick loop), this scans the stability pool WALLET's
// own signature history backward — every rebalance necessarily burns FROM
// that wallet, so its history is almost entirely rebalance activity rather
// than the mint's full firehose of ordinary user mints, making a bounded
// backward scan practical for a live reply.

export type RebalanceDirection = 'OFFLOAD' | 'DEPLOYMENT';

export interface RecentRebalanceEvent {
  signature: string;
  blockTime: number | null;
  xSOLAmount: number; // decimal-adjusted
  hyUSDAmount: number; // decimal-adjusted
}

// A DM reply needs to be timely, not exhaustive. Bounding by page count alone
// turned out to be a poor proxy for that: this wallet's activity is bursty
// (one observed stretch was 1,200+ signatures in 33 minutes), so a fixed page
// count can represent anywhere from minutes to weeks of real history. A time
// budget bounds what actually matters — how long the DM reply takes — and
// naturally scans deeper when pages are cheap (quiet periods) and shallower
// when they're not (bursts, rate-limit backoff). RECENT_EVENTS_MAX_PAGES is
// just a hard backstop against a pathological loop, not the real limit.
const RECENT_EVENTS_TIME_BUDGET_MS = 20_000;
const RECENT_EVENTS_MAX_PAGES = 300;
// getTransaction calls in flight at once per page — tuned down from a flat
// Promise.all(100) after that triggered 429s from Helius even at 8.
const GET_TRANSACTION_CONCURRENCY = 5;

function sumPoolInstruction(
  tx: ParsedTransaction,
  allInstructions: ParsedInstruction[],
  kind: 'mintTo' | 'burn',
  mint: string,
): number {
  return allInstructions
    .filter((ix) => {
      const info = ix.parsed?.info;
      if (ix.program !== 'spl-token' || !info) return false;
      const type = ix.parsed?.type;
      const matchesKind = kind === 'mintTo' ? type === 'mintTo' || type === 'mintToChecked' : type === 'burn' || type === 'burnChecked';
      if (!matchesKind || info.mint !== mint) return false;
      return resolveTokenAccountOwner(tx, info.account ?? '') === HYLO_STABILITY_POOL_WALLET;
    })
    .reduce((sum, ix) => sum + instructionAmount(ix), 0);
}

/** Classifies a transaction touching the pool wallet as an Offload, a Deployment, or neither. */
function classifyPoolRebalance(
  tx: ParsedTransaction,
  allInstructions: ParsedInstruction[],
  hyUSDMint: string,
  xSOLMint: string,
): { direction: RebalanceDirection; mintedAmount: number; burnedAmount: number } | null {
  const hyUSDMinted = sumPoolInstruction(tx, allInstructions, 'mintTo', hyUSDMint);
  const xSOLBurned = sumPoolInstruction(tx, allInstructions, 'burn', xSOLMint);
  if (hyUSDMinted > 0 && xSOLBurned > 0) {
    return { direction: 'OFFLOAD', mintedAmount: hyUSDMinted, burnedAmount: xSOLBurned };
  }

  const xSOLMinted = sumPoolInstruction(tx, allInstructions, 'mintTo', xSOLMint);
  const hyUSDBurned = sumPoolInstruction(tx, allInstructions, 'burn', hyUSDMint);
  if (xSOLMinted > 0 && hyUSDBurned > 0) {
    return { direction: 'DEPLOYMENT', mintedAmount: xSOLMinted, burnedAmount: hyUSDBurned };
  }

  return null;
}

export async function queryRecentPoolRebalanceEvents(
  hyUSDMint: string,
  xSOLMint: string,
  direction: RebalanceDirection,
  maxResults: number,
): Promise<OnchainResult<{ events: RecentRebalanceEvent[]; pagesScanned: number }>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const [hyUSDSupply, xSOLSupply] = await Promise.all([queryTokenSupply(hyUSDMint), queryTokenSupply(xSOLMint)]);
    if (!hyUSDSupply.success || !xSOLSupply.success) {
      return { success: false, error: 'Could not resolve mint decimals for hyUSD/xSOL.' };
    }
    const hyUSDDecimals = hyUSDSupply.data.decimals;
    const xSOLDecimals = xSOLSupply.data.decimals;

    const events: RecentRebalanceEvent[] = [];
    let before: string | undefined;
    let pagesScanned = 0;
    const deadline = Date.now() + RECENT_EVENTS_TIME_BUDGET_MS;

    while (events.length < maxResults && pagesScanned < RECENT_EVENTS_MAX_PAGES && Date.now() < deadline) {
      const sigs = await rpc<SignatureInfo[]>('getSignaturesForAddress', [
        HYLO_STABILITY_POOL_WALLET,
        { limit: SIGNATURE_PAGE_SIZE, ...(before ? { before } : {}) },
      ]);
      pagesScanned++;
      if (sigs.length === 0) break;
      before = sigs[sigs.length - 1]!.signature;

      // Bounded concurrency — sequential per-signature fetching made even a
      // 20-page scan take minutes (mostly network round-trip latency), but
      // fetching a full page (100) at once triggers 429s from Helius.
      const clean = sigs.filter((s) => !s.err);
      const txs = await mapWithConcurrency(clean, GET_TRANSACTION_CONCURRENCY, ({ signature }) =>
        rpc<ParsedTransaction | null>('getTransaction', [
          signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ]),
      );

      for (let i = 0; i < clean.length; i++) {
        const tx = txs[i];
        if (!tx) continue;
        const { signature, blockTime } = clean[i]!;

        const allInstructions = [
          ...tx.transaction.message.instructions,
          ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
        ];

        const classified = classifyPoolRebalance(tx, allInstructions, hyUSDMint, xSOLMint);
        if (!classified || classified.direction !== direction) continue;

        const xSOLAmount = (classified.direction === 'OFFLOAD' ? classified.burnedAmount : classified.mintedAmount) / 10 ** xSOLDecimals;
        const hyUSDAmount = (classified.direction === 'OFFLOAD' ? classified.mintedAmount : classified.burnedAmount) / 10 ** hyUSDDecimals;
        events.push({ signature, blockTime, xSOLAmount, hyUSDAmount });
      }

      if (sigs.length < SIGNATURE_PAGE_SIZE) break; // reached the start of this wallet's history
    }

    if (events.length > maxResults) events.length = maxResults;

    return { success: true, data: { events, pagesScanned } };
  } catch (err) {
    logger.warn({ err, direction }, 'queryRecentPoolRebalanceEvents failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}


// ─── eHYUSD stake detection ────────────────────────────────────────────────────
// A raw mintTo instruction isn't enough to identify "who staked" — swap
// aggregators (Jupiter, Titan) can route the newly-minted eHYUSD through one
// or more of their own intermediate accounts before it lands with its real
// owner, and that real owner is not always the transaction's signer (fee
// payer) either — confirmed against a real missed stake where the eHYUSD
// ended up owned by a wallet that never signed the transaction at all. And a
// same-transaction flash mint-then-resell (e.g. an arb bot cycling through the
// pool) nets to zero for everyone even though a mintTo instruction fired.
//
// Pre/post token balance snapshots sidestep both problems: instead of trusting
// the signer, scan every distinct owner touched by the eHYUSD mint and take
// whoever ended up net-positive — that is the real beneficiary, regardless of
// how many hops or which account actually paid the transaction fee.

export interface StakeEvent {
  signature: string;
  blockTime: number | null;
  beneficiary: string; // whichever wallet ended up net-positive in eHYUSD — may differ from the tx signer
  eHYUSDNetAmount: number; // decimal-adjusted net change in the beneficiary's eHYUSD balance
  hyUSDDeposited: number;  // decimal-adjusted net change in the stake wallet's hyUSD balance
}

/** Whichever owner (other than `exclude`) ended up with the largest net-positive balance of `mint` in this tx. */
function findNetPositiveOwner(
  tx: ParsedTransaction,
  mint: string,
  exclude: string,
): { owner: string; net: number } | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const owners = new Set(
    [...pre, ...post].filter((b) => b.mint === mint && b.owner && b.owner !== exclude).map((b) => b.owner!),
  );
  let best: { owner: string; net: number } | null = null;
  for (const owner of owners) {
    const net = netBalanceChange(pre, post, owner, mint);
    if (net > 0 && (!best || net > best.net)) best = { owner, net };
  }
  return best;
}

/**
 * Detects genuine eHYUSD staking events: some wallet ends up net-positive in
 * eHYUSD (excluding the stake wallet itself — that's the depositor side, not
 * the beneficiary — and excluding same-tx flash mint-and-resell round trips,
 * which net to ~0 for everyone) AND the Hylo Stake Wallet's hyUSD balance
 * increases in the same transaction (confirms a real deposit backed the mint,
 * not some other pathway).
 */
export async function queryStakeEvents(
  eHYUSDMint: string,
  hyUSDMint: string,
  stakeWallet: string,
  sinceSignature: string | null,
): Promise<OnchainResult<{ events: StakeEvent[]; newestSignature: string | null; signaturesChecked: number }>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const page = await fetchNewSignatures(eHYUSDMint, sinceSignature);
    if (page.status !== 'ok') {
      const newestSignature = page.status === 'empty' ? sinceSignature : page.newestSignature;
      return { success: true, data: { events: [], newestSignature, signaturesChecked: 0 } };
    }
    const { sigs, newestSignature } = page;

    const events: StakeEvent[] = [];
    for (const { signature, blockTime, err } of [...sigs].reverse()) {
      if (err) continue;
      const tx = await rpc<ParsedTransaction | null>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx?.meta) continue;

      const hyUSDDeposited = netBalanceChange(tx.meta.preTokenBalances, tx.meta.postTokenBalances, stakeWallet, hyUSDMint);
      if (hyUSDDeposited <= 0) continue; // no corresponding deposit into the stake wallet

      const beneficiary = findNetPositiveOwner(tx, eHYUSDMint, stakeWallet);
      if (!beneficiary) continue; // no one actually ended up holding eHYUSD — flash resell or unrelated tx

      events.push({ signature, blockTime, beneficiary: beneficiary.owner, eHYUSDNetAmount: beneficiary.net, hyUSDDeposited });
    }

    return { success: true, data: { events, newestSignature, signaturesChecked: sigs.length } };
  } catch (err) {
    logger.warn({ err, eHYUSDMint }, 'queryStakeEvents failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

// ─── Single-transaction classification (debugging/verification) ───────────────
// Answers "how would the live detectors treat THIS specific transaction?"
// without waiting for it to fall inside a checkpoint-based page scan. Reuses
// the exact same rules as queryMintEvents/queryBurnEvents/queryPoolRebalanceEvents/
// queryStakeEvents — same exclusion wallets, same ownership checks — rather
// than re-deriving an independent interpretation of the raw instructions.

export interface ClassifiedFlow {
  symbol: string;
  action: 'MINT' | 'BURN';
  amount: number; // raw integer, NOT decimal-adjusted
  excludedReason?: 'revenue_fee' | 'stability_pool_rebalance_leg';
}

export interface TransactionClassification {
  signature: string;
  found: boolean;
  failed: boolean; // tx.meta.err was set — an on-chain failure, not a real event
  blockTime: number | null;
  flows: ClassifiedFlow[];
  rebalance: { direction: RebalanceDirection; hyUSDAmount: number; xSOLAmount: number } | null;
  stake: { beneficiary: string; eHYUSDNetAmount: number; hyUSDDeposited: number } | null;
}

export interface KnownMints {
  HYUSD?: string;
  XSOL?: string;
  HYLOSOL?: string;
  'HYLOSOL+'?: string;
  EHYUSD?: string;
  stakeWallet?: string; // eHYUSD's collateral/stake wallet — needed to classify stake events
}

export async function classifyTransaction(
  signature: string,
  mints: KnownMints,
): Promise<OnchainResult<TransactionClassification>> {
  if (!config.helius.enabled) return { success: false, error: 'HELIUS_API_KEY not configured.' };
  try {
    const tx = await rpc<ParsedTransaction | null>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) return { success: true, data: { signature, found: false, failed: false, blockTime: null, flows: [], rebalance: null, stake: null } };

    const failed = Boolean(tx.meta?.err);
    const blockTime = tx.blockTime ?? null;

    const allInstructions = [
      ...tx.transaction.message.instructions,
      ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
    ];

    const symbolByMint = new Map<string, string>();
    for (const [symbol, mint] of Object.entries(mints)) {
      if (symbol !== 'stakeWallet' && mint) symbolByMint.set(mint, symbol);
    }

    // Rebalance check first — same logic as queryPoolRebalanceEvents: a
    // stability-pool-owned mintTo on one side paired with a stability-pool-owned
    // burn of the mate mint, in the same transaction.
    let rebalance: TransactionClassification['rebalance'] = null;
    if (mints.HYUSD && mints.XSOL) {
      const hyUSDMinted = allInstructions
        .filter((ix) => {
          const info = ix.parsed?.info;
          if (ix.program !== 'spl-token' || !info) return false;
          if (ix.parsed?.type !== 'mintTo' && ix.parsed?.type !== 'mintToChecked') return false;
          if (info.mint !== mints.HYUSD) return false;
          return resolveTokenAccountOwner(tx, info.account ?? '') === HYLO_STABILITY_POOL_WALLET;
        })
        .reduce((sum, ix) => sum + instructionAmount(ix), 0);
      const xSOLBurned = allInstructions
        .filter((ix) => {
          const info = ix.parsed?.info;
          if (ix.program !== 'spl-token' || !info) return false;
          if (ix.parsed?.type !== 'burn' && ix.parsed?.type !== 'burnChecked') return false;
          if (info.mint !== mints.XSOL) return false;
          return resolveTokenAccountOwner(tx, info.account ?? '') === HYLO_STABILITY_POOL_WALLET;
        })
        .reduce((sum, ix) => sum + instructionAmount(ix), 0);

      if (hyUSDMinted > 0 && xSOLBurned > 0) {
        rebalance = { direction: 'OFFLOAD', hyUSDAmount: hyUSDMinted, xSOLAmount: xSOLBurned };
      } else {
        const xSOLMinted = allInstructions
          .filter((ix) => {
            const info = ix.parsed?.info;
            if (ix.program !== 'spl-token' || !info) return false;
            if (ix.parsed?.type !== 'mintTo' && ix.parsed?.type !== 'mintToChecked') return false;
            if (info.mint !== mints.XSOL) return false;
            return resolveTokenAccountOwner(tx, info.account ?? '') === HYLO_STABILITY_POOL_WALLET;
          })
          .reduce((sum, ix) => sum + instructionAmount(ix), 0);
        const hyUSDBurned = allInstructions
          .filter((ix) => {
            const info = ix.parsed?.info;
            if (ix.program !== 'spl-token' || !info) return false;
            if (ix.parsed?.type !== 'burn' && ix.parsed?.type !== 'burnChecked') return false;
            if (info.mint !== mints.HYUSD) return false;
            return resolveTokenAccountOwner(tx, info.account ?? '') === HYLO_STABILITY_POOL_WALLET;
          })
          .reduce((sum, ix) => sum + instructionAmount(ix), 0);
        if (xSOLMinted > 0 && hyUSDBurned > 0) {
          rebalance = { direction: 'DEPLOYMENT', hyUSDAmount: hyUSDBurned, xSOLAmount: xSOLMinted };
        }
      }
    }

    // Generic mint/burn classification — same exclusions as queryMintEvents /
    // queryBurnEvents. Anything already accounted for via `rebalance` above is
    // marked excluded here too, so it's visible but not double-reported.
    const flows: ClassifiedFlow[] = [];
    for (const ix of allInstructions) {
      const info = ix.parsed?.info;
      if (ix.program !== 'spl-token' || !info) continue;
      const type = ix.parsed?.type;
      const mint = info.mint;
      if (!mint || !symbolByMint.has(mint)) continue;
      const symbol = symbolByMint.get(mint)!;

      if (type === 'mintTo' || type === 'mintToChecked') {
        const owner = resolveTokenAccountOwner(tx, info.account ?? '');
        const amount = instructionAmount(ix);
        if (owner === HYLO_REVENUE_WALLET) {
          flows.push({ symbol, action: 'MINT', amount, excludedReason: 'revenue_fee' });
        } else if (owner === HYLO_STABILITY_POOL_WALLET) {
          flows.push({ symbol, action: 'MINT', amount, excludedReason: 'stability_pool_rebalance_leg' });
        } else {
          flows.push({ symbol, action: 'MINT', amount });
        }
      } else if (type === 'burn' || type === 'burnChecked') {
        const owner = resolveTokenAccountOwner(tx, info.account ?? '');
        const amount = instructionAmount(ix);
        if (owner === HYLO_STABILITY_POOL_WALLET) {
          flows.push({ symbol, action: 'BURN', amount, excludedReason: 'stability_pool_rebalance_leg' });
        } else {
          flows.push({ symbol, action: 'BURN', amount });
        }
      }
    }

    // Stake classification — same rule as queryStakeEvents: find whoever
    // actually ended up holding the eHYUSD (not necessarily the tx signer —
    // a Squad vault or aggregator-routed beneficiary can differ from it).
    let stake: TransactionClassification['stake'] = null;
    if (mints.EHYUSD && mints.HYUSD && mints.stakeWallet && tx.meta) {
      const hyUSDDeposited = netBalanceChange(tx.meta.preTokenBalances, tx.meta.postTokenBalances, mints.stakeWallet, mints.HYUSD);
      const beneficiary = hyUSDDeposited > 0 ? findNetPositiveOwner(tx, mints.EHYUSD, mints.stakeWallet) : null;
      if (beneficiary) {
        stake = { beneficiary: beneficiary.owner, eHYUSDNetAmount: beneficiary.net, hyUSDDeposited };
      }
    }

    return { success: true, data: { signature, found: true, failed, blockTime, flows, rebalance, stake } };
  } catch (err) {
    logger.warn({ err, signature }, 'classifyTransaction failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}
