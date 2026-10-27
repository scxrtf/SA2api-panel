-- AlterTable
ALTER TABLE "RequestLog"
ADD COLUMN     "requestMessages" JSONB,
ADD COLUMN     "responseMessage" JSONB,
ADD COLUMN     "errorDetail" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "parameterOverrides" JSONB,
ADD COLUMN     "attemptDetails" JSONB;
