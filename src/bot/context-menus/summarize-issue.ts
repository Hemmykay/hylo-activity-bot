import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildSummariseIssuePrompt } from '@/prompts/support.js';
import { assertAuthorizedInteraction, replyWithError, infoEmbed } from '@/lib/discord-utils.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Summarize Issue')
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

    const response = await aiService.generate(buildSummariseIssuePrompt({ customerMessage }));

    await interaction.editReply({
      embeds: [
        infoEmbed('Issue Summary', response.text).setFooter({
          text: `via ${response.provider}${response.usedFallback ? ' (fallback)' : ''}`,
        }),
      ],
    });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
