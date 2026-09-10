-- Drop the deprecated free-text Venue.assets JSON column.
-- Data already migrated to VenueAssetXP via prisma/backfill-venue-asset-xp.ts
-- and verified (Exponent, Kamino, Loopscale all confirmed migrated).

-- AlterTable
ALTER TABLE "venues" DROP COLUMN "assets";
