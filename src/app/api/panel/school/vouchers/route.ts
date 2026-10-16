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
