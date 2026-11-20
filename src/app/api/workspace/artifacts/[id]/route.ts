import { identifier, json, workspaceError, workspaceGuard } from "@/lib/workspace/http";
import { workspaceStore } from "@/lib/workspace/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guard = await workspaceGuard(req);
    if (guard) return guard;
    const artifact = workspaceStore().artifact(identifier((await context.params).id)!);
    if (!artifact) return json({ error: "文件不存在。" }, 404);
    const preview = new URL(req.url).searchParams.get("preview") === "1";
    if (preview) {
      if (!/\.(?:md|txt|json|diff|patch|log|[mc]?[jt]sx?|css|html|yml|yaml|py|go|rs|sql|toml)$/i.test(artifact.info.name)) {
        return json({ error: "此格式仅供下载。" }, 415);
      }
      return json({ artifact: artifact.info, text: artifact.bytes.subarray(0, 128 * 1024).toString("utf8"), truncated: artifact.bytes.length > 128 * 1024 });
    }
    return new Response(Uint8Array.from(artifact.bytes), { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.info.name.replaceAll("\\", "/").split("/").pop() ?? "artifact")}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return workspaceError(error); }
}
