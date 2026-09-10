import type { Asset, Venue, VenueAssetXP } from '@prisma/client';
import { prisma } from '../prisma.js';

/** Display DTO — same shape the old Venue.assets JSON entries used. */
export interface VenueAsset {
  asset: string;
  xpRate: string;
  notes?: string;
}

export type UpsertVenueAssetXPInput = {
  venueId: string;
  assetId: string;
  xpRate: string;
  notes?: string | null | undefined;
};

export const venueAssetXPRepository = {
  async upsert(data: UpsertVenueAssetXPInput): Promise<VenueAssetXP> {
    return prisma.venueAssetXP.upsert({
      where: { venueId_assetId: { venueId: data.venueId, assetId: data.assetId } },
      create: {
        venueId: data.venueId,
        assetId: data.assetId,
        xpRate: data.xpRate,
        notes: data.notes ?? null,
      },
      update: {
        xpRate: data.xpRate,
        notes: data.notes ?? null,
      },
    });
  },

  async remove(venueId: string, assetId: string): Promise<VenueAssetXP | null> {
    try {
      return await prisma.venueAssetXP.delete({
        where: { venueId_assetId: { venueId, assetId } },
      });
    } catch {
      return null;
    }
  },

  // Filters out links to a soft-deleted asset on the other side — matches the
  // active-only-by-default convention every other list view in this codebase uses.
  async findByVenue(venueId: string): Promise<Array<VenueAssetXP & { asset: Asset }>> {
    return prisma.venueAssetXP.findMany({
      where: { venueId, asset: { isActive: true } },
      include: { asset: true },
      orderBy: { asset: { symbol: 'asc' } },
    });
  },

  async findByAsset(assetId: string): Promise<Array<VenueAssetXP & { venue: Venue }>> {
    return prisma.venueAssetXP.findMany({
      where: { assetId, venue: { isActive: true } },
      include: { venue: true },
      orderBy: { venue: { name: 'asc' } },
    });
  },
};

/** Maps joined rows to the display DTO used by prompt-building and embeds. */
export function toVenueAssetView(rows: Array<VenueAssetXP & { asset: Asset }>): VenueAsset[] {
  return rows.map((r) => ({
    asset: r.asset.symbol,
    xpRate: r.xpRate,
    ...(r.notes ? { notes: r.notes } : {}),
  }));
}
