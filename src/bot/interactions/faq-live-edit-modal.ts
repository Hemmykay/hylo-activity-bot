import { EmbedBuilder, type ModalSubmitInteraction } from 'discord.js';
import { faqService } from '@/services/faq/faq.service.js';
import { faqRepository } from '@/db/repositories/faq.repository.js';
import { assertAuthorizedInteraction, buildConfirmationRow, COLORS, replyWithError, truncate } from '@/lib/discord-utils.js';
import { createLogger } from '@/lib/logger.js';
import type { FAQDraftInput } from '@/services/faq/faq.types.js';

const logger = createLogger('faq-live-edit-modal');

export async function handleFAQLiveEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    await assertAuthorizedInteraction(interaction);

    const [, faqId] = interaction.customId.split(':') as [string, string];
    if (!faqId) return;

    // Verify the FAQ still exists
    const existing = await faqRepository.findById(faqId);
    if (!existing) {
      await interaction.reply({ content: 'This FAQ no longer exists.', ephemeral: true });
      return;
    }

    const tagsRaw = interaction.fields.getTextInputValue('tags');
    const changes: FAQDraftInput = {
      title: interaction.fields.getTextInputValue('title').trim(),
      category: interaction.fields.getTextInputValue('category').trim(),
      tags: tagsRaw.split(',').map((t) => t.trim()).filter(Boolean),
      keywords: existing.keywords, // preserve existing keywords
      question: interaction.fields.getTextInputValue('question').trim(),
      answer: interaction.fields.getTextInputValue('answer').trim(),
    };

    const actor = { id: interaction.user.id, name: interaction.user.displayName };
    const pendingId = await faqService.pendingUpdate(faqId, changes, actor, interaction.channelId ?? 'dm');

    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('✏️ FAQ Edit Preview')
      .addFields(
        { name: 'Title', value: changes.title, inline: false },
        { name: 'Category', value: changes.category, inline: true },
        { name: 'Tags', value: changes.tags.join(', ') || 'none', inline: true },
        { name: 'Question', value: changes.question, inline: false },
        { name: 'Answer', value: truncate(changes.answer, 900), inline: false },
      )
      .setFooter({ text: `Editing FAQ ${faqId.slice(-6)} — confirm to save` })
      .setTimestamp();

    await interaction.reply({
      content: 'Review your changes and confirm to save:',
      embeds: [embed],
      components: [buildConfirmationRow(pendingId)],
      ephemeral: true,
    });

    await faqService.setPendingDiscordMsgId(pendingId, interaction.id);
    logger.info({ faqId, actor: actor.id }, 'FAQ live edit pending created');
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
