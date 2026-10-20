// modelview.ts 模型锁池视图的纯聚合核心（移植 Go pool/modelview.go ModelLockView）。
// 从 pool.ts 抽出的原因：聚合逻辑是纯计算，独立于 DB/Prisma 后可离线单测
// （对齐 Go modelview_test.go 的 9 个场景），pool.modelLockView 只做 IO 与适配。

export interface ModelLockRow {
  model: string;
  realm: string;
  total: number; // 该域参与选号的账号数（禁用/暂停不计）
  servable: number; // 此刻真正能服务该模型的账号数
  locked: number; // 因该模型自身冷却被挡的账号数
  state: "locked" | "starved" | "partial";
  unlock_at: string; // 最早解锁（ISO8601；partial 下「何时值得重试」）
  fully_unlock_at: string; // 全部解锁
  reason?: string;
}

// LockViewEntry 聚合输入的最小画像（由调用方从 ORM 行适配）。
export interface LockViewEntry {
  uid: string;
  realm: string;
  disabled: boolean;
  paused: boolean;
  // 账号级冷却/熔断/降权截止时间（unix 毫秒；0 = 无）。servable 判定需要：
  // 模型没被锁但账号级不可用 → 不可服务（starved 场景）。
  accountUnavailableUntil: number;
  // 未过期与否由聚合侧判定：传全部模型级冷却条目即可。
  modelCooldowns: { model: string; until: number; reason: string }[];
}

export function modelLockViewPure(
  entries: LockViewEntry[],
  now: number,
  inFlightFull: (uid: string) => boolean,
): ModelLockRow[] | null {
  interface Agg { locked: number; unlockAt: number; fullyAt: number; reason: string }
  const rows = new Map<string, Agg>();
  const routable = new Map<string, number>();

  for (const e of entries) {
    if (e.disabled || e.paused) continue;
    routable.set(e.realm, (routable.get(e.realm) ?? 0) + 1);
    for (const mc of e.modelCooldowns) {
      if (mc.until <= 0 || now >= mc.until) continue;
      const key = e.realm + "\x1f" + mc.model;
      let a = rows.get(key);
      if (!a) { a = { locked: 0, unlockAt: 0, fullyAt: 0, reason: "" }; rows.set(key, a); }
      a.locked++;
      if (a.unlockAt === 0 || mc.until < a.unlockAt) {
        a.unlockAt = mc.until;
        a.reason = mc.reason;
      }
      if (a.fullyAt === 0 || mc.until > a.fullyAt) a.fullyAt = mc.until;
    }
  }
  if (rows.size === 0) return null;

  const out: ModelLockRow[] = [];
  for (const [key, a] of rows) {
    const sep = key.indexOf("\x1f");
    const realm = key.slice(0, sep);
    const model = key.slice(sep + 1);
    const row: ModelLockRow = {
      model, realm,
      total: routable.get(realm) ?? 0,
      servable: 0,
      locked: a.locked,
      state: "partial",
      unlock_at: new Date(a.unlockAt).toISOString(),
      fully_unlock_at: new Date(a.fullyAt).toISOString(),
    };
    if (a.reason) row.reason = a.reason;
    for (const e of entries) {
      if (e.realm !== realm || e.disabled || e.paused) continue;
      if (e.accountUnavailableUntil > now) continue;
      if (inFlightFull(e.uid)) continue;
      if (e.modelCooldowns.some((c) => c.model === model && now < c.until)) continue;
      row.servable++;
    }
    if (row.servable > 0) row.state = "partial";
    else if (row.locked >= row.total) row.state = "locked";
    else row.state = "starved";
    out.push(row);
  }

  const rank = (st: string) => (st === "locked" ? 0 : st === "starved" ? 1 : 2);
  out.sort((a, b) => {
    const ra = rank(a.state), rb = rank(b.state);
    if (ra !== rb) return ra - rb;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    return a.realm < b.realm ? -1 : 1;
  });
  return out;
}