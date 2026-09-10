/**
 * Test 2 — Retrospective event parity: bot's RPC scanners vs /v1 activity feed
 * over the same ~30 minute window, matched by signature.
 *
 * No Discord, no DB. Uses the bot's own helius.service functions unmodified.
 */
import { apiGet } from './hylo-api.js';
import {
  queryMintEvents, queryBurnEvents, queryPoolRebalanceEvents, queryStakeEvents, queryTokenSupply,
} from '../src/services/onchain/helius.service.js';

interface SignatureInfo { signature: string; blockTime: number | null; err: unknown }

const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const MINTS = {
  HYUSD: '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E',
  XSOL: '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs',
  XHYPE: '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx',
  EHYUSD: 'HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz',
  // filled in below from chain
  XBTC: '' as string,
};
let STAKE_WALLET = '';

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

async function fetchPage(address: string, opts: Record<string, unknown>): Promise<SignatureInfo[]> {
  return rpc<SignatureInfo[]>('getSignaturesForAddress', [address, opts]);
}

/** Newest signature on `address` whose blockTime <= cutoffTs (bot-scanner checkpoint at cutoff). */
async function checkpointAt(address: string, cutoffTs: number): Promise<string | null> {
  let before: string | undefined;
  for (let page = 0; page < 6; page++) {
    const sigs = await fetchPage(address, { limit: 100, ...(before ? { before } : {}) });
    if (sigs.length === 0) return null;
    for (let i = 0; i < sigs.length; i++) { // newest → oldest: take the NEWEST sig <= cutoff
      const s = sigs[i]!;
      if ((s.blockTime ?? 0) * 1000 <= cutoffTs) return s.signature;
    }
    before = sigs[sigs.length - 1]!.signature;
  }
  return null;
}

interface BotEvent { kind: string; symbol: string; signature: string; amountUi: number | null }
const botEvents: BotEvent[] = [];
const gapMints: string[] = [];

function decimalsOf(raw: number, d: number | null) { return d === null ? raw : raw / 10 ** d; }

async function main() {
  // ── 0. Identify xBTC mint from a recent cbBTC-collateral event tx; derive stake wallet from a UserDeposit tx.
  const feed0 = await apiGet('/v1/protocol/activity?limit=200');
  if (!('json' in feed0)) { console.log('feed fetch failed', feed0); return; }
  const feedEvents: any[] = feed0.json.events;
  const exoEvt = feedEvents.find((e) => ['MintLevercoinExo', 'SwapStableToLeverExo'].includes(e.eventType) && e.eventData?.collateral_mint?.startsWith('cbbtcf'));
  if (exoEvt) {
    const tx: any = await rpc('getTransaction', [exoEvt.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions)];
    for (const ix of ixs) {
      const info = ix.parsed?.info;
      if (ix.program === 'spl-token' && info && (ix.parsed.type === 'mintTo' || ix.parsed.type === 'mintToChecked') && info.mint !== MINTS.HYUSD) {
        MINTS.XBTC = info.mint;
        break;
      }
    }
  }
  const depositEvt = feedEvents.find((e) => e.eventType === 'UserDeposit');
  if (depositEvt) {
    const tx: any = await rpc('getTransaction', [depositEvt.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (tx?.meta) {
      // owner with the largest positive hyUSD balance delta = the eHYUSD stake/collateral wallet
      const deltas = new Map<string, number>();
      const pre = tx.meta.preTokenBalances ?? [], post = tx.meta.postTokenBalances ?? [];
      for (const b of post) {
        if (b.mint !== MINTS.HYUSD || !b.owner) continue;
        const before = pre.find((x: any) => x.accountIndex === b.accountIndex)?.uiTokenAmount.uiAmount ?? 0;
        const d = (b.uiTokenAmount.uiAmount ?? 0) - before;
        if (d > 0 && d > (deltas.get(b.owner) ?? 0)) deltas.set(b.owner, d);
      }
      STAKE_WALLET = [...deltas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    }
  }
  console.log(`xBTC mint: ${MINTS.XBTC || 'NOT FOUND'} | eHYUSD stake wallet: ${STAKE_WALLET || 'NOT FOUND'}`);

  // ── 1. Define the window: [now-30min, now]. Feed events in-window:
  const now = Date.now();
  const cutoff = now - 30 * 60 * 1000;
  const inWindow = feedEvents.filter((e) => {
    const t = Date.parse(e.blockTime);
    return Number.isFinite(t) && t >= cutoff && t <= now;
  });
  console.log(`feed events in window (last 30 min): ${inWindow.length}`);

  // ── 2. Bot-scanner checkpoints at cutoff per tracked mint
  const tracked = [MINTS.HYUSD, MINTS.XSOL, MINTS.XBTC, MINTS.XHYPE, MINTS.EHYUSD].filter(Boolean);
  const checkpoints = new Map<string, string | null>();
  for (const mint of tracked) {
    checkpoints.set(mint, await checkpointAt(mint, cutoff));
  }
  const supplyResults = await Promise.all(tracked.map((m) => queryTokenSupply(m)));
  const decimals = new Map<string, number>();
  tracked.forEach((m, i) => { if (supplyResults[i]!.success) decimals.set(m, supplyResults[i]!.data.decimals); });
  console.log('decimals:', [...decimals.entries()].map(([m, d]) => `${m.slice(0, 6)}:${d}`).join(' '));

  const symOf = (mint: string) => Object.entries(MINTS).find(([, v]) => v === mint)?.[0] ?? mint.slice(0, 6);
  const push = (kind: string, mint: string, e: { signature: string; amount: number }) =>
    botEvents.push({ kind, symbol: symOf(mint), signature: e.signature, amountUi: decimalsOf(e.amount, decimals.get(mint) ?? null) });

  // ── 3. Run the bot's scanners over the window (exact prod functions)
  const tasks: Array<Promise<void>> = [];
  // generic mints + burns for xBTC/xHYPE (like tickGenericMintAsset); hyUSD/xSOL/eHYUSD have dedicated flows
  for (const mint of [MINTS.XBTC, MINTS.XHYPE]) {
    if (!mint) continue;
    tasks.push((async () => {
      const m = await queryMintEvents(mint, checkpoints.get(mint) ?? null);
      if (m.success) m.data.events.forEach((e) => push('MINT', mint, e)); else if (m.error.includes('Gap')) gapMints.push(symOf(mint));
      const b = await queryBurnEvents(mint, checkpoints.get(mint) ?? null);
      if (b.success) b.data.events.forEach((e) => push('BURN', mint, e));
    })());
  }
  // hyUSD: rebalance scan (Offload side) + burns excluding pool wallet
  tasks.push((async () => {
    const r = await queryPoolRebalanceEvents(MINTS.HYUSD, MINTS.XSOL, checkpoints.get(MINTS.HYUSD) ?? null);
    if (r.success) {
      r.data.mintEvents.forEach((e) => push('MINT', MINTS.HYUSD, e));
      r.data.rebalanceEvents.forEach((e) => botEvents.push({ kind: 'REBALANCE_OFFLOAD', symbol: 'HYUSD', signature: e.signature, amountUi: decimalsOf(e.mintedAmount, decimals.get(MINTS.HYUSD) ?? null) }));
    }
    const b = await queryBurnEvents(MINTS.HYUSD, checkpoints.get(MINTS.HYUSD) ?? null, { excludeStabilityPoolWallet: true });
    if (b.success) b.data.events.forEach((e) => push('BURN', MINTS.HYUSD, e));
  })());
  // xSOL: rebalance scan (Deployment side) + burns excluding pool wallet
  tasks.push((async () => {
    const r = await queryPoolRebalanceEvents(MINTS.XSOL, MINTS.HYUSD, checkpoints.get(MINTS.XSOL) ?? null);
    if (r.success) {
      r.data.mintEvents.forEach((e) => push('MINT', MINTS.XSOL, e));
      r.data.rebalanceEvents.forEach((e) => botEvents.push({ kind: 'REBALANCE_DEPLOYMENT', symbol: 'XSOL', signature: e.signature, amountUi: decimalsOf(e.mintedAmount, decimals.get(MINTS.XSOL) ?? null) }));
    }
    const b = await queryBurnEvents(MINTS.XSOL, checkpoints.get(MINTS.XSOL) ?? null, { excludeStabilityPoolWallet: true });
    if (b.success) b.data.events.forEach((e) => push('BURN', MINTS.XSOL, e));
  })());
  // eHYUSD stakes
  if (STAKE_WALLET) {
    tasks.push((async () => {
      const s = await queryStakeEvents(MINTS.EHYUSD, MINTS.HYUSD, STAKE_WALLET, checkpoints.get(MINTS.EHYUSD) ?? null);
      if (s.success) s.data.events.forEach((e) => botEvents.push({ kind: 'STAKE', symbol: 'EHYUSD', signature: e.signature, amountUi: e.eHYUSDNetAmount }));
    })());
  }
  await Promise.all(tasks);

  // ── 4. Diff by signature
  console.log(`\n— bot scanner events (${botEvents.length}) —`);
  const botBySig = new Map<string, BotEvent[]>();
  for (const e of botEvents) {
    const list = botBySig.get(e.signature) ?? [];
    list.push(e);
    botBySig.set(e.signature, list);
  }
  const feedBySig = new Map<string, any[]>();
  for (const e of inWindow) {
    const list = feedBySig.get(e.signature) ?? [];
    list.push(e);
    feedBySig.set(e.signature, list);
  }

  const allSigs = new Set([...botBySig.keys(), ...feedBySig.keys()]);
  let matched = 0, botOnly = 0, feedOnly = 0;
  for (const sig of allSigs) {
    const b = botBySig.get(sig);
    const f = feedBySig.get(sig);
    if (b && f) { matched++; continue; }
    if (b && !f) {
      botOnly++;
      console.log(`  BOT-ONLY: ${b.map((x) => `${x.kind} ${x.symbol} ${x.amountUi?.toFixed(4)}`).join(' + ')}  ${sig}`);
    }
    if (!b && f) {
      feedOnly++;
      console.log(`  FEED-ONLY: ${f.map((x) => x.eventType).join(' + ')}  ${sig}`);
    }
  }
  console.log(`\nsummary: matched=${matched} botOnly=${botOnly} feedOnly=${feedOnly}`);
  console.log(`(bot-only with kind MINT on a Swap* sig = bot alerting on swap-mints; feed classifies as Swap — expected divergence)`);
  console.log(`scanner 'gap' (window exceeded 100 sigs, resynced): ${gapMints.join(', ') || 'none'}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
