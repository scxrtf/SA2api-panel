// 面板 API 全量 GET 冒烟：逐个打 /api/panel/*，记录状态码与错误。
// 运行：node scripts/_smoke-panel.cjs [baseUrl]
const base = process.argv[2] || "http://localhost:3001";
const GETS = [
  "api/healthz", "api/livez", "api/status",
  "api/panel/overview",
  "api/panel/accounts/scan_models",
  "api/panel/activity_all",
  "api/panel/balance_all",
  "api/panel/balance_history",
  "api/panel/checkin_all",
  "api/panel/config",
  "api/panel/database",
  "api/panel/keys",
  "api/panel/login/poll",
  "api/panel/login/regions",
  "api/panel/logs",
  "api/panel/machine",
  "api/panel/models",
  "api/panel/model_health/probe",
  "api/panel/model_probes",
  "api/panel/packages",
  "api/panel/providers",
  "api/panel/request_logs",
  "api/panel/request_metrics",
  "api/panel/school/vouchers",
  "api/panel/tasks/queue",
  "api/panel/travel_all",
  "api/panel/usage",
  "api/v1/models",
];
(async () => {
  let pass = 0, fail = 0;
  for (const p of GETS) {
    try {
      const r = await fetch(`${base}/${p}`, { signal: AbortSignal.timeout(30_000) });
      const t = await r.text();
      let msg = "";
      try { const j = JSON.parse(t); if (j && j.ok === false) msg = " err=" + (j.error || "").slice(0, 120); } catch { msg = " (non-json " + t.length + "b)"; }
      const okMark = r.status < 500 && !msg.startsWith(" err") ? "OK  " : "FAIL";
      if (okMark === "OK  ") pass++; else fail++;
      console.log(`${okMark} ${r.status} ${p}${msg}`);
    } catch (e) {
      fail++;
      console.log(`FAIL --- ${p} ${e.message?.slice(0, 100)}`);
    }
  }
  console.log(`\n${pass} pass / ${fail} fail / ${GETS.length} total`);
})();
