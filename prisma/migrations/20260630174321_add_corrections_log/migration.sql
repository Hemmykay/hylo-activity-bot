-- CreateTable
CREATE TABLE "corrections" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "originalQuestion" TEXT NOT NULL,
    "wrongBotAnswer" TEXT NOT NULL,
    "rawCorrection" TEXT NOT NULL,
    "structured" BOOLEAN NOT NULL DEFAULT false,
    "faqAction" TEXT,
    "faqTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "corrections_structured_idx" ON "corrections"("structured");

-- CreateIndex
CREATE INDEX "corrections_actorId_idx" ON "corrections"("actorId");

-- CreateIndex
CREATE INDEX "corrections_createdAt_idx" ON "corrections"("createdAt");
