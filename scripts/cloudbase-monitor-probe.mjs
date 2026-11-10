// CloudBase / 腾讯云监控探活（只读，不写数据库）。
// 运行：node scripts/cloudbase-monitor-probe.mjs
// 需要：CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY（本机 .env 或环境变量）。
// 输出：console 只打印指标名、时间戳和值，不打印密钥或完整签名。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}
loadEnv();

const secretId = process.env.CLOUDBASE_SECRET_ID ?? "";
const secretKey = process.env.CLOUDBASE_SECRET_KEY ?? "";
const envId = process.env.CLOUDBASE_ENV_ID ?? "";
if (!secretId || !secretKey || !envId) {
  console.error("请配置 CLOUDBASE_SECRET_ID、CLOUDBASE_SECRET_KEY、CLOUDBASE_ENV_ID 后重跑。");
  process.exit(2);
}

const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function api({ service, host, action, version, payload, region = "ap-shanghai" }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8
host:${host}
x-tc-action:${action.toLowerCase()}
`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = `POST
/

${canonicalHeaders}
${signedHeaders}
${sha256(body)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256
${timestamp}
${credentialScope}
${sha256(canonicalRequest)}`;
  const signature = crypto.createHmac("sha256", hmac(hmac(hmac(`TC3${secretKey}`, date), service), "tc3_request"))
    .update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
      "X-TC-Region": region,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { httpStatus: response.status, response: data.Response ?? data };
}

async function probe(name, fn) {
  try {
    const result = await fn();
    console.log(`\n[${name}] HTTP ${result.httpStatus}`);
    const error = result.response.Error;
    if (error) console.log(`API_ERROR ${error.Code}: ${error.Message}`);
    else console.log(JSON.stringify(result.response, null, 2).slice(0, 12000));
  } catch (error) {
    console.log(`\n[${name}] REQUEST_ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`环境 ${envId} · 上海地域 · 只读探活`);
await probe("tcb DescribeEnvs", () => api({
  service: "tcb", host: "tcb.tencentcloudapi.com", action: "DescribeEnvs", version: "2018-06-08",
  payload: { EnvId: envId },
}));

// 官方 CloudBase 环境监控接口：EnvQPSAll 返回指定粒度的环境总 QPS。
const end = new Date(); const start = new Date(end.getTime() - 3600_000);
const localTime = (d) => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return x.toISOString().slice(0,19).replace("T", " "); };
await probe("tcb DescribeCurveData EnvQPSAll", () => api({
  service: "tcb", host: "tcb.tencentcloudapi.com", action: "DescribeCurveData", version: "2018-06-08",
  payload: { EnvId: envId, MetricName: "EnvQPSAll", StartTime: localTime(start), EndTime: localTime(end), Period: 300 },
}));

await probe("tcb DescribeQuotaData DbSizepkg", () => api({
  service: "tcb", host: "tcb.tencentcloudapi.com", action: "DescribeQuotaData", version: "2018-06-08",
  payload: { EnvId: envId, MetricName: "DbSizepkg" },
}));

await probe("tcb DescribeCurveData MysqlDbConnections", () => api({
  service: "tcb", host: "tcb.tencentcloudapi.com", action: "DescribeCurveData", version: "2018-06-08",
  payload: { EnvId: envId, MetricName: "MysqlDbConnections", StartTime: localTime(start), EndTime: localTime(end), Period: 300 },
}));
