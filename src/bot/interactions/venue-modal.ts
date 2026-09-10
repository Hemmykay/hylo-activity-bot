import type { ModalSubmitInteraction } from 'discord.js';
import { venueRepository, type CreateVenueInput } from '@/db/repositories/venue.repository.js';
import { assertAuthorizedInteraction, replyWithError } from '@/lib/discord-utils.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('venue-modal');

export async function handleVenueAddModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    await assertAuthorizedInteraction(interaction);

    const name = interaction.fields.getTextInputValue('venue-name').trim();
    const descriptionRaw = interaction.fields.getTextInputValue('venue-description').trim();
    const contextRaw = interaction.fields.getTextInputValue('venue-context').trim();
    const linkRaw = interaction.fields.getTextInputValue('venue-link').trim();

    const input: CreateVenueInput = { name, addedBy: interaction.user.id };
    if (descriptionRaw) input.description = descriptionRaw;
    if (contextRaw) input.context = contextRaw;
    if (linkRaw) input.link = linkRaw;

    const venue = await venueRepository.upsert(input);

    const extras = [
      contextRaw && `_XP context: ${contextRaw}_`,
      linkRaw && `_Link: ${linkRaw}_`,
    ].filter(Boolean).join('\n');

    await interaction.reply({
      content: `Venue **${venue.name}** saved.${extras ? `\n\n${extras}` : ''}\n\nUse \`/venue xp set\` to add XP rates for assets at this venue.`,
      ephemeral: true,
    });

    logger.info({ venueName: venue.name }, 'Venue saved via modal');
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
