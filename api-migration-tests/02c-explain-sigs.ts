/**
 * Test 2c — explain the three divergent signatures from the parity run:
 *  - 3NXXW2h4… (bot MINT XSOL, feed had nothing in-window) → is it in the feed at all? (lag vs miss)
 *  - 23Z9FVY… / 2vVWdw1N… (feed MintStablecoin, scanner didn't count) → who received the hyUSD?
 */
import { apiGet } from './hylo-api.js';

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HYUSD = '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E';
const POOL_WALLET = '5YrRAQag9BbJkauDtJkd1vsTquXT6N46oU8rJ66GDxHd';
const REVENUE_WALLET = '3HT6dD6APJh89XJs9rkn3BmsvkXE9jPG9dWJmUjWu6TS';

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

const sigs = process.argv.slice(2);
for (const sig of sigs) {
  console.log(`\n=== ${sig} ===`);
  const r = await apiGet(`/v1/protocol/activity?signature=${sig}`);
  if ('json' in r && r.status === 200) {
    const evs = r.json.events ?? [];
    if (evs.length === 0) console.log('feed per-tx: NO EVENTS (not indexed)');
    else for (const e of evs) console.log(`feed per-tx: ${e.eventType} (${e.program}) blockTime=${e.blockTime} data=${JSON.stringify(e.eventData).slice(0, 220)}`);
  } else console.log('feed per-tx lookup failed', r);

  const tx: any = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
  if (!tx) { console.log('rpc: tx not found'); continue; }
  console.log(`rpc: blockTime=${tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : '?'}`);
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions)];
  for (const ix of ixs) {
    const info = ix.parsed?.info;
    if (ix.program !== 'spl-token' || !info) continue;
    if (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') {
      let destOwner: string | null = null;
      const idx = tx.transaction.message.accountKeys.findIndex((k: any) => k.pubkey === info.account);
      if (idx >= 0) destOwner = tx.meta?.postTokenBalances?.find((b: any) => b.accountIndex === idx)?.owner ?? null;
      const tag = info.mint === HYUSD ? 'hyUSD' : info.mint.slice(0, 6);
      const who = destOwner === POOL_WALLET ? 'STABILITY-POOL' : destOwner === REVENUE_WALLET ? 'REVENUE' : destOwner ?? '?';
      console.log(`  mintTo ${tag} amount=${info.tokenAmount?.uiAmountString ?? info.amount} → ${who}`);
    }
    if (ix.parsed.type === 'burn' || ix.parsed.type === 'burnChecked') {
      const tag = info.mint === HYUSD ? 'hyUSD' : info.mint.slice(0, 6);
      console.log(`  burn ${tag} amount=${info.tokenAmount?.uiAmountString ?? info.amount}`);
    }
  }
}
