-- CreateTable
CREATE TABLE "ModelProbe" (
    "key" TEXT NOT NULL,
    "claimed" INTEGER,
    "measured" INTEGER,
    "verdict" TEXT NOT NULL DEFAULT 'inconclusive',
    "note" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'panel-probe',
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProbe_pkey" PRIMARY KEY ("key")
);
