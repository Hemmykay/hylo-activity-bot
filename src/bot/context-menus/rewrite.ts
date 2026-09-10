import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildRewritePrompt } from '@/prompts/rewrite.js';
import { assertAuthorizedInteraction, replyWithError, successEmbed } from '@/lib/discord-utils.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Rewrite')
  .setType(ApplicationCommandType.Message);

export async function execute(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const text = interaction.targetMessage.content;

    if (!text.trim()) {
      await interaction.editReply({ content: 'That message has no text content to rewrite.' });
      return;
    }

    const response = await aiService.generate(buildRewritePrompt({ text }));

    await interaction.editReply({
      embeds: [
        successEmbed('Rewritten', response.text).setFooter({
          text: `via ${response.provider}${response.usedFallback ? ' (fallback)' : ''}`,
        }),
      ],
    });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
