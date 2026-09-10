/**
 * Test 4 — Price & supply parity.
 *  1. /v1/protocol/prices (5m) latest vs /market-state (bot's current ticker primary)
 *  2. /v1/protocol/state internal identities (levercoinNav, leverage, ehyusdNav)
 *  3. state supplies vs Helius getTokenSupply (what the bot currently RPCs)
 *  4. HyloSOL sanity: price / SOL price = implied LST exchange rate
 */
import { apiGet, dec } from './hylo-api.js';

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const MINTS: Record<string, string> = {
  XSOL: '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs',
  XBTC: '2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL',
  XHYPE: '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx',
  EHYUSD: 'HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz',
};

async function rpcSupply(mint: string): Promise<number | null> {
  try {
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json();
    if (json.error) return null;
    const v = json.result?.value;
    return v ? Number(v.amount) / 10 ** v.decimals : null;
  } catch { return null; }
}

async function main() {
  const [prices, state, mstate] = await Promise.all([
    apiGet('/v1/protocol/prices?granularity=5m&days=1'),
    apiGet('/v1/protocol/state?granularity=5m'),
    apiGet('/market-state'),
  ]);
  if (!('json' in prices) || !('json' in state) || !('json' in mstate)) {
    console.log('fetch failed', { prices: prices.status, state: state.status, mstate: mstate.status });
    return;
  }

  // 1. latest 5m price per token from /v1/protocol/prices
  const apiPrice: Record<string, number> = {};
  for (const t of prices.json.tokens ?? []) {
    const last = t.series?.[t.series.length - 1];
    const v = dec(last?.usd);
    if (v !== null) apiPrice[t.token] = v;
  }
  console.log('— /v1/protocol/prices latest (5m) —');
  console.log(apiPrice);

  // 2. latest state bucket
  const bucket = (state.json.series ?? []).at(-1);
  console.log('\n— /v1/protocol/state latest bucket —', bucket?.ts);
  const markets: Record<string, any> = {};
  for (const m of bucket?.markets ?? []) markets[m.market] = m;

  // market-state (bot's current primary) for comparison
  const ms = mstate.json ?? {};
  const msNum = (v: any) => (v && typeof v.bits === 'string' ? Number(v.bits) * Math.pow(10, v.exp) : null);
  const msPools: Record<string, any> = {};
  for (const [key, sym] of [['sol', 'xSOL'], ['cbbtc', 'xBTC'], ['hype', 'xHYPE']] as const) {
    const ctx = ms.contexts?.[key];
    if (!ctx) continue;
    const tvl = msNum(ctx.total_value_locked), vUsd = msNum(ctx.virtual_stablecoin_supply), supply = msNum(ctx.levercoin_supply);
    if (tvl === null || vUsd === null || supply === null) continue;
    msPools[sym] = { price: (tvl - vUsd) / supply, leverage: tvl / (tvl - vUsd), tvl, vUsd, supply };
  }

  console.log('\n— xSOL/xBTC/xHYPE: v1 state vs market-state (bot primary) vs v1 prices —');
  for (const sym of ['xSOL', 'xBTC', 'xHYPE']) {
    const m = markets[sym === 'xSOL' ? 'SOL' : sym === 'xBTC' ? 'cbBTC' : 'HYPE'];
    const stNav = dec(m?.levercoinNav), stLev = dec(m?.levercoinLeverage), stSupply = dec(m?.levercoinSupply);
    const msP = msPools[sym];
    const p = apiPrice[sym];
    const navIdentity = m ? dec(m?.tvlUsd) !== null && stNav !== null && stSupply !== null
      ? Math.abs((dec(m.tvlUsd)! - dec(m.virtualStablecoinSupply)!) / stSupply - stNav) < 1e-6 : null : null;
    console.log(`${sym}: v1state nav=${stNav?.toFixed(6)} lev=${stLev?.toFixed(3)} supply=${stSupply?.toFixed(2)} | market-state price=${msP?.price.toFixed(6)} lev=${msP?.leverage.toFixed(3)} | v1prices=${p?.toFixed(6)} | nav identity holds=${navIdentity}`);
    if (msP && stNav) console.log(`   v1state vs market-state price delta: ${(((stNav - msP.price) / msP.price) * 100).toFixed(4)}%`);
    if (msP && stLev) console.log(`   v1state vs market-state leverage delta: ${(stLev - msP.leverage).toFixed(4)}`);
  }

  // 3. supplies: v1 state vs Helius getTokenSupply
  console.log('\n— supply parity: v1 state vs live RPC getTokenSupply —');
  for (const [sym, mint] of Object.entries(MINTS)) {
    const rpcSup = await rpcSupply(mint);
    let apiSup: number | null = null;
    if (sym === 'EHYUSD') apiSup = dec(bucket?.earnPool?.ehyusdSupply);
    else {
      const mk = sym === 'XSOL' ? 'SOL' : sym === 'XBTC' ? 'cbBTC' : 'HYPE';
      apiSup = dec(markets[mk]?.levercoinSupply);
    }
    const delta = rpcSup !== null && apiSup !== null ? ((apiSup - rpcSup) / rpcSup) * 100 : null;
    console.log(`${sym}: api=${apiSup?.toFixed(6)} rpc=${rpcSup?.toFixed(6)} delta=${delta === null ? '?' : delta.toFixed(4) + '%'}`);
  }

  // 4. HyloSOL sanity + eHYUSD identity
  console.log('\n— other assets —');
  const solPrice = apiPrice['SOL'], hyloSol = apiPrice['HyloSOL'], jito = apiPrice['JitoSOL'];
  if (solPrice && hyloSol) console.log(`HyloSOL ${hyloSol.toFixed(4)} / SOL ${solPrice.toFixed(2)} = exchange rate ${(hyloSol / solPrice).toFixed(4)} (expect ~1.0-1.3 for an appreciating LST)`);
  if (solPrice && jito) console.log(`JitoSOL ${jito.toFixed(4)} / SOL = ${(jito / solPrice).toFixed(4)}`);
  const ehNav = dec(bucket?.earnPool?.ehyusdNav), ehSup = dec(bucket?.earnPool?.ehyusdSupply), poolBal = dec(bucket?.earnPool?.hyusdPoolBalance);
  if (ehNav && ehSup && poolBal) console.log(`eHYUSD: nav=${ehNav.toFixed(6)} supply=${ehSup.toFixed(2)} | identity poolBal/supply=${(poolBal / ehSup).toFixed(6)} vs ehyusdNav ${ehNav.toFixed(6)}`);
  const ehPrice = apiPrice['eHYUSD'];
  if (ehPrice && ehNav) console.log(`eHYUSD v1prices=${ehPrice.toFixed(6)} vs state ehyusdNav=${ehNav.toFixed(6)} delta=${(((ehPrice - ehNav) / ehNav) * 100).toFixed(4)}%`);
  console.log(`hyUSD: v1prices=${apiPrice['HYUSD']} (expect ~1.0)`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
