import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildFAQExtractPrompt } from '@/prompts/faq.js';
import { faqService } from '@/services/faq/faq.service.js';
import { assertAuthorizedInteraction, replyWithError, buildConfirmationRow, COLORS, truncate } from '@/lib/discord-utils.js';
import type { FAQDraftInput } from '@/services/faq/faq.types.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Create FAQ')
  .setType(ApplicationCommandType.Message);

export async function execute(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const rawInput = interaction.targetMessage.content;

    if (!rawInput.trim()) {
      await interaction.editReply({ content: 'That message has no text content.' });
      return;
    }

    const aiResponse = await aiService.generate(buildFAQExtractPrompt(rawInput));

    let draft: FAQDraftInput;
    try {
      const cleaned = aiResponse.text.trim()
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '');
      draft = JSON.parse(cleaned) as FAQDraftInput;
    } catch {
      await interaction.editReply({ content: 'Could not parse the FAQ structure. Try again or use a clearer Q&A format.' });
      return;
    }

    const actor = { id: interaction.user.id, name: interaction.user.displayName };
    const channelId = interaction.channelId;
    const pendingId = await faqService.pendingCreate(draft, actor, channelId);

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📝 New FAQ Draft')
      .addFields(
        { name: 'Title', value: draft.title, inline: false },
        { name: 'Category', value: draft.category, inline: true },
        { name: 'Tags', value: draft.tags.join(', ') || 'none', inline: true },
        { name: 'Question', value: draft.question, inline: false },
        { name: 'Answer', value: truncate(draft.answer, 900), inline: false },
      )
      .setFooter({ text: 'Review and confirm to save to the knowledge base' })
      .setTimestamp();

    const reply = await interaction.editReply({
      content: 'I believe you\'re adding a new FAQ. Here\'s what I extracted — would you like to save this?',
      embeds: [embed],
      components: [buildConfirmationRow(pendingId)],
    });

    await faqService.setPendingDiscordMsgId(pendingId, reply.id);
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
