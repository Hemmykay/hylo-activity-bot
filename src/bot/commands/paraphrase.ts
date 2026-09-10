import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildParaphrasePrompt } from '@/prompts/paraphrase.js';
import { assertAuthorizedInteraction, replyWithError, successEmbed } from '@/lib/discord-utils.js';

export const data = new SlashCommandBuilder()
  .setName('paraphrase')
  .setDescription('Generate an alternative version of a message')
  .addStringOption((opt) =>
    opt.setName('text').setDescription('The message to paraphrase').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const text = interaction.options.getString('text', true);
    const response = await aiService.generate(buildParaphrasePrompt({ text }));

    await interaction.editReply({
      embeds: [
        successEmbed('Paraphrased', response.text).setFooter({
          text: `via ${response.provider}${response.usedFallback ? ' (fallback)' : ''}`,
        }),
      ],
    });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
