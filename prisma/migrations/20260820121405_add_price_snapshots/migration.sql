-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_snapshots_symbol_capturedAt_idx" ON "price_snapshots"("symbol", "capturedAt");
