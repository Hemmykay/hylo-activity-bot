import type { ModalSubmitInteraction } from 'discord.js';
import { venueRepository, type CreateVenueInput } from '@/db/repositories/venue.repository.js';
import { assertAuthorizedInteraction, replyWithError } from '@/lib/discord-utils.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('venue-edit-modal');

export async function handleVenueEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    await assertAuthorizedInteraction(interaction);

    const [, encodedName] = interaction.customId.split(':') as [string, string];
    if (!encodedName) return;

    const name = decodeURIComponent(encodedName);

    const existing = await venueRepository.findByName(name);
    if (!existing) {
      await interaction.reply({ content: `Venue **${name}** no longer exists.`, ephemeral: true });
      return;
    }

    const descriptionRaw = interaction.fields.getTextInputValue('venue-description').trim();
    const contextRaw = interaction.fields.getTextInputValue('venue-context').trim();
    const linkRaw = interaction.fields.getTextInputValue('venue-link').trim();
    const disclaimerRaw = interaction.fields.getTextInputValue('venue-disclaimer').trim();

    const input: CreateVenueInput = { name, addedBy: interaction.user.id };
    if (descriptionRaw) input.description = descriptionRaw;
    if (contextRaw) input.context = contextRaw;
    if (linkRaw) input.link = linkRaw;
    if (disclaimerRaw) input.disclaimer = disclaimerRaw;

    const venue = await venueRepository.upsert(input);

    const extras = [
      contextRaw && `_XP context: ${contextRaw}_`,
      linkRaw && `_Link: ${linkRaw}_`,
      disclaimerRaw && `⚠ _${disclaimerRaw}_`,
    ].filter(Boolean).join('\n');

    await interaction.reply({
      content: `Venue **${venue.name}** updated.${extras ? `\n\n${extras}` : ''}\n\nUse \`/venue xp set\` to update XP rates for assets at this venue.`,
      ephemeral: true,
    });

    logger.info({ venueName: venue.name }, 'Venue updated via edit modal');
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
