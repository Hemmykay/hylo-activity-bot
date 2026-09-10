import { config } from './config/index.js';
import { createLogger } from './lib/logger.js';
import { prisma } from './db/prisma.js';
import { aiService } from './services/ai/ai.service.js';
import { client } from './bot/client.js';
import { setupRouter } from './bot/router.js';
import { Events } from 'discord.js';
import { pendingActionRepository } from './db/repositories/pending-action.repository.js';
import { startMintWatcher } from './services/mint-watcher/mint-watcher.service.js';
import { startPriceTickers, stopPriceTickers } from './services/price-ticker/price-ticker.service.js';
import { setDevAlertClient, notifyDevError } from './services/dev-alert/dev-alert.service.js';

const logger = createLogger('main');

// Route dev-attention DMs through the main client (queued until ready).
setDevAlertClient(client);

// A transient network hiccup at startup (WebSocket handshake timeout, brief
// DNS blip, Discord gateway hiccup) shouldn't take the whole process down —
// observed happening for real: "Opening handshake has timed out" on a plain
// `npm run dev`, which crashed main() and left the process dead since
// node --watch only restarts on file changes, not crashes. Retries with
// backoff instead, same shape as the Helius RPC retry in helius.service.ts.
const LOGIN_MAX_RETRIES = 5;
const LOGIN_RETRY_BASE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginWithRetry(token: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.login(token);
      return;
    } catch (err) {
      if (attempt >= LOGIN_MAX_RETRIES) throw err;
      const delayMs = LOGIN_RETRY_BASE_MS * 2 ** attempt;
      logger.warn({ err, attempt: attempt + 1, maxRetries: LOGIN_MAX_RETRIES, delayMs }, 'Discord login failed — retrying');
      await sleep(delayMs);
    }
  }
}

async function main() {
  logger.info(
    { chain: config.ai.providerChain.join(' → '), env: config.app.nodeEnv },
    'Starting Hylo Support Copilot',
  );

  // 1. Verify DB connectivity
  try {
    await prisma.$connect();
    logger.info('Database connection established');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to database');
    process.exit(1);
  }

  // 2. Confirm AI providers are initialised
  logger.info({ chain: aiService.chainDescription }, 'AI providers ready');

  // 3. Purge expired pending actions from a previous session
  const purged = await pendingActionRepository.purgeExpired();
  if (purged > 0) logger.info({ purged }, 'Purged expired pending actions');

  // 4. Register interaction router before login
  setupRouter(client);

  // 5. Log ready event, start the mint watcher
  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, 'Discord bot is online');
    logger.info(
      {
        commands: 'Run `npm run register-commands` once to register slash commands',
      },
      'Reminder',
    );
    startMintWatcher(client);
    startPriceTickers();
  });

  // 6. Connect to Discord
  await loginWithRetry(config.discord.token);
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully');
  await stopPriceTickers();
  await client.destroy();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

// discord.js funnels most gateway faults to its shard/error listeners (see
// bot/client.ts), but some `ws` faults — notably "Opening handshake has timed
// out" during a reconnect — escape as process-level uncaughtException /
// unhandledRejection instead. discord.js already reconnects on its own, so
// exiting here just turns a transient blip into full downtime. Only exit on
// faults that are NOT recognisably network-transient.
const TRANSIENT_MESSAGE_PATTERNS = [
  'opening handshake has timed out',
  'handshake',
  'websocket was closed',
  'websocket',
  'gateway',
  'shard',
  'econreset',
  'econnrefused',
  'etimedout',
  'eai_again',
  'enotfound',
  'epipe',
  'econnaborted',
  'socket hang up',
  'network socket disconnected',
  'und_err',
  'fetch failed',
  'request timed out',
];

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_RESPONSE_TIMEOUT',
]);

function isTransientNetworkFault(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | null)?.code;
  if (typeof code === 'string' || typeof code === 'number') {
    if (TRANSIENT_CODES.has(String(code).toUpperCase())) return true;
  }
  const msg = reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : String(reason ?? '');
  const lower = msg.toLowerCase();
  return TRANSIENT_MESSAGE_PATTERNS.some((p) => lower.includes(p));
}

// On the fatal paths the process is about to die, so give the DM a brief
// window (max 2s) to deliver before exiting — otherwise the alert is queued
// behind a process that never flushes it.
function exitAfterAlert(alert: Promise<void>): void {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
  void Promise.race([alert, timeout]).finally(() => process.exit(1));
}

process.on('unhandledRejection', (reason) => {
  if (isTransientNetworkFault(reason)) {
    logger.warn({ reason }, 'Transient network fault (unhandled rejection) — keeping process alive, discord.js will reconnect');
    void notifyDevError('Discord handshake/network fault — process survived, reconnecting', reason, 'discord-handshake');
    return;
  }
  logger.fatal({ reason }, 'Unhandled promise rejection');
  exitAfterAlert(notifyDevError('FATAL: unhandled promise rejection — process exiting', reason, 'fatal-rejection'));
});

process.on('uncaughtException', (err) => {
  if (isTransientNetworkFault(err)) {
    logger.warn({ err }, 'Transient network fault (uncaught exception) — keeping process alive, discord.js will reconnect');
    void notifyDevError('Discord handshake/network fault — process survived, reconnecting', err, 'discord-handshake');
    return;
  }
  logger.fatal({ err }, 'Uncaught exception');
  exitAfterAlert(notifyDevError('FATAL: uncaught exception — process exiting', err, 'fatal-exception'));
});

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
