import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildRewritePrompt } from '@/prompts/rewrite.js';
import { assertAuthorizedInteraction, replyWithError, successEmbed } from '@/lib/discord-utils.js';

export const data = new SlashCommandBuilder()
  .setName('rewrite')
  .setDescription('Rewrite a message naturally')
  .addStringOption((opt) =>
    opt.setName('text').setDescription('The message to rewrite').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const text = interaction.options.getString('text', true);
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
