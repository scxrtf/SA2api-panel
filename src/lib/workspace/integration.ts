import { randomUUID } from "node:crypto";
import { mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, within } from "../../../workers/workspace/files";
import { dataRoot, projectRoot, WorkspaceError } from "./settings";
import type { WorkspaceStore } from "./store";

export async function integrateArtifact(store: WorkspaceStore, artifactId: string) {
  const file = store.artifact(artifactId);
  if (!file?.info.patch) throw new WorkspaceError("请选择由 Worker 生成的 Git 补丁。", 404);
  const base = store.session(file.info.sessionId)?.base;
  if (!base || !/^[a-f0-9]{40,64}$/.test(base)) throw new WorkspaceError("补丁缺少已记录的 Git 基线。", 409);
  const old = store.beginIntegration(artifactId);
  if (old) return old;
  const integration = randomUUID();
  const folder = join(dataRoot(), "integrations");
  const checkout = join(folder, integration);
  const patch = join(folder, integration + ".patch");
  let created = false;
  try {
    const root = await realpath(projectRoot());
    if (await realpath((await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim()) !== root) {
      throw new WorkspaceError("服务端注册目录不是仓库根目录。", 409);
    }
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== base) throw new WorkspaceError("项目 HEAD 已变化。请下载补丁核对，或基于最新版本重跑。", 409);
    await mkdir(folder, { recursive: true });
    if (!within(dataRoot(), await realpath(folder))) throw new WorkspaceError("集成目录超出允许范围。", 409);
    await writeFile(patch, file.bytes, { flag: "wx" });
    await git(root, ["worktree", "add", "--detach", checkout, base]);
    created = true;
    if (!within(await realpath(folder), await realpath(checkout))) throw new WorkspaceError("集成检出超出允许范围。", 409);
    try {
      await git(checkout, ["apply", "--check", "--", patch]);
      await git(checkout, ["apply", "--", patch]);
    } catch {
      throw new WorkspaceError("补丁与基线存在冲突。源分支和文件仍可查看。", 409);
    }
    store.endIntegration(file.info, checkout);
    return checkout;
  } catch (error) {
    store.endIntegration(file.info);
    // Keep created checkouts for inspection rather than force-removing a directory.
    if (created) console.warn("[workspace] integration left for inspection:", integration);
    throw error;
  } finally { await unlink(patch).catch(() => undefined); }
}
