/**
 * Jupiter Price API — underlying-asset USD price feed.
 *
 * Replaces what used to be Pyth Hermes (hermes.pyth.network): Pyth made
 * Hermes require an API key on 2026-08-26, turning a previously-free public
 * endpoint into a paid one beyond a 14-day trial. Jupiter's price API
 * (lite-api.jup.ag) is Solana-native, free, and needs no key — and since it
 * resolves by mint address rather than an opaque feed ID, it fits this
 * codebase's existing on-chain-mint-first design better than Pyth did.
 *
 * Every public function returns { success, data?, error? } and never throws,
 * so a Jupiter failure cannot propagate to the main bot flow.
 */
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('jupiter-price');

const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const TIMEOUT_MS = 5_000;

// ─── Result envelope (mirrors Helius pattern) ─────────────────────────────────

export type PriceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ─── Public data shapes ───────────────────────────────────────────────────────

export interface PriceFeed {
  symbol: string;
  price: number;
  /** 24h % change (e.g. 12.62 meaning +12.62%) — Jupiter reports this natively, no separate historical lookup needed. Null if Jupiter didn't include it. */
  priceChange24hPct: number | null;
  formatted: string; // "$173.42"
}

// ─── Mint registry ─────────────────────────────────────────────────────────────
// Jupiter resolves by mint address, not symbol.

export const MINT_IDS: Record<string, string> = {
  SOL:     'So11111111111111111111111111111111111111112',
  // No plain BTC SPL token exists on Solana — cbBTC is Hylo's own BTC proxy,
  // already used this way throughout the xBTC price formula.
  BTC:     'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
  CBBTC:   'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
  ETH:     '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // Wormhole-wrapped ETH
  USDC:    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  BONK:    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  HYPE:    '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g',
};

// Reverse map: mint → symbol — built once at module load
const MINT_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(MINT_IDS).map(([sym, mint]) => [mint, sym]),
);

// ─── Internal helpers ─────────────────────────────────────────────────────────

export function fmtUsd(n: number): string {
  if (n >= 1_000) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 1)     return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8)}`;
}

interface JupiterPriceEntry {
  usdPrice: number;
  priceChange24h?: number;
}

function parseFeed(sym: string, entry: JupiterPriceEntry): PriceFeed {
  return {
    symbol: sym,
    price: entry.usdPrice,
    priceChange24hPct: typeof entry.priceChange24h === 'number' && Number.isFinite(entry.priceChange24h) ? entry.priceChange24h : null,
    formatted: fmtUsd(entry.usdPrice),
  };
}

async function fetchJupiter(mints: string[]): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${JUPITER_PRICE_URL}?ids=${mints.join(',')}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the current price for a single symbol (e.g. "SOL", "BTC").
 * Returns success:false when the symbol has no configured mint or Jupiter is unreachable.
 */
export async function queryPrice(symbol: string): Promise<PriceResult<PriceFeed>> {
  const upper = symbol.toUpperCase();
  const mint = MINT_IDS[upper];
  if (!mint) return { success: false, error: `No mint configured for ${upper}.` };

  try {
    const res = await fetchJupiter([mint]);
    const json = await res.json() as Record<string, JupiterPriceEntry | undefined>;
    const entry = json[mint];
    if (!entry) throw new Error('Empty response from Jupiter price API');
    return { success: true, data: parseFeed(upper, entry) };
  } catch (err) {
    logger.warn({ err, symbol: upper }, 'Jupiter queryPrice failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Fetch current prices for multiple symbols in a single HTTP request.
 * Symbols with no configured mint are silently omitted from the result map.
 */
export async function queryPrices(symbols: string[]): Promise<PriceResult<Record<string, PriceFeed>>> {
  const pairs = symbols
    .map((s) => [s.toUpperCase(), MINT_IDS[s.toUpperCase()]] as [string, string | undefined])
    .filter((p): p is [string, string] => Boolean(p[1]));

  if (pairs.length === 0) {
    return { success: false, error: `No mints configured for: ${symbols.join(', ')}` };
  }

  try {
    const res = await fetchJupiter(pairs.map(([, mint]) => mint));
    const json = await res.json() as Record<string, JupiterPriceEntry | undefined>;
    const result: Record<string, PriceFeed> = {};
    for (const [mint, entry] of Object.entries(json)) {
      const sym = MINT_TO_SYMBOL[mint];
      if (sym && entry) result[sym] = parseFeed(sym, entry);
    }
    return { success: true, data: result };
  } catch (err) {
    logger.warn({ err, symbols }, 'Jupiter queryPrices failed');
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}
