const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const rows = await p.requestLog.findMany({
    where: {
      OR: [
        { errKind: { equals: "unknown", mode: "insensitive" } },
        { errMsg: { equals: "unknown", mode: "insensitive" } },
      ],
    },
    orderBy: { at: "desc" },
    take: 20,
    select: {
      id: true,
      at: true,
      status: true,
      errKind: true,
      errMsg: true,
      model: true,
      uid: true,
      path: true,
    },
  });
  console.log("REQUEST_LOGS", JSON.stringify(rows, null, 1));

  const accts = await p.accountState.findMany({
    where: {
      OR: [
        { cooldownReason: { contains: "unknown", mode: "insensitive" } },
        { disableReason: { contains: "unknown", mode: "insensitive" } },
      ],
    },
    select: {
      uid: true,
      disabled: true,
      disableReason: true,
      cooldownReason: true,
      cooldownUntil: true,
    },
  });
  console.log("ACCOUNTS", JSON.stringify(accts, null, 1));

  const all = await p.account.findMany({
    select: {
      uid: true,
      nickname: true,
      realm: true,
      createdAt: true,
      state: {
        select: {
          credits: true,
          paused: true,
          disabled: true,
          disableReason: true,
          cooldownReason: true,
          cooldownUntil: true,
          breakerUntil: true,
          sessionDead: true,
          lastUsed: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log(
    "ALL_ACCOUNTS",
    JSON.stringify(
      all,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      1
    )
  );
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
