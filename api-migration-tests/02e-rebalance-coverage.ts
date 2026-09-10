/**
 * Test 2e — Stability Pool rebalance coverage.
 * 1. Use the bot's own queryRecentPoolRebalanceEvents (scans the pool wallet's
 *    signature history over RPC) to find recent Offload/Deployment events.
 * 2. For each, query /v1/protocol/activity?signature=<sig> — does the feed carry
 *    them, and as which eventType?
 * 3. Also classify the feed's SettleRebalancePnl / SwapExoToUsdc events with the
 *    bot's classifyTransaction to see the reverse mapping.
 */
import { apiGet } from './hylo-api.js';
import {
  queryRecentPoolRebalanceEvents, classifyTransaction,
} from '../src/services/onchain/helius.service.js';

const HYUSD = '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E';
const XSOL = '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs';
const XBTC = '2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL';
const XHYPE = '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx';
const EHYUSD = 'HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz';

async function main() {
  console.log('— bot RPC scanner: recent pool rebalances (this is the expensive call we\'d eliminate) —');
  for (const direction of ['OFFLOAD', 'DEPLOYMENT'] as const) {
    const t0 = Date.now();
    const r = await queryRecentPoolRebalanceEvents(HYUSD, XSOL, direction, 3);
    if (!r.success) { console.log(`${direction}: FAILED ${r.error}`); continue; }
    console.log(`${direction}: ${r.data.events.length} found, ${r.data.pagesScanned} pages scanned, ${(Date.now() - t0) / 1000 | 0}s`);
    for (const e of r.data.events) {
      console.log(`   ${e.signature}  xSOL=${e.xSOLAmount.toFixed(4)} hyUSD=${e.hyUSDAmount.toFixed(4)} @ ${e.blockTime ? new Date(e.blockTime * 1000).toISOString() : '?'}`);
      const f = await apiGet(`/v1/protocol/activity?signature=${e.signature}`);
      if ('json' in f && f.status === 200 && (f.json.events ?? []).length > 0) {
        for (const fe of f.json.events) {
          console.log(`      feed: ${fe.eventType} data=${JSON.stringify(fe.eventData).slice(0, 200)}`);
        }
      } else {
        console.log('      feed: NOT INDEXED');
      }
    }
  }

  console.log('\n— reverse: classify feed\'s SettleRebalancePnl/SwapExoToUsdc sigs with the bot\'s classifier —');
  let cursor: string | undefined;
  const targets: any[] = [];
  for (let p = 0; p < 12 && targets.length < 5; p++) {
    const r = await apiGet(`/v1/protocol/activity?limit=200${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    if (!('json' in r)) break;
    for (const e of r.json.events) {
      if (['SettleRebalancePnl', 'SwapExoToUsdc', 'HarvestYield', 'HarvestBorrowRate'].includes(e.eventType)) targets.push(e);
    }
    cursor = r.json.cursor;
    if (!cursor) break;
  }
  const mints = { HYUSD, XSOL, XBTC, XHYPE, EHYUSD };
  for (const t of targets.slice(0, 5)) {
    const c = await classifyTransaction(t.signature, mints);
    if (!c.success) { console.log(`${t.eventType} ${t.signature.slice(0, 12)}: classify FAILED ${c.error}`); continue; }
    const d = c.data;
    console.log(`${t.eventType} (${new Date(t.blockTime).toISOString()}): flows=[${d.flows.map((f) => `${f.action} ${f.symbol} ${f.amount / 1e6}${f.excludedReason ? ` (${f.excludedReason})` : ''}`).join(', ')}] rebalance=${d.rebalance ? `${d.rebalance.direction} hyUSD=${d.rebalance.hyUSDAmount / 1e6} xSOL=${d.rebalance.xSOLAmount / 1e6}` : 'null'} feedData=${JSON.stringify(t.eventData).slice(0, 160)}`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
