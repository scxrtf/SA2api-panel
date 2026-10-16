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
