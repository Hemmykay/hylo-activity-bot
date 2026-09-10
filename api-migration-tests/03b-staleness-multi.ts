/**
 * Test 3b — feed staleness vs chain truth, and per-instruction event emission.
 * 1. Newest feed event blockTime vs newest chain signatures on the busy mints.
 * 2. For a tx known to contain TWO MintLevercoinExo instructions (354jNyFzZw…),
 *    does per-tx mode return both events?
 */
import { apiGet } from './hylo-api.js';

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HYUSD = '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E';
const XSOL = '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs';

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

async function main() {
  // 1. Staleness
  const epoch: any = await rpc('getEpochInfo', []);
  const chainNowS: any = await rpc('getBlockTime', [epoch.absoluteSlot]);
  const chainNow = Number(chainNowS) * 1000;
  const r = await apiGet('/v1/protocol/activity?limit=5');
  const newest = r.json?.events?.[0];
  console.log(`chain now:     ${new Date(chainNow).toISOString()}`);
  if (newest) {
    const bt = Date.parse(newest.blockTime);
    console.log(`feed newest:   ${newest.blockTime} (${newest.eventType}) → ${((chainNow - bt) / 60000).toFixed(1)} min behind chain`);
  }
  for (const [sym, mint] of [['hyUSD', HYUSD], ['xSOL', XSOL]] as const) {
    const sigs: any[] = await rpc('getSignaturesForAddress', [mint, { limit: 3 }]);
    for (const s of sigs.slice(0, 2)) {
      const t = (s.blockTime ?? 0) * 1000;
      console.log(`chain ${sym}:   ${new Date(t).toISOString()} (${((chainNow - t) / 60000).toFixed(1)} min ago) ${s.signature.slice(0, 12)}${s.err ? ' [failed tx]' : ''}`);
    }
  }

  // 2. Multi-instruction tx → how many feed events?
  // find the full signature on the feed
  let full: string | null = null;
  let cursor: string | undefined;
  outer: for (let p = 0; p < 6; p++) {
    const pg = await apiGet(`/v1/protocol/activity?limit=200${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    if (!('json' in pg)) break;
    for (const e of pg.json.events) {
      if (e.signature.startsWith('354jNyFzZw')) { full = e.signature; break outer; }
    }
    cursor = pg.json.cursor;
    if (!cursor) break;
  }
  if (!full) { console.log('\nmulti-instruction tx not found on feed pages'); return; }
  const per = await apiGet(`/v1/protocol/activity?signature=${full}`);
  const evs = per.json?.events ?? [];
  console.log(`\nmulti-mint tx ${full.slice(0, 14)}… → feed per-tx mode returned ${evs.length} events:`);
  for (const e of evs) console.log(`  ${e.eventType} minted=${e.eventData?.minted ?? e.eventData?.stablecoin_minted ?? '?'}`);
  const tx: any = await rpc('getTransaction', [full, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions)];
  const mintTos = ixs.filter((ix: any) => ix.program === 'spl-token' && (ix.parsed?.type === 'mintTo' || ix.parsed?.type === 'mintToChecked'));
  console.log(`chain truth: ${mintTos.length} mintTo instructions (${mintTos.map((i: any) => i.parsed.info.tokenAmount.uiAmountString).join(', ')})`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
