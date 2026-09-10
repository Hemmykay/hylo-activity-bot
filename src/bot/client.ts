import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { createLogger } from '@/lib/logger.js';
import { notifyDevError } from '@/services/dev-alert/dev-alert.service.js';

const logger = createLogger('discord-client');

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Channel,  // Required to receive DMs in uncached channels
    Partials.Message,
  ],
});

// discord.js's gateway/shard manager is an EventEmitter — if nothing listens
// for its 'error' event, Node's default behavior is to rethrow it, which is
// exactly what was crashing the whole process on a transient gateway hiccup
// (e.g. a WebSocket handshake timing out during reconnect). discord.js
// already retries these internally; these listeners just give the error
// somewhere to go instead of escaping as an uncaught exception.
client.on(Events.Error, (err) => {
  logger.error({ err }, 'Discord client error');
  void notifyDevError('Discord client error', err, 'discord-client-error');
});

client.on(Events.ShardError, (err, shardId) => {
  logger.warn({ err, shardId }, 'Shard connection error — discord.js will attempt to reconnect');
  void notifyDevError(`Discord shard ${shardId} error — reconnecting`, err, `shard-error-${shardId}`);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  logger.warn({ code: event.code, reason: event.reason, shardId }, 'Shard disconnected');
  void notifyDevError(
    `Discord shard ${shardId} disconnected (code ${event.code}) — reconnecting`,
    event.reason || 'no reason given',
    `shard-disconnect-${shardId}`,
  );
});

client.on(Events.ShardReconnecting, (shardId) => {
  logger.info({ shardId }, 'Shard reconnecting');
});

client.on(Events.ShardResume, (shardId, replayedEvents) => {
  logger.info({ shardId, replayedEvents }, 'Shard resumed');
});
