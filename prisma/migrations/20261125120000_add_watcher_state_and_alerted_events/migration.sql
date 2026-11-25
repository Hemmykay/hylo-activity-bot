-- CreateTable
CREATE TABLE "watcher_state" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watcher_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "alerted_events" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerted_events_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "alerted_events_createdAt_idx" ON "alerted_events"("createdAt");
