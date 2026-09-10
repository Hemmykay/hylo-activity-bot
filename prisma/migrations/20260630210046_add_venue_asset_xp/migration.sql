-- CreateTable
CREATE TABLE "venue_asset_xp" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "xpRate" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_asset_xp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "venue_asset_xp_assetId_idx" ON "venue_asset_xp"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "venue_asset_xp_venueId_assetId_key" ON "venue_asset_xp"("venueId", "assetId");

-- AddForeignKey
ALTER TABLE "venue_asset_xp" ADD CONSTRAINT "venue_asset_xp_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_asset_xp" ADD CONSTRAINT "venue_asset_xp_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
