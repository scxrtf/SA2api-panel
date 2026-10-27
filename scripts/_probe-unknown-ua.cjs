// 临时只读诊断：找请求日志表里会被渲染成 "unknown" 的 UA / 字段值。
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

function uaSummary(ua) {
  const s = ua || "";
  if (!s) return "";
  const m = [
    [/Claude\/?(\d[\w.]*)/i, "Claude $1"], [/Claude-Code\/([\w.]+)/i, "Claude Code $1"],
    [/Codex(?:CLI)?[\/ ]([\w.]+)/i, "Codex $1"], [/CherryStudio\/([\w.]+)/i, "Cherry Studio $1"],
    [/Cline\/([\w.]+)/i, "Cline $1"], [/OpenAI\/(\w+[\w.]*)/i, "OpenAI $1"],
    [/python-requests\/([\w.]+)/i, "Python requests $1"], [/Python\/([\w.]+)/i, "Python $1"],
    [/node(?:-fetch)?\/([\w.]+)/i, "Node $1"], [/curl\/([\w.]+)/i, "curl $1"],
    [/PostmanRuntime\/([\w.]+)/i, "Postman $1"], [/Go-http-client\/([\w.]+)/i, "Go $1"],
    [/Mozilla\/[\d.]+\s*\(([^)]+)\)/, null],
  ];
  for (const [re, tpl] of m) {
    const x = s.match(re);
    if (x) return tpl === null ? x[1].split(/[;)]/)[0].trim() : tpl.replace("$1", x[1]);
  }
  return s.split(/[\s;,]/)[0].slice(0, 18);
}

(async () => {
  const uas = await p.requestLog.findMany({
    select: { ua: true },
    distinct: ["ua"],
    take: 2000,
  });
  const hits = uas
    .map((r) => ({ ua: r.ua, summary: uaSummary(r.ua) }))
    .filter((r) => /unknown/i.test(r.summary));
  console.log("UA_SUMMARY_UNKNOWN", JSON.stringify(hits, null, 1));

  const rawUnknown = await p.requestLog.count({
    where: { ua: { contains: "unknown", mode: "insensitive" } },
  });
  console.log("UA_RAW_CONTAINS_UNKNOWN", rawUnknown);

  const fields = ["model", "realm", "provider", "slot", "keyName", "path", "uid", "machineId", "errMsg", "errKind"];
  for (const col of fields) {
    const rows = await p.requestLog.findMany({
      where: { [col]: { equals: "unknown", mode: "insensitive" } },
      select: { id: true, at: true, [col]: true },
      take: 5,
    });
    if (rows.length) console.log("EQUALS_UNKNOWN", col, JSON.stringify(rows));
  }
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
