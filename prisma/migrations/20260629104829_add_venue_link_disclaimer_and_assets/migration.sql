-- AlterTable
ALTER TABLE "venues" ADD COLUMN     "disclaimer" TEXT,
ADD COLUMN     "link" TEXT;

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "considerations" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_symbol_key" ON "assets"("symbol");

-- CreateIndex
CREATE INDEX "assets_isActive_idx" ON "assets"("isActive");
