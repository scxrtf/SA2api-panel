// 面板时间的纯函数测试：进程处于 UTC 时仍固定输出 Asia/Shanghai。
import assert from "node:assert/strict";
import { fmtClock, fmtDateTime, PANEL_TIME_ZONE } from "../src/app/panel/lib.ts";

assert.equal(PANEL_TIME_ZONE, "Asia/Shanghai");
// 2026-01-01 00:00:00 UTC = 2026-01-01 08:00:00 北京时间。
const instant = "2026-01-01T00:00:00.000Z";
assert.match(fmtClock(instant), /08:00:00/);
assert.match(fmtDateTime(instant), /2026/);
assert.match(fmtDateTime(instant), /08:00:00/);
assert.equal(fmtDateTime(null), "-");
assert.equal(fmtClock(0), "-");
console.log("PASS panel timestamps use Asia/Shanghai independently of host timezone");
