-- CreateTable
CREATE TABLE "mint_watcher_state" (
    "id" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "lastSignature" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mint_watcher_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mint_watcher_state_assetSymbol_key" ON "mint_watcher_state"("assetSymbol");
