// thinking.ts DeepSeek 思维链开启：出站请求体注入 thinking:{type:"enabled"} + 默认档位
// （移植 internal/upstream/thinking.go，逐字对齐 injectThinking/backfillReasoningContent）。
//
// 根因：官方客户端对 deepseek 系标记 thinkingFormat:"deepseek" +
// requiresReasoningContentOnAssistantMessages，「开思考」必须显式带
// thinking:{type:"enabled"} + 某档 reasoning_effort，否则上游按不思考应答。
// 非 deepseek 模型（glm/kimi/qwen 等）零改动。

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// defaultDeepSeekEffort 官方客户端默认档兜底（configure thinking 无来源时 fallback 'high'）。
const DEFAULT_DEEPSEEK_EFFORT = "high";

// lookupDefaultEffort 从 defaultEfforts 表按模型名查默认档；nil/未命中 → 空串
// （调用方回退硬编码 high）。
export function lookupDefaultEffort(
  defaultEfforts: Record<string, string> | null | undefined,
  model: string,
): string {
  if (!defaultEfforts || Object.keys(defaultEfforts).length === 0 || model === "") return "";
  return defaultEfforts[model] ?? "";
}

// isDeepSeekModel 模型名以 deepseek 为前缀（不区分大小写）。
export function isDeepSeekModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("deepseek");
}

// injectThinking 按 DeepSeek 思维链开关规则改写请求体（非 deepseek 零改动）：
//   - 显式 thinking.type 非空 → 客户端显式控制：enabled 缺 effort 补默认档；
//     disabled 尊重并删 reasoning_effort（snake/camel 双字段）。
//   - 无 thinking / type 空 / 已有 effort → 注入 enabled 并补默认档（已有 effort 不覆盖）。
export function injectThinking(obj: Obj, defaultEffort: string): void {
  const model = typeof obj.model === "string" ? obj.model : "";
  if (!isDeepSeekModel(model)) return;
  const th = isObj(obj.thinking) ? obj.thinking : undefined;
  let typ = "";
  if (th) {
    typ = typeof th.type === "string" ? th.type.trim() : "";
  }
  // 显式控制分支：type 非空（enabled/disabled 均为明确意图）→ 不改 type。
  if (typ !== "") {
    if (typ.toLowerCase() === "disabled") {
      delete obj.reasoning_effort;
      delete obj.reasoningEffort;
      return; // disabled：关思考且不带任何 effort
    }
    ensureDeepSeekEffort(obj, defaultEffort); // 显式 enabled 缺 effort → 补默认档
    return;
  }
  // 无 thinking / thinking 非法 / type 缺失或为空：注入 enabled（effort 保留给降级逻辑）。
  if (!th) {
    obj.thinking = { type: "enabled" };
  } else {
    th.type = "enabled";
  }
  ensureDeepSeekEffort(obj, defaultEffort);
}

// ensureDeepSeekEffort 缺 effort 档位时补默认档（snake 优先，camel 兜底）。
// 已有任一 effort → 不覆盖（显式档位不改写，降级交给 normalizeReasoningEffort）。
function ensureDeepSeekEffort(obj: Obj, defaultEffort: string): void {
  if ("reasoning_effort" in obj) return;
  if ("reasoningEffort" in obj) return;
  obj.reasoning_effort = defaultEffort === "" ? DEFAULT_DEEPSEEK_EFFORT : defaultEffort;
}

// backfillReasoningContent DeepSeek 多轮一致性：保证每条 assistant 消息带
// reasoning_content 字段且值为 string（requiresReasoningContentOnAssistantMessages）。
//
// 门控：thinkingEnabled（注入后 thinking.type=="enabled"）|| hasTrace（任一消息带
// 非空 reasoning 或已有 reasoning_content 字段）。两者皆无 → 零改动。
//
// 第二遍对所有 assistant：
//   - rc 已是 string → 不覆盖；
//   - reasoning 是非空 string 且 rc 非 string → 复制 reasoning 值；
//   - 皆无 → 补空串 ""；
// 镜像保证 reasoning 存在且非空：reasoning 缺失/空 → rc 非空写 rc 值，皆空补 " "
// （上游部分租户校验 len(reasoning)>0：空串 400、空白串 200）。
export function backfillReasoningContent(obj: Obj): void {
  const model = typeof obj.model === "string" ? obj.model : "";
  if (!isDeepSeekModel(model)) return;
  const msgs = obj.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return;
  // thinkingEnabled 半边：读注入后的 thinking.type。
  let thinkingEnabled = false;
  if (isObj(obj.thinking)) {
    const typ = typeof obj.thinking.type === "string" ? obj.thinking.type : "";
    if (typ.trim().toLowerCase() === "enabled") thinkingEnabled = true;
  }
  // hasTrace 半边：任一消息带非空 reasoning（string）或已有 reasoning_content 字段。
  let hasTrace = false;
  for (const mm of msgs) {
    if (!isObj(mm)) continue;
    if (typeof mm.reasoning === "string" && mm.reasoning !== "") {
      hasTrace = true;
      break;
    }
    if ("reasoning_content" in mm) {
      hasTrace = true;
      break;
    }
  }
  if (!thinkingEnabled && !hasTrace) return;
  for (const mm of msgs) {
    if (!isObj(mm)) continue;
    if (mm.role !== "assistant") continue;
    let rc: string;
    if (typeof mm.reasoning_content === "string") {
      rc = mm.reasoning_content; // 已有 string → 不覆盖
    } else if (typeof mm.reasoning === "string") {
      rc = mm.reasoning;
      mm.reasoning_content = rc;
    } else {
      rc = "";
      mm.reasoning_content = rc;
    }
    // 镜像：reasoning 缺失/空串 → 归一化（非空 rc 优先，皆无补 " "）。
    if (typeof mm.reasoning === "string" && mm.reasoning !== "") continue;
    if (rc !== "") {
      mm.reasoning = rc;
    } else {
      mm.reasoning = " ";
    }
  }
}
