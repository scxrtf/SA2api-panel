// 「思考吃光预算」的救援重发（移植上游 internal/server/starved.go，提交 b0320cf）。
//
// 现象（上游真机实测，cn:deepseek-v4.1-flash）：上游把 reasoning 与正文字节算在
// **同一个** max_tokens 预算里，思考没有独立上限字段。客户端给一个偏小的预算时，
// 思考可以独吞整份额度 —— 结束于 finish_reason=length、正文零字节、没有 tool_calls，
// 客户端（Agent 循环尤其致命）看到的就是「空回复」：
//
//   max_tokens=60/100/150/200/300 → thinking 数正好等于预算，正文 0 字节
//   max_tokens=400                → 思考 166~272，正文开始出现（时好时坏）
//   thinking:{type:disabled} 同额度 → 正文正常、finish=stop
//
// 救援动作是「同预算、关思考」重发一次：不放大客户端要的额度（超发既是语义违约，
// 也是新的可判别形态），只把预算从思考手里拿回来。触发条件收得很紧——finish_reason
// 为 length、正文为空、无 tool_calls、每请求仅一次；有正文的截断属客户端额度语义的
// 正常结果，不碰。
//
// 本地实现边界：wb2api-next 的流式是逐帧透传（无上游 continueReader 的分段缓冲），
// 流已外泄后无法干净重发，故此处只承担**非流式**一侧的救援。
import { isDeepSeekModel } from "./upstream/thinking";

type Obj = Record<string, unknown>;

// minStarvedBudget 低于此额度不救援：官方客户端用 max_tokens=1 做 key 探活，
// 那种请求按原样失败即可，不值得为它多发一次上游请求。
const MIN_STARVED_BUDGET = 16;

// outputBudget 读请求体里的输出限额（三个别名），未携带 → 0。
export function outputBudget(obj: Obj): number {
  for (const k of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  }
  return 0;
}

// thinkingSwitchSupported 该模型能否用 thinking.type 关掉思考。
// 目前只有 DeepSeek 系：thinking.ts 只对这类模型注入 thinking 字段，也只有它验证过
// 「disabled + 同额度 → 正文正常」。入参可带 realm 前缀（cn:/global:）。
function thinkingSwitchSupported(model: string): boolean {
  const bare = model.trim().replace(/^(cn|global):/i, "");
  return isDeepSeekModel(bare);
}

// starvedRetryBody 把请求体改写成救援形态：thinking 关掉、删掉思考档位，其余
// （含 max_tokens / tools / messages）原样保留。返回 null 表示「不猜」：
// 拿不到思考开关的模型、已经关着思考的、额度小到不值得重发的、body 不可解析。
export function starvedRetryBody(body: string): string | null {
  let obj: Obj;
  try {
    obj = JSON.parse(body) as Obj;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const budget = outputBudget(obj);
  if (budget > 0 && budget < MIN_STARVED_BUDGET) return null;
  const rawThinking = obj["thinking"];
  let th: Obj;
  if (rawThinking && typeof rawThinking === "object" && !Array.isArray(rawThinking)) {
    th = { ...(rawThinking as Obj) };
  } else if (rawThinking === undefined) {
    // 客户端通常不自带 thinking（档位/开关由出站管线注入）：按模型能力判断能否关。
    const model = typeof obj["model"] === "string" ? (obj["model"] as string) : "";
    if (!thinkingSwitchSupported(model)) return null;
    th = {};
  } else {
    return null; // thinking 非法非对象：不猜
  }
  const t = typeof th["type"] === "string" ? (th["type"] as string).trim().toLowerCase() : "";
  if (t === "disabled") return null;
  th["type"] = "disabled";
  obj["thinking"] = th;
  // 关思考就别再带档位：disabled + effort 的组合语义未取证。
  delete obj["reasoning_effort"];
  delete obj["reasoningEffort"];
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

// aggregateStarved 聚合体是否属于「预算被思考吃光、什么也没产出」。
// 三个条件同时成立才算：finish_reason=length、正文为空、没有 tool_calls。
export function aggregateStarved(resp: Obj): boolean {
  const chs = resp["choices"];
  if (!Array.isArray(chs) || chs.length === 0) return false;
  const c = chs[0];
  if (!c || typeof c !== "object") return false;
  const choice = c as Obj;
  if (choice["finish_reason"] !== "length") return false;
  const m = choice["message"];
  if (!m || typeof m !== "object") return false;
  const msg = m as Obj;
  const content = msg["content"];
  if (typeof content === "string" && content.trim() !== "") return false;
  const tcs = msg["tool_calls"];
  if (Array.isArray(tcs) && tcs.length > 0) return false;
  return true;
}
