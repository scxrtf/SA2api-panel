// /api/panel/accounts/scan_models — 全账号模型可用性扫描。
// POST 启动（after 后台执行，立即返回）、GET 轮询进度/结果、DELETE 取消。
import { after } from "next/server";
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import {
  beginModelScan,
  cancelModelScan,
  getModelScanSnapshot,
  runModelScan,
} from "@/lib/modelscan";
import { runlogAccount } from "@/lib/runlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return ok({ scan: getModelScanSnapshot() });
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const job = beginModelScan();
  if (!job) return fail(409, "model scan already running");
  runlogAccount("模型扫描已启动");
  after(() => {
    void runModelScan(job);
  });
  return ok({ scan: getModelScanSnapshot() });
}

export async function DELETE(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cancelled = cancelModelScan();
  if (cancelled) runlogAccount("模型扫描已取消");
  return ok({ cancelled, scan: getModelScanSnapshot() });
}
