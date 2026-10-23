-- ModelHealthCheck：记录真实最小聊天请求的输出 token 与生成吞吐。
ALTER TABLE "ModelHealthCheck"
ADD COLUMN "completionTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tokensPerSecond" DOUBLE PRECISION NOT NULL DEFAULT 0;
