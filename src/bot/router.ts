import { ChannelType, Events, type Client, type Interaction, type Message } from 'discord.js';
import { commands } from './commands/index.js';
import { contextMenus } from './context-menus/index.js';
import { handleConfirmationButton } from './interactions/confirmation.js';
import { handleFAQEditModal } from './interactions/faq-edit-modal.js';
import { handleVenueAddModal } from './interactions/venue-modal.js';
import { handleVenueEditModal } from './interactions/venue-edit-modal.js';
import {
  handleAssetAddModal,
  handleAssetEditModal,
  handleAssetConfigureModal,
} from './interactions/asset-modal.js';
import { handleFAQLiveEditModal } from './interactions/faq-live-edit-modal.js';
import { handleDM } from './dm/handler.js';
import { routeIntent } from './dm/intent-router.js';
import { getCopyText } from '@/lib/copy-buffer.js';
import { isAuthorized, replyWithError } from '@/lib/discord-utils.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('router');

// Timestamp of when this process started. Any MessageCreate event whose
// message.createdTimestamp is older than this is a Discord gateway replay
// (e.g. after a `node --watch` hot-reload). We skip those to prevent
// duplicate replies.
const PROCESS_START = Date.now();

// Secondary deduplication within the same session (handles cases where
// Discord.js emits the same MessageCreate twice without a process restart).
const seenMessageIds = new Set<string>();
function markSeen(id: string): boolean {
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  setTimeout(() => seenMessageIds.delete(id), 5 * 60 * 1000).unref?.();
  return false;
}

async function handleInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    // ── Autocomplete ────────────────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      if (command?.autocomplete) {
        await command.autocomplete(interaction);
      } else {
        await interaction.respond([]);
      }
      return;
    }

    // ── Slash commands ──────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) {
        logger.warn({ name: interaction.commandName }, 'Unknown slash command');
        return;
      }
      // Every command's execute() calls assertAuthorized() (and other logic)
      // before its own try/catch — an uncaught throw there previously fell
      // through to the log-only catch below, leaving Discord's 3s ack window
      // to expire silently ("The application did not respond"). This
      // guarantees a real reply reaches the user no matter what throws.
      try {
        await command.execute(interaction);
      } catch (err) {
        await replyWithError(interaction, err);
      }
      return;
    }

    // ── Message context menus ───────────────────────────────────────────────
    if (interaction.isMessageContextMenuCommand()) {
      const menu = contextMenus.get(interaction.commandName);
      if (!menu) {
        logger.warn({ name: interaction.commandName }, 'Unknown context menu');
        return;
      }
      try {
        await menu.execute(interaction);
      } catch (err) {
        await replyWithError(interaction, err);
      }
      return;
    }

    // ── Button interactions ─────────────────────────────────────────────────
    if (interaction.isButton()) {
      const [prefix, id] = interaction.customId.split(':');

      if (prefix === 'copy-text') {
        const text = getCopyText(id ?? '');
        if (!text) {
          await interaction.reply({
            content: 'This copy button has expired. Run the command again to get a fresh one.',
            ephemeral: true,
          });
          return;
        }
        // Wrap in a code block — Discord renders a native copy icon on hover
        await interaction.reply({ content: `\`\`\`\n${text}\n\`\`\``, ephemeral: true });
        return;
      }

      if (prefix === 'confirm' || prefix === 'edit' || prefix === 'cancel') {
        try {
          await handleConfirmationButton(interaction);
        } catch (err) {
          await replyWithError(interaction, err);
        }
      }
      return;
    }

    // ── Modal submissions ───────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      try {
        if (interaction.customId.startsWith('faq-edit-modal:')) {
          await handleFAQEditModal(interaction);
        } else if (interaction.customId.startsWith('faq-live-edit-modal:')) {
          await handleFAQLiveEditModal(interaction);
        } else if (interaction.customId === 'venue-add-modal') {
          await handleVenueAddModal(interaction);
        } else if (interaction.customId.startsWith('venue-edit-modal:')) {
          await handleVenueEditModal(interaction);
        } else if (interaction.customId.startsWith('asset-add-modal:')) {
          await handleAssetAddModal(interaction);
        } else if (interaction.customId.startsWith('asset-edit-modal:')) {
          await handleAssetEditModal(interaction);
        } else if (interaction.customId.startsWith('asset-configure-modal:')) {
          await handleAssetConfigureModal(interaction);
        }
      } catch (err) {
        await replyWithError(interaction, err);
      }
      return;
    }
  } catch (err) {
    logger.error({ err, interactionType: interaction.type }, 'Unhandled interaction error');
  }
}

// ── Messages: DMs and guild @mentions ───────────────────────────────────────
async function handleMessageCreate(client: Client, message: Message): Promise<void> {
  if (message.partial) return;
  if (!message.author || message.author.bot) return;

  // Skip gateway replays delivered after a reconnect / hot-reload.
  if (message.createdTimestamp < PROCESS_START) {
    logger.debug(
      { messageId: message.id, ageMs: PROCESS_START - message.createdTimestamp },
      'Skipping pre-startup message (gateway replay)',
    );
    return;
  }

  // Secondary dedup for same-session duplicates.
  if (markSeen(message.id)) {
    logger.debug({ messageId: message.id }, 'Skipping duplicate MessageCreate');
    return;
  }

  // ── DM ────────────────────────────────────────────────────────────────────
  if (message.channel.type === ChannelType.DM) {
    try {
      await handleDM(message);
    } catch (err) {
      logger.error({ err }, 'Unhandled DM error');
    }
    return;
  }

  // ── Guild channel — only respond when @mentioned by an authorized user ────
  // Authorization requires both the user ID allowlist and the required role;
  // the @mention requirement avoids responding to every message in a busy channel.
  if (!message.guild || !client.user) return;
  if (!message.mentions.has(client.user)) return;
  if (!(await isAuthorized(message.author.id, message.guild))) return;

  // Strip all @mentions from the content so the intent router gets clean text.
  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content) return;

  logger.debug(
    { userId: message.author.id, guildId: message.guild.id, channelId: message.channelId },
    'Guild mention from authorized user',
  );

  try {
    await routeIntent(message, content);
  } catch (err) {
    logger.error({ err }, 'Unhandled guild message error');
  }
}

export function setupRouter(client: Client): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteractionCreate(interaction);
  });
  client.on(Events.MessageCreate, (message) => {
    void handleMessageCreate(client, message);
  });

  logger.info('Interaction router registered');
}
