/**
 * Shared helpers for the api-migration tests — plain fetch, never throws,
 * same conventions as market-state.service.ts.
 */
const BASE = 'https://api.hylo.so';
const TIMEOUT_MS = 10_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function apiGet(path: string): Promise<{ status: number; json: any; ms: number } | { status: number; error: string; ms: number }> {
  const t = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - t;
    if (!res.ok) return { status: res.status, error: `HTTP ${res.status} ${res.statusText}`, ms };
    return { status: res.status, json: await res.json(), ms };
  } catch (err) {
    return { status: 0, error: String(err instanceof Error ? err.message : err), ms: Date.now() - t };
  }
}

/** Decimal ({bits,exp}) | number | string -> number; null when unparseable. */
export function dec(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (typeof v === 'object' && typeof v.bits === 'string' && typeof v.exp === 'number') {
    const n = Number(v.bits) * Math.pow(10, v.exp);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Collect base58-ish 32-44 char strings (candidate pubkeys) from any JSON value. */
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function collectPubkeys(v: any, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') { if (B58.test(v)) out.add(v); }
  else if (Array.isArray(v)) for (const x of v) collectPubkeys(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectPubkeys(x, out);
  return out;
}

/** Helius getAsset, minimal + cached. */
const assetCache = new Map<string, { symbol: string; name: string }>();
export async function heliusAsset(mint: string): Promise<{ symbol: string; name: string } | null> {
  const hit = assetCache.get(mint);
  if (hit) return hit;
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json: any = await res.json();
    const symbol = json?.result?.content?.metadata?.symbol ?? json?.result?.token_info?.symbol ?? '';
    const name = json?.result?.content?.metadata?.name ?? '';
    if (!symbol && !name) return null;
    const found = { symbol, name };
    assetCache.set(mint, found);
    return found;
  } catch {
    return null;
  }
}
