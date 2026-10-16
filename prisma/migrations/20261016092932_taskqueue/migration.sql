-- CreateTable
CREATE TABLE "TaskQueueItem" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "taskCode" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "mp" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskQueueItem_status_createdAt_idx" ON "TaskQueueItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TaskQueueItem_uid_idx" ON "TaskQueueItem"("uid");
