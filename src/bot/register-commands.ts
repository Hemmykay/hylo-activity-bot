import { REST, Routes } from 'discord.js';
import { config } from '@/config/index.js';
import { commands } from './commands/index.js';
import { contextMenus } from './context-menus/index.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('register-commands');

// InteractionContextType values:  0 = Guild, 1 = BotDM, 2 = PrivateChannel
// ApplicationIntegrationType:     0 = GuildInstall, 1 = UserInstall
// Setting both new fields + legacy dm_permission guarantees DM visibility across
// all Discord client versions and caching layers.
function withDMSupport(json: unknown): unknown {
  return {
    ...(json as object),
    dm_permission: true,
    contexts: [0, 1],           // Guild + Bot DM
    integration_types: [0, 1],  // GuildInstall + UserInstall
  };
}

async function main() {
  const rest = new REST().setToken(config.discord.token);

  // ── Step 1: wipe all existing global commands ─────────────────────────────
  // This forces Discord to clear its cache so stale entries can't persist.
  logger.info('Clearing existing global commands…');
  await rest.put(Routes.applicationCommands(config.discord.clientId), { body: [] });
  logger.info('Global commands cleared');

  // ── Step 2: register fresh ────────────────────────────────────────────────
  const body = [
    ...Array.from(commands.values()).map((c) => withDMSupport(c.data.toJSON())),
    ...Array.from(contextMenus.values()).map((c) => withDMSupport(c.data.toJSON())),
  ];

  logger.info({ count: body.length }, 'Registering commands…');

  const data = await rest.put(
    Routes.applicationCommands(config.discord.clientId),
    { body },
  ) as unknown[];

  logger.info({ registered: data.length }, 'Commands registered successfully');
  logger.info(
    { commands: body.map((c) => (c as { name: string }).name) },
    'Registered command names',
  );
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to register commands');
  process.exit(1);
});
