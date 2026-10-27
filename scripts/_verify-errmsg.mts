// _verify-errmsg.mts — 报错内容（RequestLog.errMsg / 运行日志 err=）修复验证。
// 第一段：clipLogText 归一行为（离线）；第二段：真实请求打网关后查库（需 dev 服务）。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2];
}
const url = (p: string) => new URL("file:///" + path.join(root, p).replace(/\\/g, "/")).href;
const { clipLogText } = await import(url("src/lib/logfmt.ts"));
const { prisma } = await import(url("src/lib/db.ts"));

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log("  PASS", name, detail); }
  else { fail++; console.log("  FAIL", name, detail); }
};

console.log("\n[1] clipLogText 归一");
{
  const html = `<html> <head><title>401 Authorization Required</title></head>\n<body> <center><h1>401</h1></center> <hr><center>openresty</center></body></html>`;
  const a = clipLogText(html);
  console.log("  HTML →", a);
  check("HTML 去标签", !/[<>]/.test(a));
  check("HTML 压成单行", !/\n/.test(a));
  check("保留可读语义", /401/.test(a));

  const json = '{"code":12153,\n  "msg":"refresh token is invalid"}';
  const b = clipLogText(json);
  console.log("  JSON →", b);
  check("JSON 不剥内容", b.includes("12153") && b.includes("refresh token"));

  const long = "x".repeat(5000);
  const c = clipLogText(long, 1000);
  check("超长截断到上限", c.length === 1000 && c.endsWith("…"), "len=" + c.length);

  check("空值安全", clipLogText("") === "" && clipLogText(undefined as unknown as string) === "");
}

console.log("\n[2] 真实失败请求落库（网关 :3100）");
{
  // 取一把有全供应商授权的网关 key（不硬编码凭据）。
  const keyRow = await prisma.apiKey.findFirst({ where: { providers: "*" }, orderBy: { createdAt: "asc" } });
  const auth: Record<string, string> = keyRow ? { Authorization: "Bearer " + keyRow.key } : {};
  console.log("  使用 key:", keyRow?.name ?? "（无鉴权）");
  const before = await prisma.requestLog.count();
  let status = 0, body = "";
  try {
    const r = await fetch("http://127.0.0.1:3100/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        model: "definitely-not-a-model-xyz",
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
    });
    status = r.status;
    body = (await r.text()).slice(0, 160);
  } catch (e) {
    console.log("  请求异常（dev 未启动？）:", e instanceof Error ? e.message : String(e));
  }
  console.log("  HTTP", status, "|", body.replace(/\s+/g, " "));
  check("请求被拒绝（非 2xx）", status >= 400, "status=" + status);

  const rows = await prisma.requestLog.findMany({ orderBy: { at: "desc" }, take: 3 });
  const after = await prisma.requestLog.count();
  console.log("  RequestLog 行数:", before, "→", after);
  const row = rows[0];
  if (row) {
    console.log("  最新行:", JSON.stringify({
      status: row.status, errKind: row.errKind, model: row.model,
      uid: row.uid.slice(0, 8), errMsg: row.errMsg.slice(0, 120),
    }));
  }
  check("新增了请求日志", after > before);
  check("失败行带报错内容", !!row && row.errMsg.length > 0, "errMsg len=" + (row?.errMsg.length ?? 0));
  check("报错内容为单行", !!row && !/[\r\n]/.test(row.errMsg));
}

await prisma.$disconnect();
console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
