import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildTonePrompt } from '@/prompts/tone.js';
import { assertAuthorizedInteraction, replyWithError, successEmbed } from '@/lib/discord-utils.js';

export const data = new SlashCommandBuilder()
  .setName('customer-support')
  .setDescription('Rewrite a message in polished customer support style')
  .addStringOption((opt) =>
    opt.setName('text').setDescription('The message to rewrite').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const text = interaction.options.getString('text', true);
    const response = await aiService.generate(
      buildTonePrompt({ text, direction: 'customer support' }),
    );

    await interaction.editReply({
      embeds: [
        successEmbed('Customer Support Style', response.text).setFooter({
          text: `via ${response.provider}${response.usedFallback ? ' (fallback)' : ''}`,
        }),
      ],
    });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
