-- AlterTable
ALTER TABLE "mint_flow_events" ADD COLUMN "eventKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "mint_flow_events_eventKey_key" ON "mint_flow_events"("eventKey");
