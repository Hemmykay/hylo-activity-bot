import { venueRepository } from '@/db/repositories/venue.repository.js';
import { pendingActionRepository } from '@/db/repositories/pending-action.repository.js';
import { createLogger } from '@/lib/logger.js';
import type { ActorInfo, VenueCreatePayload, VenueDraft } from './venue.types.js';

const logger = createLogger('venue-service');

class VenueService {
  async pendingCreate(draft: VenueDraft, actor: ActorInfo): Promise<string> {
    const payload: VenueCreatePayload = { draft, addedBy: actor.id };
    const pending = await pendingActionRepository.create({
      actorId: actor.id,
      actorName: actor.name,
      actionType: 'VENUE_CREATE',
      payload: payload as unknown as Parameters<typeof pendingActionRepository.create>[0]['payload'],
    });
    logger.debug({ pendingId: pending.id, venueName: draft.name }, 'Venue create pending');
    return pending.id;
  }

  async setPendingDiscordMsgId(pendingId: string, discordMsgId: string): Promise<void> {
    await pendingActionRepository.updateDiscordMsgId(pendingId, discordMsgId);
  }

  async executeConfirmed(pendingId: string, actor: ActorInfo): Promise<string> {
    const pending = await pendingActionRepository.findById(pendingId);
    if (!pending) throw new Error('Pending venue action not found or expired.');

    const { draft, addedBy } = pending.payload as unknown as VenueCreatePayload;

    const input: Parameters<typeof venueRepository.upsert>[0] = {
      name: draft.name,
      addedBy,
    };
    if (draft.description) input.description = draft.description;
    if (draft.context) input.context = draft.context;
    const venue = await venueRepository.upsert(input);

    await pendingActionRepository.deleteById(pendingId);
    logger.info({ venueName: venue.name, actorId: actor.id }, 'Venue created via confirmed pending');
    return venue.name;
  }

  async cancelPending(pendingId: string): Promise<void> {
    await pendingActionRepository.deleteById(pendingId);
  }
}

export const venueService = new VenueService();
