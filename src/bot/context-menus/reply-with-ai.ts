import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { ragService } from '@/services/rag/rag.service.js';
import { assertAuthorizedInteraction, replyWithError, truncate } from '@/lib/discord-utils.js';
import { config } from '@/config/index.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Reply with AI')
  .setType(ApplicationCommandType.Message);

export async function execute(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const customerMessage = interaction.targetMessage.content;

    if (!customerMessage.trim()) {
      await interaction.editReply({ content: 'That message has no text content.' });
      return;
    }

    const result = await ragService.answer(customerMessage, interaction.user.id);
    const belowThreshold = result.confidence < config.app.faqConfidenceThreshold * 100;

    const embed = new EmbedBuilder()
      .setColor(belowThreshold ? 0xf59e0b : 0x22c55e)
      .setTitle('Suggested Reply')
      .setDescription(result.suggestedReply)
      .addFields(
        { name: 'Confidence', value: `${result.confidence}%`, inline: true },
        { name: 'Provider', value: `${result.provider}${result.usedFallback ? ' ⚡' : ''}`, inline: true },
        { name: 'Reasoning', value: truncate(result.reasoning, 400), inline: false },
      )
      .setTimestamp();

    if (result.matchedFAQTitles.length > 0) {
      embed.addFields({
        name: 'Matched FAQs',
        value: result.matchedFAQTitles.map((t) => `• ${t}`).join('\n'),
        inline: false,
      });
    }

    if (belowThreshold) {
      embed.setFooter({ text: '⚠ Low confidence — verify before sending' });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
