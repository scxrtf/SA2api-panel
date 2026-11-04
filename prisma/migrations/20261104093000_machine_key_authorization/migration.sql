-- 以面板浏览器机器码记录创建网关 Key 的授权；账号删除时级联撤销账号授权。
CREATE TABLE "MachineKeyAuthorization" (
    "machineId" TEXT NOT NULL,
    "uid" TEXT,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineKeyAuthorization_pkey" PRIMARY KEY ("machineId")
);

ALTER TABLE "MachineKeyAuthorization"
    ADD CONSTRAINT "MachineKeyAuthorization_uid_fkey"
    FOREIGN KEY ("uid") REFERENCES "Account"("uid")
    ON DELETE CASCADE ON UPDATE CASCADE;
