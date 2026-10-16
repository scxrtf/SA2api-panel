const fs = require("fs");
const path = require("path");

const head = `import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { authShapeOf } from "@/lib/login";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ uid: string }> };
// loadAuth 取账号凭证；不存在时写 404 并返回 null（对齐 accountByUID）。
async function loadAuth(uid: string) {
  const row = await prisma.account.findUnique({ where: { uid } });
  if (!row) return null;
  return authShapeOf(row);
}
`;

const files = {};

// GET /accounts/[uid]/tasks
files["src/app/api/panel/accounts/[uid]/tasks/route.ts"] = head + `
import { mergedTaskList } from "@/lib/taskcenter";

// GET 查询单账号全量任务（默认口径 + mp 口径合并去重）。
export async function GET(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  try {
    const tasks = await mergedTaskList(await getConfig(), a);
    return ok({ tasks });
  } catch (e) {
    return fail(502, "list tasks: " + (e instanceof Error ? e.message : String(e)));
  }
}
`;

// POST /accounts/[uid]/tasks/accept
files["src/app/api/panel/accounts/[uid]/tasks/accept/route.ts"] = head + `
import { acceptTasks } from "@/lib/upstream/tasks";

// POST 接受任务（报名；幂等）。body: {task_codes: [...]}。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  let body: { task_codes?: string[] };
  try { body = await req.json(); } catch { return fail(400, "task_codes required"); }
  if (!body.task_codes || body.task_codes.length === 0) return fail(400, "task_codes required");
  try {
    await acceptTasks(await getConfig(), a, body.task_codes);
    return ok();
  } catch (e) {
    return fail(502, "accept: " + (e instanceof Error ? e.message : String(e)));
  }
}
`;

// POST /accounts/[uid]/tasks/accept_all
files["src/app/api/panel/accounts/[uid]/tasks/accept_all/route.ts"] = head + `
import { taskAcceptAll } from "@/lib/taskcenter";

// POST 接受该账号全部尚未接受的任务（分片 20/批节流；mp 码单独 mp 口径）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  try {
    const r = await taskAcceptAll(await getConfig(), a);
    const resp: Record<string, unknown> = { accepted: r.accepted, failed: r.failed };
    if (r.accepted === 0 && r.failed.length === 0) {
      return ok({ accepted: 0, message: "所有任务均已接受" });
    }
    if (r.failed.length > 0) resp["message"] = "部分任务接受失败（上游拒绝），可重试";
    return ok(resp);
  } catch (e) {
    return fail(502, "list tasks: " + (e instanceof Error ? e.message : String(e)));
  }
}
`;

// POST /accounts/[uid]/tasks/claim
files["src/app/api/panel/accounts/[uid]/tasks/claim/route.ts"] = head + `
import { claimTaskReward } from "@/lib/taskcenter";

// POST 领取任务奖励（未达标时上游业务错误原样透出；mp 码走 mp 口径）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  let body: { task_code?: string };
  try { body = await req.json(); } catch { return fail(400, "task_code required"); }
  if (!body.task_code) return fail(400, "task_code required");
  try {
    const r = await claimTaskReward(await getConfig(), a, body.task_code);
    if (r.credit === 0 && r.energy === 0) {
      return ok({ already_claimed: true, message: "该奖励此前已领取" });
    }
    return ok({ credit: r.credit, energy: r.energy });
  } catch (e) {
    return fail(502, "claim: " + (e instanceof Error ? e.message : String(e)));
  }
}
`;

// POST /accounts/[uid]/tasks/auto — 一键完成单个任务
files["src/app/api/panel/accounts/[uid]/tasks/auto/route.ts"] = head + `
import {
  autoActionFor, isMPTaskCode, taskByCode, taskByCodeMP, taskByCodeWaiting, taskProgressText,
} from "@/lib/autotask";
import { tryLockAccount, unlockAccount, claimTaskReward } from "@/lib/taskcenter";

// POST 一键完成单个任务：执行动作 → 回读 → 达标自动领奖（对齐 accountTaskAuto）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  let body: { task_code?: string };
  try { body = await req.json(); } catch { return fail(400, "task_code required"); }
  if (!body.task_code) return fail(400, "task_code required");
  const act = autoActionFor(body.task_code);
  if (!act) {
    return fail(501, "该任务需要客户端内交互（无对应接口），无法自动完成；请按任务说明在官方客户端操作");
  }
  // per-account 互斥：同账号任务动作在跑时 409。
  if (!tryLockAccount(uid)) {
    return fail(409, "该账号有任务动作正在执行中，请等本轮结束后再试");
  }
  try {
    const cfg = await getConfig();
    const before = await taskByCode(cfg, a, act.taskCode);
    if (before == null) return fail(404, "该账号没有此任务");
    if (before.claimed) {
      return ok({ skipped: true, message: "该任务已领取过奖励" });
    }
    const mp = isMPTaskCode(act.taskCode);
    let msg: string;
    try {
      msg = await act.run(cfg, a);
    } catch (e) {
      return fail(502, "执行失败: " + (e instanceof Error ? e.message : String(e)));
    }
    const after = mp ? await taskByCodeMP(cfg, a, act.taskCode).catch(() => null)
      : await taskByCodeWaiting(cfg, a, act.taskCode).catch(() => null);
    const resp: Record<string, unknown> = {
      message: msg,
      progress_before: taskProgressText(before),
      progress_after: after ? taskProgressText(after) : "",
      claimable: after?.claimable ?? false,
      attempt: act.attempt,
      verify_supported: true,
    };
    if (after?.claimable) {
      try {
        const r = await claimTaskReward(cfg, a, act.taskCode);
        resp["claimed"] = true;
        resp["credit"] = r.credit;
        resp["energy"] = r.energy;
        resp["message"] = (r.credit > 0 || r.energy > 0)
          ? msg + "；已自动领奖 +" + r.credit + " 分 +" + r.energy + " 能"
          : msg + "；奖励此前已领取";
      } catch (e) {
        resp["claim_error"] = e instanceof Error ? e.message : String(e);
        resp["message"] = msg + "；达标但领奖失败，可在任务列表手动点「领取」重试";
      }
    }
    return ok(resp);
  } finally {
    unlockAccount(uid);
  }
}
`;

// POST /accounts/[uid]/tasks/auto_all — 一键完成全部可自动任务
files["src/app/api/panel/accounts/[uid]/tasks/auto_all/route.ts"] = head + `
import { runAutoAll } from "@/lib/autotask";
import { tryLockAccount, unlockAccount } from "@/lib/taskcenter";

// POST 一键完成该账号全部可自动任务（逐项执行，单项失败不阻塞）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  if (!tryLockAccount(uid)) {
    return fail(409, "该账号有任务动作正在执行中，请等本轮结束后再试");
  }
  try {
    const results = await runAutoAll(await getConfig(), a);
    return ok({ results });
  } finally {
    unlockAccount(uid);
  }
}
`;

// GET /tasks/scan_all
files["src/app/api/panel/tasks/scan_all/route.ts"] = `
import { panelAuth, ok } from "@/lib/panel-auth";
import { getConfig } from "@/lib/config";
import { tasksScanAll } from "@/lib/taskcenter";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET 扫描全部账号成长任务待办（只读；对齐 tasksScanAll）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await tasksScanAll(await getConfig());
  return ok({ accounts: r.accounts, pending_count: r.pending_count });
}
`;

// POST /tasks/run_queue
files["src/app/api/panel/tasks/run_queue/route.ts"] = `
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { startGrowthQueue } from "@/lib/taskcenter";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST 启动执行队列：{concurrency:1-4, growth:bool}（对齐 tasksRunQueue）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { concurrency?: number; growth?: boolean } = {};
  try { body = await req.json(); } catch { /* 空 body 用默认 */ }
  const growth = body.growth ?? true;
  const r = await startGrowthQueue(body.concurrency ?? 1, growth);
  if (r.seq === -1) return fail(409, r.msg);
  if (!r.started) return ok({ started: false, message: r.msg });
  return ok({ started: true, total: r.total, seq: r.seq });
}
`;

// GET /tasks/queue
files["src/app/api/panel/tasks/queue/route.ts"] = `
import { panelAuth, ok } from "@/lib/panel-auth";
import { queueStatus } from "@/lib/taskcenter";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET 队列状态（轮询用；对齐 tasksQueueStatus）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const s = queueStatus();
  return ok({
    running: s.running,
    total: s.total,
    conc: s.conc,
    started: s.started,
    started_at: s.started_at,
    seq: s.seq,
    items: s.items,
  });
}
`;

for (const [p, c] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c.trimStart(), "utf8");
  console.log("written", p);
}
