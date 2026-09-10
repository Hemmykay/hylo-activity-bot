-- CreateEnum
CREATE TYPE "StabilityPoolEventType" AS ENUM ('OFFLOAD', 'DEPLOYMENT');

-- CreateTable
CREATE TABLE "stability_pool_events" (
    "id" TEXT NOT NULL,
    "type" "StabilityPoolEventType" NOT NULL,
    "signature" TEXT NOT NULL,
    "blockTime" INTEGER,
    "xSOLAmount" DOUBLE PRECISION NOT NULL,
    "hyUSDAmount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stability_pool_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stability_pool_events_signature_key" ON "stability_pool_events"("signature");

-- CreateIndex
CREATE INDEX "stability_pool_events_type_createdAt_idx" ON "stability_pool_events"("type", "createdAt");
