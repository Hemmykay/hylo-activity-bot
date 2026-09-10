/**
 * Price-ticker bots — one lightweight Discord bot per tracked asset (see
 * config.priceTickers). Two complementary pieces of display, both updated
 * every tick:
 *  - Nickname: current price, e.g. "eHYUSD - $1.47" — the bold name line.
 *  - Status: 24h change plus a token-specific suffix, e.g.
 *    "↑ $0.05 (+2.34%) · 2.63x".
 *    24h is current NAV vs a NAV we recorded ~24h ago (see
 *    priceSnapshotRepository) — not live leverage × the underlying's 24h
 *    move. Effective leverage on xSOL/xBTC/xHYPE is not constant over that
 *    window, so scaling the oracle move by today's multiplier would misstate
 *    the token. Until a symbol has 24h of snapshots, we bootstrap from
 *    resolveImpliedPastPrice (DEX % for eHYUSD, composition-constant
 *    reconstruction for leverage tokens). Suffix is live leverage for
 *    xASSETs (no suffix for eHYUSD).
 * Each ticker is its own separate bot application/token — that's a Discord
 * member-list display convention (one row per bot), not something a single
 * bot can fake by renaming itself. Uses REST calls throughout (guilds.fetch,
 * members.fetchMe), so no gateway intents are needed beyond logging in.
 *
 * Price resolution goes through the same resolveAssetPriceUsd() the
 * mint-watcher uses — its cache now serves any call within
 * FRESH_REUSE_MAX_AGE_MS of the last resolution for that symbol (see
 * asset-price.service.ts), so if the mint-watcher's own tick already priced
 * this asset moments ago, this loop reuses that instead of hitting
 * Helius/Jupiter again.
 */
import { Client, ActivityType } from 'discord.js';
import { config } from '@/config/index.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { resolveAssetLeverage, resolveAssetPriceUsd, resolveImpliedPastPrice } from '@/services/price/asset-price.service.js';
import { fmtUsd } from '@/services/price/jupiter-price.service.js';
import { priceSnapshotRepository } from '@/db/repositories/price-snapshot.repository.js';
import { createLogger } from '@/lib/logger.js';
import { notifyDevError } from '@/services/dev-alert/dev-alert.service.js';

const logger = createLogger('price-ticker');

const POLL_INTERVAL_MS = 60_000;

// A hung await inside tick() would otherwise stall an individual ticker's
// loop forever — same failure mode and same fix as the mint watcher's own
// tick loop (see mint-watcher.service.ts's TICK_TIMEOUT_MS comment).
const TICK_TIMEOUT_MS = 45_000;

const activeClients: Client[] = [];

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Appends " · 2.63x"; leaves the text unchanged when there is no suffix. */
function withSuffix(text: string, suffix: string | null): string {
  return suffix ? `${text} · ${suffix}` : text;
}

function tickerSuffix(leverage: number | null): string | null {
  if (leverage !== null) return `${leverage.toFixed(2)}x`;
  return null;
}

/** "↑ $0.05 (+2.34%)" if current >= past, "↓ $0.05 (-2.34%)" otherwise. */
function formatChange(current: number, past: number, suffix: string | null = null): string {
  const absChange = current - past;
  const pctChange = past !== 0 ? (absChange / past) * 100 : 0;
  const arrow = absChange >= 0 ? '↑' : '↓';
  const sign = absChange >= 0 ? '+' : '-';
  return withSuffix(
    `${arrow} ${fmtUsd(Math.abs(absChange))} (${sign}${Math.abs(pctChange).toFixed(2)}%)`,
    suffix,
  );
}

async function tick(symbol: string, client: Client): Promise<void> {
  const assets = await assetRepository.findAll({ activeOnly: true });
  const assetMap = new Map(assets.map((a) => [a.symbol, a]));

  if (!assetMap.has(symbol)) {
    logger.warn({ symbol }, 'Ticker asset not found or inactive — leaving previous nickname as-is');
    return;
  }

  const price = await resolveAssetPriceUsd(symbol, assetMap);
  if (price === null) {
    logger.warn({ symbol }, 'Price unavailable this cycle — leaving previous nickname as-is');
    return;
  }

  const priceText = fmtUsd(price);

  // Always record so every symbol has a real NAV history. 24h change is
  // that snapshot vs now; implied past is only a bootstrap until one exists.
  const leverage = await resolveAssetLeverage(symbol, assetMap);
  await priceSnapshotRepository.record(symbol, price);
  const snapshotPrice = (await priceSnapshotRepository.findNear24hAgo(symbol))?.price ?? null;
  const pastPrice = snapshotPrice
    ?? (await resolveImpliedPastPrice(symbol, price, assetMap));
  const suffix = tickerSuffix(leverage);
  const statusText = pastPrice !== null
    ? formatChange(price, pastPrice, suffix)
    : withSuffix(priceText, suffix);

  client.user?.setPresence({
    activities: [{ name: statusText, type: ActivityType.Custom, state: statusText }],
    status: 'online',
  });

  const nickname = `${client.user!.username} - ${priceText}`;
  const guilds = await client.guilds.fetch();
  if (guilds.size === 0) {
    logger.warn({ symbol }, 'Ticker bot is not a member of any guild — nothing to update');
    return;
  }

  for (const [guildId] of guilds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const me = await guild.members.fetchMe();
      await me.setNickname(nickname);
    } catch (err) {
      logger.error({ err, symbol, guildId }, 'Failed to update ticker nickname in this guild — likely missing Change Nickname permission');
    }
  }

  logger.debug({ symbol, price, nickname, statusText }, 'Ticker nickname updated');
}

async function loop(symbol: string, client: Client): Promise<void> {
  try {
    await withTimeout(tick(symbol, client), TICK_TIMEOUT_MS, `${symbol} ticker tick`);
  } catch (err) {
    logger.error({ err, symbol }, 'Ticker tick failed — recovering and scheduling the next tick anyway');
  }
  setTimeout(() => { void loop(symbol, client); }, POLL_INTERVAL_MS).unref();
}

async function startTicker(symbol: string, token: string): Promise<void> {
  const client = new Client({ intents: [] });
  activeClients.push(client);

  // Same rationale as bot/client.ts: without these, a transient gateway
  // hiccup rethrows and escapes as a process-level uncaught exception.
  // discord.js reconnects internally; these listeners just give the fault
  // somewhere to go (the process-level filter in index.ts is the backstop
  // for `ws` faults like handshake timeouts that bypass even these).
  client.on('error', (err) => {
    logger.error({ err, symbol }, 'Ticker bot client error');
    void notifyDevError(`Ticker ${symbol}: client error`, err, `ticker-error-${symbol}`);
  });
  client.on('shardError', (err, shardId) => {
    logger.warn({ err, symbol, shardId }, 'Ticker shard error — discord.js will attempt to reconnect');
    void notifyDevError(`Ticker ${symbol}: shard error — reconnecting`, err, `ticker-shard-${symbol}`);
  });
  client.on('shardDisconnect', (event, shardId) => {
    logger.warn({ symbol, shardId, code: event.code, reason: event.reason }, 'Ticker shard disconnected');
    void notifyDevError(
      `Ticker ${symbol}: shard disconnected (code ${event.code}) — reconnecting`,
      event.reason || 'no reason given',
      `ticker-shard-${symbol}`,
    );
  });
  client.on('shardReconnecting', (shardId) => {
    logger.info({ symbol, shardId }, 'Ticker shard reconnecting');
  });
  client.on('shardResume', (shardId, replayedEvents) => {
    logger.info({ symbol, shardId, replayedEvents }, 'Ticker shard resumed');
  });

  // A handshake timeout at startup rejects login() — retry with backoff
  // rather than parking this ticker dead for the life of the process.
  const TICKER_LOGIN_MAX_RETRIES = 5;
  const TICKER_LOGIN_RETRY_BASE_MS = 2_000;
  for (let attempt = 0; ; attempt++) {
    try {
      await client.login(token);
      break;
    } catch (err) {
      if (attempt >= TICKER_LOGIN_MAX_RETRIES) {
        logger.error({ err, symbol }, 'Ticker bot failed to log in — this ticker will not run');
        void notifyDevError(`Ticker ${symbol}: login failed after retries — ticker down`, err, `ticker-login-${symbol}`);
        return;
      }
      const delayMs = TICKER_LOGIN_RETRY_BASE_MS * 2 ** attempt;
      logger.warn({ err, symbol, attempt: attempt + 1, delayMs }, 'Ticker login failed — retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  logger.info({ symbol, tag: client.user?.tag }, 'Ticker bot online');
  void loop(symbol, client);
}

export function startPriceTickers(): void {
  if (config.priceTickers.length === 0) {
    logger.info('No TICKER_BOT_TOKEN_* configured — price-ticker bots disabled');
    return;
  }
  for (const { symbol, token } of config.priceTickers) {
    void startTicker(symbol, token);
  }
}

export async function stopPriceTickers(): Promise<void> {
  await Promise.all(activeClients.map((c) => c.destroy()));
}
