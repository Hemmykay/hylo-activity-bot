/**
 * Test 2d — amount parity at scale: for recent feed events of each user-facing
 * mint/redeem type, compare the feed's eventData amounts against what the bot's
 * instruction parser (same rules as queryMintEvents/queryBurnEvents) would
 * compute from getTransaction: sum of mintTo/burn amounts excluding
 * revenue-wallet destinations.
 */
import { apiGet } from './hylo-api.js';

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HYUSD = '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E';
const XSOL = '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs';
const XBTC = '2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL';
const XHYPE = '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx';
const EHYUSD = 'HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz';
const REVENUE = '3HT6dD6APJh89XJs9rkn3BmsvkXE9jPG9dWJmUjWu6TS';
const DEC: Record<string, number> = { [HYUSD]: 6, [XSOL]: 6, [XBTC]: 6, [XHYPE]: 6, [EHYUSD]: 6 };

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

/** Bot-parser equivalent: sum of mintTo (non-revenue) / burn amounts for `mint` in tx. */
async function botAmounts(sig: string, mint: string, kind: 'mint' | 'burn'): Promise<{ bot: number; excludedFee: number } | null> {
  const tx: any = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  if (!tx) return null;
  const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions)];
  let total = 0, excluded = 0;
  for (const ix of ixs) {
    const info = ix.parsed?.info;
    if (ix.program !== 'spl-token' || !info || info.mint !== mint) continue;
    const isMint = ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked';
    const isBurn = ix.parsed.type === 'burn' || ix.parsed.type === 'burnChecked';
    if (kind === 'mint' && !isMint) continue;
    if (kind === 'burn' && !isBurn) continue;
    const raw = Number(info.tokenAmount?.amount ?? info.amount ?? 0);
    if (kind === 'mint') {
      const idx = tx.transaction.message.accountKeys.findIndex((k: any) => k.pubkey === info.account);
      const owner = tx.meta?.postTokenBalances?.find((b: any) => b.accountIndex === idx)?.owner;
      if (owner === REVENUE) { excluded += raw / 10 ** (DEC[mint] ?? 6); continue; }
    }
    total += raw / 10 ** (DEC[mint] ?? 6);
  }
  return { bot: total, excludedFee: excluded };
}

interface Check { type: string; sig: string; feed: number | null; bot: number | null; fee: number | null; match: boolean | null }

async function main() {
  // Fetch feed pages until we have up to 5 events for each type of interest
  const want: Record<string, number> = {
    MintStablecoin: 4, MintLevercoin: 4, MintLevercoinExo: 4,
    RedeemStablecoin: 4, RedeemLevercoin: 4, RedeemLevercoinExo: 4,
    UserDeposit: 4, UserWithdraw: 4,
  };
  const found: any[] = [];
  let cursor: string | undefined;
  for (let p = 0; p < 14 && Object.values(want).some((n) => n > 0); p++) {
    const r = await apiGet(`/v1/protocol/activity?limit=200${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    if (!('json' in r)) { console.log('feed fetch failed'); break; }
    for (const e of r.json.events) {
      if (want[e.eventType] > 0) { want[e.eventType]--; found.push(e); }
    }
    cursor = r.json.cursor;
    if (!cursor) break;
  }
  console.log(`collected ${found.length} events for amount parity\n`);

  // eventType → [mint, kind, feedAmountKeys(s) to compare]
  const MAP: Record<string, Array<[string, 'mint' | 'burn', string[]]>> = {
    MintStablecoin: [[HYUSD, 'mint', ['stablecoin_minted']]],
    MintLevercoin: [[XSOL, 'mint', ['minted']]],
    MintLevercoinExo: [[XBTC, 'mint', ['minted']], [XHYPE, 'mint', ['minted']]],
    RedeemStablecoin: [[HYUSD, 'burn', ['stablecoin_burned']]],
    RedeemLevercoin: [[XSOL, 'burn', ['redeemed']]],
    RedeemLevercoinExo: [[XBTC, 'burn', ['redeemed']], [XHYPE, 'burn', ['redeemed']]],
    UserDeposit: [[EHYUSD, 'mint', ['lp_token_minted']]],
    UserWithdraw: [[EHYUSD, 'burn', ['lp_token_burned']]],
  };

  const results: Record<string, Check[]> = {};
  for (const ev of found) {
    const mapping = MAP[ev.eventType];
    if (!mapping) continue;
    for (const [mint, kind, keys] of mapping) {
      const feedVal = keys.map((k) => ev.eventData?.[k]).find((v) => v !== undefined);
      if (feedVal === undefined) continue;
      const ba = await botAmounts(ev.signature, mint, kind);
      const feed = Number(feedVal);
      const sym = Object.entries(DEC).find(([m]) => m === mint)?.[0].slice(0, 6);
      const bot = ba ? ba.bot : null;
      const match = ba ? Math.abs(feed - bot) < 5e-7 : null;
      (results[ev.eventType] ??= []).push({ type: ev.eventType, sig: ev.signature.slice(0, 10), feed, bot, fee: ba?.excludedFee ?? null, match });
    }
  }

  let pass = 0, fail = 0, unknown = 0;
  for (const [type, checks] of Object.entries(results)) {
    for (const c of checks) {
      const sym = type.includes('Stablecoin') && type.includes('Mint') ? 'hyUSD' : type.includes('Levercoin') && !type.includes('Exo') ? 'xSOL' : type.includes('User') ? 'eHYUSD' : 'xHYPE/xBTC';
      if (c.match === true) pass++;
      else if (c.match === false) fail++;
      else unknown++;
      console.log(`${c.match === true ? 'MATCH ' : c.match === false ? 'DIFF! ' : 'TX?   '} ${type.padEnd(20)} ${sym}: feed=${c.feed} bot=${c.bot}${c.fee ? ` (bot excluded fee=${c.fee})` : ''} [${c.sig}]`);
    }
  }
  console.log(`\nparity: ${pass} match, ${fail} differ, ${unknown} tx-not-fetched`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
