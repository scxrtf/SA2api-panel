// CloudBase 环境级监控：官方 TCB API + CAM TC3-HMAC-SHA256。
// 只返回本环境确实提供的指标；共享 PG 不伪造容量或连接数。
import { createHash, createHmac } from "node:crypto";

type CurveResponse = {
  Error?: { Code?: string; Message?: string };
  NewValues?: number[] | null;
  Values?: number[] | null;
  Time?: number[] | null;
  Period?: number;
  Statistics?: string;
};

type EnvResponse = {
  Error?: { Code?: string; Message?: string };
  EnvInfo?: {
    BillingInfo?: { EnvQps?: { QpsQuota?: number }; PackageId?: string };
    EnvBaseInfo?: { PackageName?: string; PostgreSQL?: { TenantType?: string }[] };
  };
};

export interface CloudbasePlatformStats {
  configured: boolean;
  available: boolean;
  source: "tcb DescribeCurveData";
  qps: number | null;
  qpsQuota: number | null;
  periodSeconds: number;
  sampledAt: string | null;
  statistics: string | null;
  packageName: string | null;
  postgresTenantType: string | null;
  error: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

async function tcbApi<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const secretId = process.env.CLOUDBASE_SECRET_ID ?? "";
  const secretKey = process.env.CLOUDBASE_SECRET_KEY ?? "";
  const region = process.env.CLOUDBASE_REGION ?? "ap-shanghai";
  const service = "tcb";
  const host = "tcb.tencentcloudapi.com";
  const version = "2018-06-08";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const signature = createHmac("sha256", hmac(hmac(hmac(`TC3${secretKey}`, date), service), "tc3_request"))
    .update(stringToSign).digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      "X-TC-Action": action,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": version,
      "X-TC-Region": region,
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const json = await response.json() as { Response?: T };
  const data = json.Response ?? (json as T);
  const err = (data as CurveResponse).Error;
  if (!response.ok || err) throw new Error(`${response.status} ${err?.Code ?? "tcb_api"}: ${err?.Message ?? "request_failed"}`);
  return data;
}

function localTime(date: Date): string {
  const ms = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export async function getCloudbasePlatformStats(): Promise<CloudbasePlatformStats | null> {
  if (!process.env.CLOUDBASE_SECRET_ID || !process.env.CLOUDBASE_SECRET_KEY) return null;
  const envId = process.env.CLOUDBASE_ENV_ID ?? "";
  const periodSeconds = 300;
  const end = new Date();
  const start = new Date(end.getTime() - 3600_000);
  const result: CloudbasePlatformStats = {
    configured: true,
    available: false,
    source: "tcb DescribeCurveData",
    qps: null,
    qpsQuota: null,
    periodSeconds,
    sampledAt: null,
    statistics: null,
    packageName: null,
    postgresTenantType: null,
    error: null,
  };
  try {
    const [env, curve] = await Promise.all([
      tcbApi<EnvResponse>("DescribeEnvInfo", { EnvId: envId }),
      tcbApi<CurveResponse>("DescribeCurveData", {
        EnvId: envId,
        MetricName: "EnvQPSAll",
        StartTime: localTime(start),
        EndTime: localTime(end),
        Period: periodSeconds,
      }),
    ]);
    const values = curve.NewValues ?? curve.Values ?? [];
    const last = values.length ? values[values.length - 1] : null;
    result.qps = typeof last === "number" && Number.isFinite(last) ? last : null;
    result.qpsQuota = env.EnvInfo?.BillingInfo?.EnvQps?.QpsQuota ?? null;
    result.periodSeconds = curve.Period || periodSeconds;
    result.sampledAt = curve.Time?.length ? new Date(curve.Time[curve.Time.length - 1] * 1000).toISOString() : null;
    result.statistics = curve.Statistics ?? null;
    result.packageName = env.EnvInfo?.EnvBaseInfo?.PackageName ?? env.EnvInfo?.BillingInfo?.PackageId ?? null;
    result.postgresTenantType = env.EnvInfo?.EnvBaseInfo?.PostgreSQL?.[0]?.TenantType ?? null;
    result.available = result.qps !== null;
    if (!result.available) result.error = "最近一小时暂无 QPS 数据点";
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
  }
  return result;
}
