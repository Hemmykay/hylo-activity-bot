/**
 * Test 1b — feed cadence/latency + identify the tracked mints by pulling
 * one transaction per event type and reading the SPL mintTo/burn mints.
 * Also: does a Swap* event's transaction contain a raw mintTo the bot
 * would currently alert on?
 */
import { apiGet, heliusAsset } from './hylo-api.js';

interface FeedEvent { signature: string; eventName: string; eventType: string; program: string; blockTime: string; eventData: any }

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

function parseTime(s: string): number {
  const t = Date.parse(s.endsWith('Z') || s.includes('+') ? s : s + 'Z');
  return t;
}

async function main() {
  const res = await apiGet('/v1/protocol/activity?limit=200');
  if (!('json' in res)) { console.log('FAILED', res); return; }
  const events: FeedEvent[] = res.json.events;
  console.log('raw blockTime sample:', JSON.stringify(events[0].blockTime));

  const times = events.map((e) => parseTime(e.blockTime)).filter(Number.isFinite);
  const newest = Math.max(...times), oldest = Math.min(...times);
  const spanMin = (newest - oldest) / 60_000;
  console.log(`\n— cadence —`);
  console.log(`200 events span ${(spanMin / 60).toFixed(2)}h → ${(200 / spanMin).toFixed(2)} events/min avg`);
  console.log(`feed latency: newest event ${(Date.now() - newest) / 1000 | 0}s old (vs local clock; local TZ offset applies)`);

  // Identify mints: pull one tx per mint-producing event type and read the mintTo mints
  const probeTypes = ['MintStablecoin', 'MintLevercoin', 'MintLevercoinExo', 'SwapStableToLever', 'SwapStableToLeverExo', 'SwapLeverToStable', 'UserDeposit', 'SettleRebalancePnl'];
  console.log('\n— mint identification (one tx per type) —');
  const mintsBySymbol = new Map<string, string>();
  const swapsWithMintTo: string[] = [];
  for (const type of probeTypes) {
    const ev = events.find((e) => e.eventType === type);
    if (!ev) { console.log(`  ${type}: none in page`); continue; }
    try {
      const tx: any = await rpc('getTransaction', [ev.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!tx) { console.log(`  ${type} (${ev.signature.slice(0, 8)}): tx not visible yet`); continue; }
      const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions)];
      const mintTos: string[] = [], burns: string[] = [];
      for (const ix of ixs) {
        const info = ix.parsed?.info;
        if (ix.program !== 'spl-token' || !info) continue;
        if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') mintTos.push(info.mint);
        if (ix.parsed.type === 'burn' || ix.parsed.type === 'burnChecked') burns.push(info.mint);
      }
      const named: string[] = [];
      for (const m of [...new Set([...mintTos, ...burns])]) {
        const a = await heliusAsset(m);
        const label = a?.symbol ? `${a.symbol}=${m}` : m;
        named.push(label);
        if (a?.symbol && !mintsBySymbol.has(a.symbol)) mintsBySymbol.set(a.symbol, m);
      }
      console.log(`  ${type}: mintTo→[${mintTos.length}] burn→[${burns.length}] of ${named.join(', ')}`);
      if (type.startsWith('Swap') && mintTos.length > 0) swapsWithMintTo.push(`${type}@${ev.signature.slice(0, 12)}`);
    } catch (e) {
      console.log(`  ${type}: rpc error ${String(e).slice(0, 80)}`);
    }
  }

  console.log('\n— identified mints —');
  for (const [s, m] of mintsBySymbol) console.log(`  ${s}: ${m}`);
  console.log(`\nSwap* txs containing raw mintTo (bot WOULD alert today): ${swapsWithMintTo.length ? swapsWithMintTo.join(', ') : 'none'}`);

  // UserWithdraw / RedeemStablecoin checks happen in the parity test next.
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
