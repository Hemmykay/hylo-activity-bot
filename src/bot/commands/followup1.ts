import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildFollowup1Prompt } from '@/prompts/followup1.js';
import { assertAuthorizedInteraction, replyWithError } from '@/lib/discord-utils.js';

export const data = new SlashCommandBuilder()
  .setName('followup1')
  .setDescription('Generate a first follow-up message')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('Discord user to mention (optional)').setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const mention = interaction.options.getUser('user')?.toString();
    const response = await aiService.generate(buildFollowup1Prompt({ mention }));

    await interaction.editReply({
      content: `\`\`\`\n${response.text}\n\`\`\`\n-# via ${response.provider}${response.usedFallback ? ' (fallback)' : ''}`,
    });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
