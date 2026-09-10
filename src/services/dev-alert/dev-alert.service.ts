/**
 * Dev-attention DMs — one-way alerts to the on-call dev (see
 * config.devAlert.userId) for faults that need a human: Discord
 * handshake/network faults, shard disconnects, Helius RPC exhaustion,
 * ticker login failures.
 *
 * Two safeguards keep this from becoming DM spam:
 *  - Per-key cooldown: repeats of the same alert (key, default = title)
 *    are collapsed to one DM per COOLDOWN_MS. A flapping gateway can log
 *    dozens of warnings; the dev gets one DM, not dozens.
 *  - Pre-ready queue: alerts raised before the main client is ready (e.g. a
 *    handshake timeout during startup) are queued and flushed once the
 *    client is set via setDevAlertClient(). The queue is capped so a
 *    never-ready client can't leak memory.
 *
 * Sending never throws — a DM failure is just a warn log, never a crash.
 */
import { Events, type Client } from 'discord.js';
import { config } from '@/config/index.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('dev-alert');

const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;
// Discord message limit is 2000 chars — stay comfortably under it.
const MAX_CONTENT_CHARS = 1900;

let devClient: Client | null = null;
const pending: string[] = [];
const lastSentAt = new Map<string, number>();

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    const codeSuffix = typeof code === 'string' || typeof code === 'number' ? ` (code ${code})` : '';
    return `${reason.name}: ${reason.message}${codeSuffix}`;
  }
  return String(reason ?? 'unknown');
}

async function sendNow(content: string): Promise<void> {
  if (!devClient || !devClient.isReady()) {
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push(content);
    return;
  }
  try {
    const user = await devClient.users.fetch(config.devAlert.userId);
    await user.send(content);
  } catch (err) {
    logger.warn({ err }, 'Failed to send dev alert DM — alert dropped');
  }
}

async function flushPending(): Promise<void> {
  while (pending.length > 0) {
    const content = pending.shift()!;
    try {
      const user = await devClient!.users.fetch(config.devAlert.userId);
      await user.send(content);
    } catch (err) {
      logger.warn({ err }, 'Failed to flush queued dev alert DM — alert dropped');
    }
  }
}

/** Call once the main Discord client exists (before login is fine). */
export function setDevAlertClient(client: Client): void {
  devClient = client;
  client.once(Events.ClientReady, () => {
    void flushPending();
  });
  // If the client is somehow already ready, flush immediately.
  if (client.isReady()) void flushPending();
}

/**
 * DM the dev a one-line-headed alert. `details` is free text (kept short —
 * truncated to fit one Discord message). `key` selects the throttle bucket;
 * pass a stable key (e.g. `shard-disconnect-0`) for recurring faults so
 * repeats collapse instead of spamming.
 */
export async function notifyDev(title: string, details?: string, key?: string): Promise<void> {
  const alertKey = key ?? title;
  const now = Date.now();
  if (now - (lastSentAt.get(alertKey) ?? 0) < COOLDOWN_MS) {
    logger.debug({ alertKey }, 'Dev alert suppressed by cooldown');
    return;
  }
  lastSentAt.set(alertKey, now);

  const body = details ? `${title}\n${details}` : title;
  await sendNow(`🛠️ **Dev alert** — ${truncate(body, MAX_CONTENT_CHARS)}`);
}

/** notifyDev() specialised for errors — formats the reason automatically. */
export function notifyDevError(title: string, reason: unknown, key?: string): Promise<void> {
  return notifyDev(title, formatReason(reason), key);
}
