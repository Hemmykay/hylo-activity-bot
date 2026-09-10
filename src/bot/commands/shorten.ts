import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildShortenPrompt } from '@/prompts/shorten.js';
import { assertAuthorizedInteraction, replyWithError, successEmbed } from '@/lib/discord-utils.js';

export const data = new SlashCommandBuilder()
  .setName('shorten')
  .setDescription('Remove unnecessary words from a message')
  .addStringOption((opt) =>
    opt.setName('text').setDescription('The message to shorten').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const text = interaction.options.getString('text', true);
    const response = await aiService.generate(buildShortenPrompt({ text }));

    await interaction.editReply({
      embeds: [
        successEmbed('Shortened', response.text).setFooter({
          text: `via ${response.provider}${response.usedFallback ? ' (fallback)' : ''}`,
        }),
      ],
    });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
