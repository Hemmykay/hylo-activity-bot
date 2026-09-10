import { EmbedBuilder, type ModalSubmitInteraction } from 'discord.js';
import { pendingActionRepository } from '@/db/repositories/pending-action.repository.js';
import { faqService } from '@/services/faq/faq.service.js';
import { buildConfirmationRow, COLORS, truncate } from '@/lib/discord-utils.js';
import { client } from '@/bot/client.js';
import { createLogger } from '@/lib/logger.js';
import type { FAQCreatePayload, FAQDraftInput } from '@/services/faq/faq.types.js';

const logger = createLogger('faq-edit-modal');

export async function handleFAQEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, pendingId] = interaction.customId.split(':') as [string, string];

  if (!pendingId) return;

  await interaction.deferUpdate();

  try {
    const updatedDraft: FAQDraftInput = {
      title: interaction.fields.getTextInputValue('title'),
      category: interaction.fields.getTextInputValue('category'),
      tags: interaction.fields
        .getTextInputValue('tags')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      keywords: [], // Will be regenerated on next AI-assisted update
      question: interaction.fields.getTextInputValue('question'),
      answer: interaction.fields.getTextInputValue('answer'),
    };

    // Load current pending action to get the original discordMsgId
    const pending = await pendingActionRepository.findById(pendingId);
    if (!pending) {
      await interaction.followUp({ content: 'This action has expired. Please start again.', ephemeral: true });
      return;
    }

    const oldPayload = pending.payload as unknown as FAQCreatePayload;

    // Delete old pending and create a new one with updated data
    await faqService.cancelPending(pendingId);
    const newPendingId = await faqService.pendingCreate(
      updatedDraft,
      { id: interaction.user.id, name: interaction.user.displayName },
      oldPayload.channelId,
    );

    // Build updated preview embed
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📝 Updated FAQ Draft')
      .addFields(
        { name: 'Title', value: updatedDraft.title, inline: false },
        { name: 'Category', value: updatedDraft.category, inline: true },
        { name: 'Tags', value: updatedDraft.tags.join(', ') || 'none', inline: true },
        { name: 'Question', value: updatedDraft.question, inline: false },
        { name: 'Answer', value: truncate(updatedDraft.answer, 900), inline: false },
      )
      .setFooter({ text: 'Review and confirm to save' })
      .setTimestamp();

    // Try to update the original message
    if (pending.discordMsgId) {
      try {
        const dmUser = await client.users.fetch(interaction.user.id);
        const dm = await dmUser.createDM();
        const originalMsg = await dm.messages.fetch(pending.discordMsgId);
        const updatedMsg = await originalMsg.edit({
          content: 'FAQ updated — confirm to save:',
          embeds: [embed],
          components: [buildConfirmationRow(newPendingId)],
        });
        await faqService.setPendingDiscordMsgId(newPendingId, updatedMsg.id);
      } catch {
        // Can't edit the original (e.g. guild channel) — follow up with new message
        logger.debug('Could not edit original message, sending new preview');
        await interaction.followUp({
          content: 'FAQ updated — confirm to save:',
          embeds: [embed],
          components: [buildConfirmationRow(newPendingId)],
          ephemeral: true,
        });
      }
    } else {
      await interaction.followUp({
        content: 'FAQ updated — confirm to save:',
        embeds: [embed],
        components: [buildConfirmationRow(newPendingId)],
        ephemeral: true,
      });
    }
  } catch (err) {
    logger.error({ err }, 'FAQ edit modal error');
    try {
      await interaction.followUp({ content: 'Something went wrong. Please try again.', ephemeral: true });
    } catch { /* interaction may have already been cleaned up */ }
  }
}
