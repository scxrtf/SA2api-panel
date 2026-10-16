const fs = require("fs");
const path = require("path");
const files = {};

files["src/app/api/panel/travel_all/route.ts"] = String.raw`
import { panelAuth, ok } from "@/lib/panel-auth";
import { runTravelNow } from "@/lib/cron";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动触发全量旅行巡检（同步等待完成，返回动作计数；对齐 travelAll + RunTravelNow）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runTravelNow();
  return ok({ ...r });
}
`;

files["src/app/api/panel/activity_all/route.ts"] = String.raw`
import { panelAuth, ok } from "@/lib/panel-auth";
import { runActivityNow } from "@/lib/cron";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动触发全量活跃上报（同步等待完成；点亮连登 + 解锁领养前置；对齐 activityAll）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runActivityNow();
  return ok({ ...r });
}
`;

files["src/app/api/panel/keepalive_all/route.ts"] = String.raw`
import { panelAuth, ok } from "@/lib/panel-auth";
import { runKeepalive } from "@/lib/cron";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动触发全量 token 保活（同步等待完成；对齐 keepaliveAll）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runKeepalive();
  return ok({ ...r });
}
`;

files["src/app/api/panel/login/regions/route.ts"] = String.raw`
import { panelAuth, ok } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET global 注册可选地区（静态白名单，对齐 loginRegions；前端只读展示）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return ok({
    regions: [
      { code: "HK", name: "Hong Kong" },
      { code: "MO", name: "Macao" },
      { code: "SG", name: "Singapore" },
      { code: "TH", name: "Thailand" },
      { code: "PH", name: "Philippines" },
      { code: "MY", name: "Malaysia" },
      { code: "ID", name: "Indonesia" },
    ],
  });
}
`;

files["src/app/api/panel/usage/save/route.ts"] = String.raw`
import { panelAuth, ok } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST 立即把内存中的用量桶落盘（对齐 usageSave）。
// Next.js 版用量直接写库（UsageEvent），无内存桶概念——返回 ok 作兼容占位。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return ok();
}
`;

files["src/app/api/panel/school/vouchers/route.ts"] = String.raw`
import { panelAuth, ok } from "@/lib/panel-auth";
import { getConfig } from "@/lib/config";
import { listActiveAccounts } from "@/lib/taskcenter";
import { schoolVouchers, type SchoolVoucher } from "@/lib/upstream/tasks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET 我的券码：逐 CN 账号查开学季 /vouchers（并发拉取，失败只标 error）。
// global 账号无开学季，不发上游调用（对齐 schoolVouchers）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cfg = await getConfig();
  const rows = await listActiveAccounts();
  type Row = { uid: string; nickname: string; vouchers: SchoolVoucher[]; error?: string };
  const out = await Promise.all(rows.map(async (row): Promise<Row | null> => {
    if (row.disabled) return null;
    const it: Row = { uid: row.uid, nickname: row.nickname, vouchers: [] };
    if (row.realm === "global") {
      it.error = "global realm（无开学季活动）";
      return it;
    }
    try {
      it.vouchers = await schoolVouchers(cfg, row.auth);
    } catch (e) {
      it.error = e instanceof Error ? e.message : String(e);
    }
    return it;
  }));
  return ok({ accounts: out.filter((r): r is Row => r != null) });
}
`;

files["src/app/api/panel/providers/probe/route.ts"] = String.raw`
import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST 用「尚未创建」的 base_url + key 探测上游模型列表（对齐 providerProbe）。
// key 原文只在本次请求生命周期内用于上游请求，不落盘、不回显、不写日志。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { base_url?: string; key?: string };
  try { body = await req.json(); } catch { return fail(400, "invalid json body"); }
  const baseUrl = (body.base_url ?? "").trim().replace(/\/+$/, "");
  const key = (body.key ?? "").trim();
  if (!baseUrl || !key) return fail(400, "base_url / key 均不能为空");
  try {
    const headers: Record<string, string> = {};
    if (key) headers["Authorization"] = "Bearer " + key;
    const resp = await fetch(baseUrl + "/v1/models", {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const raw = await resp.text();
      return fail(502, "upstream http " + resp.status + ": " + raw.slice(0, 200));
    }
    const data = (await resp.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
    return ok({ models });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : "probe failed");
  }
}
`;

for (const [p, c] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c.trimStart(), "utf8");
  console.log("written", p);
}
