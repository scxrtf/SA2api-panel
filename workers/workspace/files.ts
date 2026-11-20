import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { dataRoot, projectRoot } from "../../src/lib/workspace/settings";
import type { SessionRecord } from "../../src/lib/workspace/store";

const exec = promisify(execFile);
const FILE_LIMIT = 2 * 1024 * 1024;
const exclusion = /^(?:\.env(?:\..*)?|\.git|\.codex|\.runtime|\.workbuddy|\.ssh|\.aws|node_modules|\.next|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials(?:\..*)?|auth\.json)$/i;
export const safeRelative = (input: string) => {
  const normalized = input.replaceAll("\\", "/");
  return normalized.length > 0 && normalized.length <= 500 && !isAbsolute(normalized)
    && !/[:\u0000-\u001f]/.test(normalized)
    && normalized.split("/").every((part) => !!part && part !== "." && part !== ".."
      && !/[. ]$/.test(part) && !exclusion.test(part) && !/\.(?:pem|key|pfx|p12)$/i.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
};
export const within = (root: string, child: string) => {
  const result = relative(root, child);
  return result !== "" && result !== ".." && !result.startsWith(".." + sep) && !isAbsolute(result);
};
const systemEnvNames = /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|username|lang|lc_.*|programfiles(?:\(x86\))?)$/i;
export function childEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value && systemEnvNames.test(key))),
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
}
export function git(cwd: string, args: string[]) {
  return exec("git", ["-c", "core.hooksPath=" + join(dataRoot(), "disabled-hooks"), "-C", cwd, ...args], {
    windowsHide: true, timeout: 25_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...childEnv(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
}
export async function worktree(session: SessionRecord, inheritedBase?: string) {
  const root = await realpath(projectRoot());
  const actual = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const gitRoot = await realpath(actual);
  if (root !== gitRoot) throw new Error("WB2_WORKSPACE_ROOT 必须指向 Git 仓库根目录。");
  const dir = resolve(dataRoot(), "checkouts", session.id);
  if (!within(resolve(dataRoot(), "checkouts"), dir)) throw new Error("检出目录无效。");
  const base = session.base ?? inheritedBase ?? (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new Error("Git 基线无效。");
  const old = await lstat(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!old) {
    await mkdir(dirname(dir), { recursive: true });
    await git(root, ["worktree", "add", "--detach", dir, base]);
  } else if (!old.isDirectory() || old.isSymbolicLink()) {
    throw new Error("检出目录已被替换。");
  }
  const cwd = await realpath(dir);
  if (!within(await realpath(dirname(dir)), cwd)) throw new Error("检出目录超出工作区。");
  const observedBase = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  if (observedBase !== base) throw new Error("检出基线已变化，请创建新会话。");
  return { cwd, base };
}

export async function checkedPath(cwd: string, path: string, missing = false) {
  if (!safeRelative(path)) throw new Error("文件名超出工作区允许范围。");
  const root = await realpath(cwd);
  let at = root;
  for (const part of path.replaceAll("\\", "/").split("/")) {
    at = join(at, part);
    const info = await lstat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && missing) return undefined;
      throw error;
    });
    if (info) {
      if (info.isSymbolicLink() || !within(root, await realpath(at))) throw new Error("文件链接超出允许范围。");
    }
  }
  return at;
}
export async function readProjectFile(cwd: string, path: string) {
  const file = await checkedPath(cwd, path);
  const info = await stat(file);
  if (!info.isFile() || info.size > 384 * 1024) throw new Error("文件类型或大小超出读取范围。");
  const buffer = await readFile(file);
  if (buffer.includes(0)) throw new Error("二进制文件请使用项目已有工具。");
  return buffer.toString("utf8");
}
export async function writeProjectFile(cwd: string, path: string, content: string) {
  const file = await checkedPath(cwd, path, true);
  if (Buffer.byteLength(content) > 384 * 1024) throw new Error("文件超过大小上限。");
  await mkdir(dirname(file), { recursive: true });
  await checkedPath(cwd, path, true);
  const scratch = join(dirname(file), `.wb2-write-${randomUUID()}`);
  await writeFile(scratch, content, { flag: "wx" });
  await rename(scratch, file);
}

const plainFile = /\.(?:md|txt|json|diff|patch|log|[mc]?[jt]sx?|css|html|yml|yaml|py|go|rs|sql|toml)$/i;
export async function changedFiles(cwd: string) {
  const raw = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).stdout;
  const list = raw.split("\0").filter(Boolean).map((row) => ({ path: row.slice(3), state: row.slice(0, 2) }));
  return list.filter(({ path }) => safeRelative(path)).slice(0, 150);
}
export async function collectFiles(cwd: string, originalBase: string) {
  const changes = await changedFiles(cwd);
  const files: { name: string; bytes: Buffer; patch?: boolean }[] = [];
  const tracked: string[] = [];
  let remaining = 6 * FILE_LIMIT;
  for (const item of changes) {
    if (item.state !== "??") tracked.push(item.path);
    else {
      // A separate patch per new file, using stock Git (including no-newline markers).
      await git(cwd, ["add", "--intent-to-add", "--", item.path]).catch(() => undefined);
      tracked.push(item.path);
    }
    if (files.length >= 20 || !plainFile.test(item.path) || item.state.includes("D")) continue;
    const path = await checkedPath(cwd, item.path).catch(() => null);
    if (!path) continue;
    const meta = await stat(path).catch(() => null);
    if (!meta?.isFile() || meta.size > Math.min(remaining, FILE_LIMIT)) continue;
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    remaining -= bytes.length;
    files.push({ name: item.path, bytes });
  }
  if (tracked.length && /^[a-f0-9]{40,64}$/.test(originalBase)) {
    const diff = (await git(cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", originalBase, "--", ...tracked])).stdout;
    if (diff && Buffer.byteLength(diff) <= FILE_LIMIT) files.unshift({ name: "changes.diff", bytes: Buffer.from(diff), patch: true });
  }
  return files;
}

export async function listProjectFiles(cwd: string) {
  return (await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).stdout.split("\0")
    .filter((file) => safeRelative(file)).slice(0, 400).join("\n");
}
