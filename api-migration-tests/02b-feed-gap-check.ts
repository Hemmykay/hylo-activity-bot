/**
 * Test 2b — is the feed MISSING activity the chain-scanner sees?
 * For each bot-only signature from the window: query /v1/protocol/activity?signature=<sig>
 * (per-tx mode) and search deep feed pages. Also measure per-type feed lag vs chain time.
 */
import { apiGet } from './hylo-api.js';
import { queryMintEvents, queryBurnEvents } from '../src/services/onchain/helius.service.js';

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const MINTS = {
  HYUSD: '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E',
  XSOL: '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs',
  XHYPE: '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx',
};

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

async function checkpointAt(address: string, cutoffTs: number): Promise<string | null> {
  let before: string | undefined;
  for (let page = 0; page < 6; page++) {
    const sigs: any[] = await rpc('getSignaturesForAddress', [address, { limit: 100, ...(before ? { before } : {}) }]);
    if (sigs.length === 0) return null;
    for (let i = 0; i < sigs.length; i++) { // newest → oldest: the NEWEST sig <= cutoff is the scanner's checkpoint
      if ((sigs[i].blockTime ?? 0) * 1000 <= cutoffTs) return sigs[i].signature;
    }
    before = sigs[sigs.length - 1].signature;
  }
  return null;
}

async function main() {
  // Chain "now" for lag math
  const epoch: any = await rpc('getEpochInfo', []);
  const chainNow: any = await rpc('getBlockTime', [epoch.absoluteSlot]);
  const nowChainMs = Number(chainNow) * 1000;
  console.log(`chain now: ${new Date(nowChainMs).toISOString()}`);

  const cutoff = Date.now() - 30 * 60 * 1000;
  const tracked = Object.entries(MINTS);
  const botEvents: Array<{ kind: string; symbol: string; signature: string }> = [];
  await Promise.all(tracked.map(async ([sym, mint]) => {
    const cp = await checkpointAt(mint, cutoff);
    const [m, b] = await Promise.all([queryMintEvents(mint, cp), queryBurnEvents(mint, cp)]);
    if (m.success) m.data.events.forEach((e) => botEvents.push({ kind: 'MINT', symbol: sym, signature: e.signature }));
    if (b.success) b.data.events.forEach((e) => botEvents.push({ kind: 'BURN', symbol: sym, signature: e.signature }));
  }));
  console.log(`bot scanner found ${botEvents.length} mint/burn events in last 30 min across ${tracked.map(([s]) => s).join('/')}`);

  // Deep feed: 10 pages x 200 = up to 2000 events (~25h)
  const feedAll: any[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < 10; p++) {
    const r = await apiGet(`/v1/protocol/activity?limit=200${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    if (!('json' in r)) { console.log(`feed page ${p} failed`); break; }
    feedAll.push(...r.json.events);
    cursor = r.json.cursor;
    if (!cursor) break;
  }
  const feedBySig = new Map<string, any>();
  for (const e of feedAll) if (!feedBySig.has(e.signature)) feedBySig.set(e.signature, e);
  console.log(`deep feed: ${feedAll.length} events, oldest ${feedAll.length ? feedAll[feedAll.length - 1].blockTime : 'n/a'}`);

  // Newest feed event per eventType
  const newestByType = new Map<string, number>();
  for (const e of feedAll) {
    const t = Date.parse(e.blockTime);
    if (!newestByType.has(e.eventType) || t > newestByType.get(e.eventType)!) newestByType.set(e.eventType, t);
  }
  console.log('\n— feed lag per eventType (vs chain now) —');
  for (const [t, ts] of [...newestByType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: newest ${((nowChainMs - ts) / 60000).toFixed(1)} min ago (${new Date(ts).toISOString()})`);
  }

  // Per bot-only sig: in deep feed? per-tx mode?
  let inFeedElsewhere = 0, perTxHit = 0, perTxMiss = 0;
  const missing: string[] = [];
  for (const ev of botEvents) {
    const inFeed = feedBySig.get(ev.signature);
    if (inFeed) { inFeedElsewhere++; continue; }
    const r = await apiGet(`/v1/protocol/activity?signature=${ev.signature}`);
    if ('json' in r && r.status === 200 && (r.json.events ?? []).length > 0) {
      perTxHit++;
      console.log(`  per-tx HIT (not in feed pages!): ${ev.kind} ${ev.symbol} ${ev.signature.slice(0, 12)} → ${(r.json.events ?? []).map((x: any) => x.eventType).join(',')}`);
    } else {
      perTxMiss++;
      missing.push(`${ev.kind} ${ev.symbol} ${ev.signature.slice(0, 16)}`);
    }
  }
  console.log(`\nbot-only sigs: ${botEvents.length} | found in deep feed pages: ${inFeedElsewhere} | per-tx lookup HIT: ${perTxHit} | per-tx lookup MISS (feed has NOTHING): ${perTxMiss}`);
  if (missing.length) console.log('  examples: ' + missing.slice(0, 10).join(' | '));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
