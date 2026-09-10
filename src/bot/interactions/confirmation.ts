import {
  EmbedBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalBuilder,
  type ButtonInteraction,
} from 'discord.js';
import { faqService } from '@/services/faq/faq.service.js';
import { venueService } from '@/services/venue/venue.service.js';
import { pendingActionRepository } from '@/db/repositories/pending-action.repository.js';
import { replyWithError, COLORS } from '@/lib/discord-utils.js';
import { createLogger } from '@/lib/logger.js';
import type { FAQCreatePayload, FAQDraftInput } from '@/services/faq/faq.types.js';

const logger = createLogger('confirmation-handler');

export async function handleConfirmationButton(interaction: ButtonInteraction): Promise<void> {
  const [action, pendingId] = interaction.customId.split(':') as [string, string];

  if (!pendingId) return;

  try {
    switch (action) {
      case 'confirm':
        await handleConfirm(interaction, pendingId);
        break;
      case 'edit':
        await handleEdit(interaction, pendingId);
        break;
      case 'cancel':
        await handleCancel(interaction, pendingId);
        break;
    }
  } catch (err) {
    logger.error({ err, pendingId, action }, 'Confirmation handler error');
    await replyWithError(interaction, err);
  }
}

async function handleConfirm(interaction: ButtonInteraction, pendingId: string) {
  await interaction.deferUpdate();

  const actor = { id: interaction.user.id, name: interaction.user.displayName };

  // Route to the correct service based on the pending action type
  const pending = await pendingActionRepository.findById(pendingId);
  if (!pending) {
    await interaction.editReply({
      content: 'This action has expired or was already completed.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (pending.actionType === 'VENUE_CREATE') {
    const venueName = await venueService.executeConfirmed(pendingId, actor);
    await interaction.editReply({
      content: '',
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('✅ Venue Saved')
          .setDescription(`**${venueName}** has been added to the venue list.`)
          .setTimestamp(),
      ],
      components: [],
    });
    return;
  }

  // Default: FAQ actions
  const { action, faqId } = await faqService.executeConfirmed(pendingId, actor);
  await interaction.editReply({
    content: '',
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('✅ FAQ Saved')
        .setDescription(`FAQ has been **${action}** successfully.`)
        .addFields({ name: 'ID', value: `\`${faqId}\``, inline: true })
        .setTimestamp(),
    ],
    components: [],
  });
}

async function handleEdit(interaction: ButtonInteraction, pendingId: string) {
  const pending = await pendingActionRepository.findById(pendingId);
  if (!pending) {
    await interaction.reply({ content: 'This action has expired or was already completed.', ephemeral: true });
    return;
  }

  const payload = pending.payload as unknown as FAQCreatePayload;
  const draft: FAQDraftInput = payload.draft;

  const modal = new ModalBuilder()
    .setCustomId(`faq-edit-modal:${pendingId}`)
    .setTitle('Edit FAQ');

  const fields = [
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setValue(draft.title)
        .setMaxLength(60)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('category')
        .setLabel('Category')
        .setStyle(TextInputStyle.Short)
        .setValue(draft.category)
        .setMaxLength(80)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('tags')
        .setLabel('Tags (comma-separated)')
        .setStyle(TextInputStyle.Short)
        .setValue(draft.tags.join(', '))
        .setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('question')
        .setLabel('Question')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(draft.question)
        .setMaxLength(500)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('answer')
        .setLabel('Answer (Markdown supported)')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(draft.answer.slice(0, 4000))
        .setMaxLength(4000)
        .setRequired(true),
    ),
  ];

  modal.addComponents(...fields);
  await interaction.showModal(modal);
}

async function handleCancel(interaction: ButtonInteraction, pendingId: string) {
  await interaction.deferUpdate();

  const pending = await pendingActionRepository.findById(pendingId);
  const isVenue = pending?.actionType === 'VENUE_CREATE';

  if (isVenue) {
    await venueService.cancelPending(pendingId);
  } else {
    await faqService.cancelPending(pendingId);
  }

  await interaction.editReply({
    content: '',
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.neutral)
        .setTitle('❌ Cancelled')
        .setDescription(isVenue ? 'The venue was not saved.' : 'The FAQ was not saved.')
        .setTimestamp(),
    ],
    components: [],
  });
}
