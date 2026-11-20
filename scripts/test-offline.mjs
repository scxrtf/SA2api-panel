// Portable offline suite: no shell glob expansion, secrets, or live DB writes.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2);
const tests = requested.length ? requested : [
  ...readdirSync(join(root, "scripts")).filter((name) => name.endsWith(".test.mts")).sort().map((name) => `scripts/${name}`),
  "src/lib/cron.keepalive.test.ts",
];
const needsTLS = tests.some((name) => /^official-client-hello/.test(basename(name)));
const binary = join(root, "native", "official-tls", "bin", process.platform === "win32" ? "official-tls.exe" : "official-tls");
if (needsTLS && !existsSync(binary)) {
  const build = spawnSync("go", ["-C", "native/official-tls", "build", "-trimpath", "-o", "bin/", "."], {
    cwd: root, stdio: "inherit", timeout: 120_000, windowsHide: true,
    // An offline suite must not fetch a compiler or modules as a side effect.
    env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" },
  });
  if (build.error) console.error(build.error.message);
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const dataDir = mkdtempSync(join(tmpdir(), "wb2api-suite-"));
try {
  const child = spawn(process.execPath, [
    "--experimental-test-module-mocks", "--import", "tsx", "--import", "./scripts/test-offline-setup.mts",
    "--test", "--test-concurrency=4", "--test-timeout=60000", ...tests,
  ], {
    cwd: root, stdio: "inherit", windowsHide: true, detached: process.platform !== "win32",
    env: { ...process.env, WB2API_DATA_DIR: dataDir },
  });
  // Per-test timeouts do not stop a failed fixture that left an HTTP server
  // open. Bound the whole run and terminate only this child's process tree.
  const timer = setTimeout(() => {
    console.error("Offline test suite exceeded 180 seconds; terminating its process tree.");
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }, 180_000);
  timer.unref();
  try {
    process.exitCode = await new Promise((resolveStatus) => {
      child.once("error", (error) => { console.error(error.message); resolveStatus(1); });
      child.once("close", (code) => resolveStatus(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
  }
} finally {
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith("wb2api-suite-")) {
    throw new Error("unexpected offline-test temporary directory");
  }
  rmSync(dataDir, { recursive: true, force: true });
}
