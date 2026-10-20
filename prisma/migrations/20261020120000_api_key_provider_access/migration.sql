-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "providers" TEXT NOT NULL DEFAULT '';

-- 既有密钥保持原有可用性（可调用全部供应商）；新建密钥默认未授权任何供应商。
UPDATE "ApiKey" SET "providers" = '*' WHERE "providers" = '';
