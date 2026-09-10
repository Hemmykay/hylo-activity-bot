/**
 * Test 1 — Event-feed coverage & freshness.
 *
 * Questions this answers:
 *  1. Which eventTypes/programs does /v1/protocol/activity actually carry?
 *  2. Do the mints the bot tracks appear (esp. HyloSOL / HyloSOL+ staking mints)?
 *  3. What's the event rate (to size the poll) and the feed's end-to-end latency?
 */
import { apiGet, dec, collectPubkeys, heliusAsset } from './hylo-api.js';

interface FeedEvent { signature: string; eventName: string; eventType: string; program: string; blockTime: string; slot: number; eventData: any }

async function main() {
  const events: FeedEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const path = `/v1/protocol/activity?limit=200${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
    const res = await apiGet(path);
    if (!('json' in res) || res.status !== 200) { console.log(`page ${page}: FAILED`, res); break; }
    const batch: FeedEvent[] = res.json.events ?? [];
    events.push(...batch);
    cursor = res.json.cursor;
    if (!cursor || batch.length === 0) break;
  }
  console.log(`fetched ${events.length} events`);

  if (events.length === 0) return;

  // Distinct types/programs
  const byType = new Map<string, number>();
  const byProgram = new Map<string, number>();
  for (const e of events) {
    byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);
    byProgram.set(e.program, (byProgram.get(e.program) ?? 0) + 1);
  }
  console.log('\n— eventTypes —');
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`);
  console.log('— programs —');
  for (const [p, n] of byProgram) console.log(`  ${p}: ${n}`);

  // Rate + latency
  const times = events.map((e) => new Date(e.blockTime + 'Z').getTime()).filter((t) => Number.isFinite(t));
  const newest = Math.max(...times), oldest = Math.min(...times);
  const spanMin = (newest - oldest) / 60_000;
  const now = Date.now();
  console.log(`\nwindow: ${(spanMin / 60).toFixed(2)}h, ${events.length} events → ${(events.length / spanMin).toFixed(2)} events/min`);
  console.log(`feed latency: newest event ${((now - newest) / 1000).toFixed(0)}s old (vs local clock)`);

  // eventData key shapes per type (first sample each)
  console.log('\n— eventData key shapes (one sample per type) —');
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.eventType)) continue;
    seen.add(e.eventType);
    console.log(`  ${e.eventType}: ${Object.keys(e.eventData ?? {}).join(', ')}`);
  }

  // Resolve candidate pubkeys found in eventData to symbols
  const mints = collectPubkeys(events.map((e) => e.eventData));
  console.log(`\n— resolving ${mints.size} candidate pubkeys from eventData via getAsset —`);
  const symbolToMint = new Map<string, string[]>();
  const resolved = new Map<string, string>();
  for (const mint of mints) {
    const a = await heliusAsset(mint);
    if (!a) { resolved.set(mint, '(no asset metadata — likely program/PDA/wallet)'); continue; }
    resolved.set(mint, `${a.symbol} (${a.name})`);
    const list = symbolToMint.get(a.symbol) ?? [];
    list.push(mint);
    symbolToMint.set(a.symbol, list);
  }
  for (const [m, d] of [...resolved.entries()].sort((a, b) => a[1].localeCompare(b[1]))) console.log(`  ${m} → ${d}`);

  // Which tracked symbols appear in events, and in which event types?
  const TRACKED = ['hyUSD', 'xSOL', 'xBTC', 'xHYPE', 'eHYUSD', 'HyloSOL', 'SOL', 'jitoSOL'];
  console.log('\n— tracked-symbol presence in feed —');
  for (const sym of TRACKED) {
    const mintsForSym = symbolToMint.get(sym) ?? [];
    if (mintsForSym.length === 0) { console.log(`  ${sym}: NOT FOUND in eventData`); continue; }
    const set = new Set(mintsForSym);
    const types = new Map<string, number>();
    for (const e of events) {
      const s = JSON.stringify(e.eventData ?? {});
      if (mintsForSym.some((m) => s.includes(m))) types.set(e.eventType, (types.get(e.eventType) ?? 0) + 1);
    }
    console.log(`  ${sym} [${mintsForSym.join(', ')}]: ${[...types.entries()].map(([t, n]) => `${t}×${n}`).join(', ') || 'no direct mention'}`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
