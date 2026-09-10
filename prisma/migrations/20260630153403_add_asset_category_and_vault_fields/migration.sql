-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('LST', 'STABLECOIN', 'LEVER_TOKEN', 'YIELD_BEARING_TOKEN');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "category" "AssetCategory",
ADD COLUMN     "collateralWallet" TEXT,
ADD COLUMN     "stakeVault" TEXT;
