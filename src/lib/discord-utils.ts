import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type MessageContextMenuCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type DMChannel,
  type Message,
} from 'discord.js';
import { isAppError, UnauthorizedError } from './errors.js';
import { config } from '@/config/index.js';
import { createLogger } from './logger.js';

const logger = createLogger('discord-auth');

export type SupportedInteraction =
  | ChatInputCommandInteraction
  | MessageContextMenuCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;

// ─── Authorization ────────────────────────────────────────────────────────────
// Access requires BOTH: the user's ID is in ALLOWED_USER_IDS, AND they hold
// REQUIRED_ROLE_ID.
//
// Role membership is always checked via a FRESH guild.members.fetch() rather
// than trusting interaction.member/message.member's role cache directly —
// GuildMemberRoleManager#cache is derived by cross-referencing against
// guild.roles.cache, which can come back incomplete independent of the
// user's actual roles. A fresh fetch is the only version of this that's
// proven reliable (confirmed against a real "should be authorized but
// interaction.member said no" case), so every context — slash commands,
// context menus, buttons, modals, @mentions, and DMs — goes through it.

async function hasRequiredRole(guild: Guild | null, userId: string): Promise<boolean> {
  if (!guild) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  return member ? member.roles.cache.has(config.discord.requiredRoleId) : false;
}

/** Guild-context boolean check (slash commands, context menus, buttons, modals, @mentions). */
export async function isAuthorized(userId: string, guild: Guild | null): Promise<boolean> {
  return config.discord.allowedUserIds.includes(userId) && (await hasRequiredRole(guild, userId));
}

/** Guild-context check (slash commands, context menus, buttons, modals, @mentions). */
export async function assertAuthorized(userId: string, guild: Guild | null): Promise<void> {
  if (!(await isAuthorized(userId, guild))) {
    throw new UnauthorizedError();
  }
}

// Resolved from the mint-alerts channel's guild and cached once found — avoids
// a dedicated GUILD_ID env var since it's always the same server. A missing
// channel ID caches permanently (nothing will change), but a fetch failure
// (transient network/permission hiccup) is NOT cached, so the next DM retries
// instead of being locked out of role checks for the process lifetime.
let homeGuildId: string | null | undefined;

async function resolveHomeGuildId(client: Client): Promise<string | null> {
  if (homeGuildId !== undefined) return homeGuildId;
  const channelId = config.mintAlerts.channelId;
  if (!channelId) {
    homeGuildId = null;
    return homeGuildId;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  const guildId = channel && 'guildId' in channel ? channel.guildId : null;
  if (guildId) homeGuildId = guildId;
  return guildId;
}

/** DM-context check: resolves the home guild since DMs carry no guild/role info at all. */
export async function assertAuthorizedDM(client: Client, userId: string): Promise<void> {
  if (!config.discord.allowedUserIds.includes(userId)) {
    throw new UnauthorizedError();
  }

  const guildId = await resolveHomeGuildId(client);
  if (!guildId) {
    logger.warn('Cannot verify role for DM — home guild is not resolvable (MINT_ALERTS_CHANNEL_ID unset or unreachable)');
    throw new UnauthorizedError();
  }

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!(await hasRequiredRole(guild, userId))) {
    throw new UnauthorizedError();
  }
}

/**
 * Auth check for any interaction (slash command, context menu, button,
 * modal) regardless of whether it fired in a guild or a DM.
 *
 * `interaction.guild` is always null for a DM-originated interaction, so
 * calling the guild-only assertAuthorized() directly on it fails every
 * time even for a correctly-authorized user (hasRequiredRole short-circuits
 * on a null guild) — every command registered with DM support needs this,
 * not the plain guild check, or it's unusable from DMs entirely.
 */
export async function assertAuthorizedInteraction(interaction: SupportedInteraction): Promise<void> {
  if (interaction.guild) {
    await assertAuthorized(interaction.user.id, interaction.guild);
  } else {
    await assertAuthorizedDM(interaction.client, interaction.user.id);
  }
}

// ─── Channels ─────────────────────────────────────────────────────────────────

export type SendableChannel = { send: (content: string) => Promise<{ id: string }>; messages: { edit: (id: string, content: string) => Promise<unknown> } };

/** Fetches a channel by ID and confirms it's a text channel the bot can post plain messages to. */
export async function getSendableChannel(client: Client, channelId: string): Promise<SendableChannel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !('send' in channel)) {
    logger.warn({ channelId }, 'Channel is not a sendable text channel');
    return null;
  }
  return channel as unknown as SendableChannel;
}

// ─── Embeds ───────────────────────────────────────────────────────────────────

export const COLORS = {
  success: 0x22c55e,
  error: 0xef4444,
  warning: 0xf59e0b,
  info: 0x3b82f6,
  neutral: 0x6b7280,
} as const;

/** Ensures text is safe for Discord embed descriptions (non-empty, max 4000 chars). */
export function safeEmbedText(text: string, maxLength = 4000): string {
  const trimmed = text.trim();
  if (!trimmed) return '*(no response — try again)*';
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength - 1) + '…' : trimmed;
}

export function successEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(title)
    .setDescription(safeEmbedText(description))
    .setTimestamp();
}

export function errorEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle(`⚠ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

export function infoEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

export function neutralEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.neutral)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

// ─── Copy Button ─────────────────────────────────────────────────────────────

export function buildCopyRow(copyId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy-text:${copyId}`)
      .setLabel('Copy Text')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─── Confirmation Buttons ─────────────────────────────────────────────────────

export function buildConfirmationRow(
  pendingActionId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${pendingActionId}`)
      .setLabel('Save')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`edit:${pendingActionId}`)
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cancel:${pendingActionId}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

// ─── Error Replies ────────────────────────────────────────────────────────────

/**
 * Sends a safe error reply to any supported interaction.
 * Hides internal details in production; shows them in development.
 */
export async function replyWithError(
  interaction: SupportedInteraction,
  err: unknown,
): Promise<void> {
  const message = isAppError(err)
    ? err.message
    : config.app.isDevelopment && err instanceof Error
      ? err.message
      : 'Something went wrong. Please try again.';

  const embed = errorEmbed('Error', message);
  const payload = { embeds: [embed], ephemeral: true };

  if (interaction.deferred && !interaction.replied) {
    // Must use editReply to resolve the deferred "thinking…" placeholder.
    // followUp would create a second message and leave "thinking…" stuck forever.
    await interaction.editReply(payload);
  } else if (interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

// ─── DM Guard ─────────────────────────────────────────────────────────────────

export function isDMChannel(channel: Message['channel']): channel is DMChannel {
  return channel.type === 1; // ChannelType.DM
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

/** Truncates a string and appends '…' if it exceeds maxLength. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

/** Wraps text in a Discord code block. */
export function codeBlock(text: string, lang = ''): string {
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

/** Block-character progress bar, e.g. "██████▒▒▒▒" for 62% at the default 10 segments. Clamps fraction to [0, 1]. */
export function renderProgressBar(fraction: number, segments = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * segments);
  return '█'.repeat(filled) + '▒'.repeat(segments - filled);
}

/** Compact millions-of-dollars format, e.g. 10_240_000 -> "$10.24M", 15_000_000 -> "$15M" (trailing zeros dropped). */
export function fmtUsdM(n: number): string {
  const millions = (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '');
  return `$${millions}M`;
}
