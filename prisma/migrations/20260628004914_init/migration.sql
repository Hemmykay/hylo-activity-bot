-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('FAQ_CREATE', 'FAQ_UPDATE', 'FAQ_DELETE');

-- CreateTable
CREATE TABLE "faqs" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "keywords" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "faq_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_actions" (
    "id" TEXT NOT NULL,
    "discordMsgId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "ActionType" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_logs" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "topScore" DOUBLE PRECISION,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "faqs_category_idx" ON "faqs"("category");

-- CreateIndex
CREATE INDEX "faqs_isActive_idx" ON "faqs"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "faq_categories_name_key" ON "faq_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pending_actions_discordMsgId_key" ON "pending_actions"("discordMsgId");

-- CreateIndex
CREATE INDEX "pending_actions_actorId_idx" ON "pending_actions"("actorId");

-- CreateIndex
CREATE INDEX "pending_actions_expiresAt_idx" ON "pending_actions"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "search_logs_actorId_idx" ON "search_logs"("actorId");
