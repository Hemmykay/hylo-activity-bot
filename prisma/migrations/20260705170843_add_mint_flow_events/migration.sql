-- CreateEnum
CREATE TYPE "FlowKind" AS ENUM ('MINT', 'BURN');

-- CreateTable
CREATE TABLE "mint_flow_events" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "kind" "FlowKind" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mint_flow_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mint_flow_events_symbol_idx" ON "mint_flow_events"("symbol");
