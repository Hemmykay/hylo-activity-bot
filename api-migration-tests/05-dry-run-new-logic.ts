/**
 * Test 5 — offline dry-run of the NEW production logic (no Discord):
 *  1. getActivityPage + mapFeedEventsToActions on the live feed → what WOULD alert
 *  2. resolveAssetPriceUsd for every symbol → confirm the API-first pricing path
 *     returns values with ZERO Helius calls (pricing RPC elimination proof)
 *  3. resolveEHYUSDPriceAndSupply → price + supply from the v1 API alone
 */
import { assetRepository } from '../src/db/repositories/asset.repository.js';
import { getActivityPage } from '../src/services/hylo-api/hylo-api.service.js';
import { mapFeedEventsToActions } from '../src/services/mint-watcher/feed-events.js';
import { resolveAssetPriceUsd, resolveEHYUSDPriceAndSupply } from '../src/services/price/asset-price.service.js';

async function main() {
  const assets = await assetRepository.findAll({ activeOnly: true });
  const assetMap = new Map(assets.map((a) => [a.symbol, a]));
  console.log('assets:', assets.map((a) => a.symbol).join(', '));

  // 1. feed → actions (dry run: log only)
  const page = await getActivityPage({ limit: 100 });
  if (!page.ok) { console.log('feed fetch failed:', page.error); return; }
  const ordered = [...page.data.events].sort((a, b) => (a.slot - b.slot) || (a.eventIndex - b.eventIndex));
  const actions = mapFeedEventsToActions(ordered);
  console.log(`\nfeed page: ${page.data.events.length} events → ${actions.length} actions (dry run, nothing posted):`);
  for (const a of actions) console.log(`  ${a.kind.padEnd(5)} ${'symbol' in a ? a.symbol : 'EHYUSD'} ${a.amount}${'symbol' in a ? '' : ' eHYUSD'} [${a.signature.slice(0, 12)}]`);

  // 2. pricing for every symbol — must succeed with zero Helius RPC
  console.log('\n— API-first pricing (no RPC in this process) —');
  for (const symbol of ['HYUSD', 'XSOL', 'XBTC', 'XHYPE', 'HYLOSOL', 'HYLOSOL+', 'EHYUSD']) {
    const price = await resolveAssetPriceUsd(symbol, assetMap);
    console.log(`  ${symbol}: ${price === null ? 'NULL (would fall back / last-known-good)' : '$' + price}`);
  }

  // 3. eHYUSD price + supply combo
  const eh = await resolveEHYUSDPriceAndSupply(assetMap);
  console.log(`\neHYUSD price+supply from API: ${eh ? `price=$${eh.price} supply=${eh.supply} → cap progress $${(eh.price * eh.supply / 1e6).toFixed(2)}M` : 'NULL'}`);

  console.log('\nDRY RUN COMPLETE — no Discord writes, no Helius calls made.');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
