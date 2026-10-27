-- CreateTable
CREATE TABLE "ModelHealthCheck" (
    "id" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "status" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "errorKind" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'scheduler',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelHealthCheck_modelKey_checkedAt_idx" ON "ModelHealthCheck"("modelKey", "checkedAt");

-- CreateIndex
CREATE INDEX "ModelHealthCheck_checkedAt_idx" ON "ModelHealthCheck"("checkedAt");
