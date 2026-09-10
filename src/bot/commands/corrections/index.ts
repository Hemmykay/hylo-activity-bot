import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Correction } from '@prisma/client';
import { correctionRepository } from '@/db/repositories/correction.repository.js';
import { assertAuthorizedInteraction, replyWithError, COLORS } from '@/lib/discord-utils.js';

const PAGE_SIZE = 5;

export const data = new SlashCommandBuilder()
  .setName('corrections')
  .setDescription('Audit admin corrections to bot answers')
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List corrections — defaults to unstructured ones needing review')
      .addStringOption((opt) =>
        opt
          .setName('filter')
          .setDescription('Which corrections to show')
          .setRequired(false)
          .addChoices(
            { name: 'Pending review (unstructured)', value: 'pending' },
            { name: 'All corrections', value: 'all' },
            { name: 'Structured (FAQ created/updated)', value: 'structured' },
          ),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('page')
          .setDescription('Page number (default: 1)')
          .setRequired(false)
          .setMinValue(1),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });
  try {
    const sub = interaction.options.getSubcommand(true);
    if (sub === 'list') await handleList(interaction);
  } catch (err) {
    await replyWithError(interaction, err);
  }
}

// ─── List handler ─────────────────────────────────────────────────────────────

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const filter = (interaction.options.getString('filter') ?? 'pending') as 'pending' | 'all' | 'structured';
  const page   = interaction.options.getInteger('page') ?? 1;
  const offset = (page - 1) * PAGE_SIZE;

  const listOptions =
    filter === 'pending'    ? { unstructuredOnly: true }
    : filter === 'structured' ? { structuredOnly: true }
    : {};

  const [corrections, total] = await Promise.all([
    correctionRepository.findMany({ ...listOptions, limit: PAGE_SIZE, offset }),
    correctionRepository.count(filter === 'pending' ? { unstructuredOnly: true } : undefined),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterLabel =
    filter === 'pending'    ? 'Pending Review'
    : filter === 'structured' ? 'Structured'
    : 'All';

  if (corrections.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('Corrections — ' + filterLabel)
      .setDescription(
        filter === 'pending'
          ? 'No unstructured corrections — everything has been reviewed.'
          : 'No corrections found.',
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(filter === 'pending' ? COLORS.warning : COLORS.info)
    .setTitle(`Corrections — ${filterLabel}`)
    .setDescription(
      `Showing **${corrections.length}** of **${total}** · Page **${page}/${totalPages}**${
        filter === 'pending'
          ? '\n\nUse `/faq` or the `!` prefix to create FAQs from these, then they\'ll drop off this list.'
          : ''
      }`,
    )
    .setTimestamp();

  for (const c of corrections) {
    embed.addFields({ name: formatCorrectionTitle(c), value: formatCorrectionBody(c), inline: false });
  }

  if (page < totalPages) {
    embed.setFooter({ text: `Page ${page}/${totalPages} · Use /corrections list page:${page + 1} for more` });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatCorrectionTitle(c: Correction): string {
  const age   = relativeTime(c.createdAt);
  const badge = statusBadge(c);
  return `${badge}  ${age}  ·  \`${c.id.slice(-8)}\``;
}

function formatCorrectionBody(c: Correction): string {
  const lines = [
    `**Q:** ${trunc(c.originalQuestion, 90)}`,
    `**Bot:** ${trunc(c.wrongBotAnswer, 90)}`,
    `**Admin:** ${trunc(c.rawCorrection, 110)}`,
  ];
  if (c.faqAction === 'created') lines.push(`→ FAQ created: _${c.faqTitle ?? 'Untitled'}_`);
  if (c.faqAction === 'updated') lines.push(`→ FAQ updated: _${c.faqTitle ?? 'Untitled'}_`);
  if (c.faqAction === 'no_change') lines.push(`→ Reviewed — no FAQ change needed`);
  return lines.join('\n');
}

function statusBadge(c: Correction): string {
  if (!c.structured) return '⚠';
  if (c.faqAction === 'created') return '✅';
  if (c.faqAction === 'updated') return '🔄';
  return '🔍';
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function relativeTime(date: Date): string {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr  < 24)  return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
