import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  type MessageContextMenuCommandInteraction,
} from 'discord.js';
import { searchService } from '@/services/search/search.service.js';
import { assertAuthorizedInteraction, replyWithError, COLORS, truncate } from '@/lib/discord-utils.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Find Matching FAQ')
  .setType(ApplicationCommandType.Message);

export async function execute(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply({ ephemeral: true });

  try {
    const query = interaction.targetMessage.content;

    if (!query.trim()) {
      await interaction.editReply({ content: 'That message has no text content.' });
      return;
    }

    const results = await searchService.search(query, interaction.user.id, 5);

    if (results.length === 0) {
      await interaction.editReply({ content: 'No matching FAQs found for this message.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('Matching FAQs')
      .setDescription(`Found **${results.length}** match${results.length === 1 ? '' : 'es'}`)
      .setTimestamp();

    for (const r of results) {
      embed.addFields({
        name: `${r.title} · [${r.category}] · ${r.score.toFixed(3)}`,
        value: truncate(r.answer.replace(/#{1,6}\s/g, '').replace(/\*\*/g, ''), 280),
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
