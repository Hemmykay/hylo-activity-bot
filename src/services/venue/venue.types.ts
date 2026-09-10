import type { ActorInfo } from '@/services/faq/faq.types.js';

export type { ActorInfo };

export interface VenueDraft {
  name: string;
  description: string;
  /** How/why XP is calculated — e.g. "XP is based on the combined LP position value, not just one asset." */
  context?: string;
  assets: Array<{ asset: string; xpRate: string; notes?: string }>;
}

export interface VenueCreatePayload {
  draft: VenueDraft;
  addedBy: string;
}
