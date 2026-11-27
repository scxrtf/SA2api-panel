import assert from "node:assert/strict";
import { test } from "node:test";

test("资源点合计包含全部有效资源包，失效及 Token Credits 包不混入", async () => {
  const actions: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const action = headers.get("x-tc-action") ?? "";
    actions.push(action);
    const body = JSON.parse(String(init?.body)) as { EnvId?: string };
    if (action !== "DescribeEnvPlans") assert.equal(body.EnvId, "resource-fixture");
    if (action === "DescribeEnvInfo") return Response.json({ Response: { EnvInfo: {
      EnvBaseInfo: { PackageId: "baas_personal", PackageName: "个人版" }, BillingInfo: { EnvQps: { QpsQuota: 500 } },
    } } });
    if (action === "DescribeCurveData") return Response.json({ Response: { Values: [], Time: [] } });
    if (action === "DescribeEnvAccountCircle") return Response.json({ Response: { StartTime: "2026-11-10 00:00:00", EndTime: "2026-12-10 00:00:00" } });
    if (action === "DescribeCreditsUsage") return Response.json({ Response: { DeductValue: 38_509.9, PackageDeductValue: 125 } });
    if (action === "DescribeEnvPlans") return Response.json({ Response: { PlanList: [{
      PackageId: "baas_personal", ResourceLimit: JSON.stringify({ Credits: { MaxSize: "40000" } }),
    }] } });
    if (action === "DescribeEnvPostpayPackage") return Response.json({ Response: { EnvPostpayPackageInfoList: [
      { ResourceId: "pkg-active-1", PostpayPackageId: "pkg_tcb_credits_10000", ResourceType: "CREDITS", Status: 0, Quota: 10_000, LeftValue: 9_875, ExpireTime: "2027-11-26 23:59:59" },
      { ResourceId: "pkg-active-2", PostpayPackageId: "pkg_tcb_credits_10000", ResourceType: "CREDITS", Status: 0, Quota: 10_000, LeftValue: 10_000, ExpireTime: "2027-11-26 23:59:59" },
      { ResourceId: "pkg-active-3", PostpayPackageId: "pkg_tcb_credits_10000", ResourceType: "CREDITS", Status: 0, Quota: 10_000, LeftValue: 10_000, ExpireTime: "2027-11-26 23:59:59" },
      { ResourceId: "pkg-expired", PostpayPackageId: "pkg_tcb_credits_10000", ResourceType: "CREDITS", Status: 3, Quota: 10_000, LeftValue: 0 },
      { ResourceId: "pkg-token", PostpayPackageId: "pkg_tcb_tokencredits_10000", ResourceType: "TOKEN_CREDITS", Status: 0, Quota: 10_000, LeftValue: 10_000 },
    ] } });
    throw new Error("unexpected API " + action);
  };
  process.env.CLOUDBASE_SECRET_ID = "fixture-id";
  process.env.CLOUDBASE_SECRET_KEY = "fixture-secret";
  process.env.CLOUDBASE_ENV_ID = "resource-fixture";
  try {
    const { getCloudbasePlatformStats } = await import("../src/lib/cloudbase-monitor.ts");
    const stats = await getCloudbasePlatformStats();
    const points = stats?.resourcePoints;
    assert.equal(points?.error, null);
    assert.equal(points?.total, 70_000);
    assert.equal(points?.planTotal, 40_000);
    assert.equal(points?.packageTotal, 30_000);
    assert.equal(points?.used, 38_634.9);
    assert.equal(points?.remaining, 31_365.1);
    assert.equal(points?.packages.length, 3);
    assert.deepEqual(points?.packages.map((item) => item.resourceId), ["pkg-active-1", "pkg-active-2", "pkg-active-3"]);
    assert.ok(actions.includes("DescribeEnvPostpayPackage"));
    assert.ok(actions.includes("DescribeEnvPlans"));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLOUDBASE_SECRET_ID;
    delete process.env.CLOUDBASE_SECRET_KEY;
    delete process.env.CLOUDBASE_ENV_ID;
  }
});
