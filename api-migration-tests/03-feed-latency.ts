/**
 * Test 3 — Forward feed-latency probe.
 * Polls the feed page 1 every 30s for ~10 minutes; for each newly-seen signature
 * records (chainTimeWhenSeen - eventBlockTime) = end-to-end indexer latency.
 * Also tracks how often a poll sees zero new events vs chain-time expectation.
 */
import { apiGet } from './hylo-api.js';

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

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
  const seen = new Set<string>();
  const lags: number[] = [];
  const rounds: Array<{ at: string; newEvents: number }> = [];
  const ROUNDS = 20, INTERVAL = 30_000;

  for (let r = 0; r < ROUNDS; r++) {
    try {
      const epoch: any = await rpc('getEpochInfo', []);
      const chainNowS: any = await rpc('getBlockTime', [epoch.absoluteSlot]);
      const res = await apiGet('/v1/protocol/activity?limit=50');
      let newEvents = 0;
      if ('json' in res && res.status === 200) {
        for (const e of res.json.events ?? []) {
          if (seen.has(e.signature)) continue;
          seen.add(e.signature);
          newEvents++;
          const bt = Date.parse(e.blockTime);
          if (Number.isFinite(bt)) lags.push((Number(chainNowS) * 1000 - bt) / 1000);
        }
      } else {
        console.log(`poll ${r}: feed error ${'error' in res ? res.error : res.status}`);
      }
      rounds.push({ at: new Date(Number(chainNowS) * 1000).toISOString(), newEvents });
      console.log(`poll ${String(r).padStart(2)} @ ${rounds[rounds.length - 1].at}: +${newEvents} new` + (lags.length ? ` | lag so far: min=${Math.min(...lags).toFixed(0)}s p50=${[...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)].toFixed(0)}s max=${Math.max(...lags).toFixed(0)}s n=${lags.length}` : ''));
    } catch (e) {
      console.log(`poll ${r}: error ${String(e).slice(0, 100)}`);
    }
    if (r < ROUNDS - 1) await new Promise((s) => setTimeout(s, INTERVAL));
  }

  console.log('\n— latency distribution (chain-time minus event blockTime, at first sighting) —');
  const sorted = [...lags].sort((a, b) => a - b);
  if (sorted.length) {
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(0);
    console.log(`n=${sorted.length} min=${sorted[0]!.toFixed(0)}s p25=${p(0.25)}s p50=${p(0.5)}s p75=${p(0.75)}s p95=${p(0.95)}s max=${sorted[sorted.length - 1]!.toFixed(0)}s`);
  } else {
    console.log('no new events observed during probe (quiet stretch)');
  }
  const quiet = rounds.filter((x) => x.newEvents === 0).length;
  console.log(`polls with 0 new events: ${quiet}/${rounds.length}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
