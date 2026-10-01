-- CreateTable
CREATE TABLE "ReviewPrompt" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "raterType" TEXT NOT NULL,
    "raterId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "actionRef" TEXT,
    "counterpartyName" TEXT,
    "discloseAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "raterType" TEXT NOT NULL,
    "raterId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "discloseAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSampling" (
    "id" TEXT NOT NULL,
    "participantType" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "actionsSinceRequest" INTEGER NOT NULL DEFAULT 0,
    "lastRequestedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSampling_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewPrompt_raterType_raterId_submittedAt_idx" ON "ReviewPrompt"("raterType", "raterId", "submittedAt");

-- CreateIndex
CREATE INDEX "ReviewPrompt_subjectType_subjectId_idx" ON "ReviewPrompt"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewPrompt_actionType_actionId_raterType_raterId_key" ON "ReviewPrompt"("actionType", "actionId", "raterType", "raterId");

-- CreateIndex
CREATE INDEX "Review_subjectType_subjectId_idx" ON "Review"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Review_actionId_idx" ON "Review"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_actionType_actionId_raterType_raterId_key" ON "Review"("actionType", "actionId", "raterType", "raterId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSampling_participantType_participantId_key" ON "ReviewSampling"("participantType", "participantId");

