// tool_pairing.ts 出站请求体的孤儿 tool_call↔tool 配对清理 + tool 结果块重排
// （移植 internal/upstream/tool_pairing.go，吸收参考仓库 sse.ts resolveToolPairing 语义）。
//
// 背景：OpenAI 兼容协议要求带 tool_calls 的 assistant 消息，其每一个 tool_call id
// 都必须有对应的一条 role:tool 结果消息；反之亦然。缺任一侧，上游都以 HTTP 400
// （11148 tool_call_sequence_broken）拒绝整个请求，且客户端每次重放坏历史 → 整条会话报废。
// 网关是最后一道防线：发出请求前剔除无法配对的条目让会话自愈。

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const role = (m: Obj): string => (typeof m.role === "string" ? m.role : "");
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// emptyContent content 是否为空（缺失 / null / 空串 / 空数组）。空数组也必须算空：
// 有客户端把"没有正文"发成 content: [] 而不是 null，此前按"非字符串一律非空"处理
// → 背靠背的两条 assistant(tool_calls) 不合并 → 上游判 11148。非空数组仍视为有内容。
function emptyContent(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// repackToolResultBlocks 把插在 assistant.tool_calls 与其 tool 结果之间的非 tool 消息
// 挪到整组之后，保证同一批 tool_call 的结果在 wire 上连续。
//
//  Codex 的 image_resize_notice 会把一条 developer/system 消息插在两份 tool 结果中间：
//    assistant tool_calls=[c00 c01] | tool c00 | developer <notice> | tool c01
//  OpenAI 协议要求 tool 结果紧跟 assistant，中间插任何消息都算配对断裂（11148）。
//  只调顺序、不改内容：→ tool c00 | tool c01 | developer <notice>。
//  无插入消息时零改动（返回原数组）。
export function repackToolResultBlocks(messages: unknown[]): { out: unknown[]; changed: boolean } {
  if (messages.length < 3) return { out: messages, changed: false };
  const out: unknown[] = [];
  let changed = false;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!isObj(m) || role(m) !== "assistant") { out.push(m); i++; continue; }
    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : null;
    if (!tcs || tcs.length === 0) { out.push(m); i++; continue; }
    const want = new Set<string>();
    for (const tci of tcs) {
      if (isObj(tci)) { const id = str(tci.id); if (id) want.add(id); }
    }
    out.push(m);
    i++;
    const results: unknown[] = [];
    const between: unknown[] = [];
    let sawNonTool = false;
    while (i < messages.length) {
      const mm = messages[i];
      if (!isObj(mm)) break;
      const r = role(mm);
      if (r === "tool") {
        const id = str(mm.tool_call_id);
        if (!want.has(id)) break;
        results.push(mm);
        if (sawNonTool) changed = true;
        i++;
        continue;
      }
      if (results.length === 0) break; // assistant 后没有结果：交由 cleanupOrphanToolCalls 处理
      // 下一组 assistant.tool_calls 是新的组头，绝不能当插入物吞掉：一旦被收进 between，
      // 它自己那批结果就永远得不到重排。必须 break 交还外层循环。
      if (r === "assistant" && Array.isArray(mm.tool_calls) && (mm.tool_calls as unknown[]).length > 0) break;
      // 同批结果尚未收齐时，中间消息视为插入物，暂存待后移。
      between.push(mm);
      sawNonTool = true;
      i++;
    }
    out.push(...results, ...between);
  }
  if (!changed) return { out: messages, changed: false };
  return { out, changed: true };
}

// cleanupOrphanToolCalls 剔除无法配对的 tool_call 与 tool 结果（所有模型，独立于 sanitize）。
//
//   - 收集全线 role:tool 的 tool_call_id（结果集）与 assistant.tool_calls[].id（调用集）；
//   - 一批 assistant.tool_calls 按 keepCalls 对称裁剪：只留有结果配对的调用，
//     过滤后为空才删掉整个 tool_calls 键；
//   - role:tool 只在对应 tool_call 被保留时才保留，否则删除整条消息；
//   - 无任何工具流量 → 原数组原样返回，changed=false。
//
// 两侧共用同一份 keepCalls 按 id 对称裁剪，任何输入都不会产生半截配对。
export function cleanupOrphanToolCalls(messages: unknown[]): { out: unknown[]; changed: boolean } {
  if (messages.length === 0) return { out: messages, changed: false };
  const callIDs = new Set<string>();
  const resultIDs = new Set<string>();
  let hasTraffic = false;
  for (const m of messages) {
    if (!isObj(m)) continue;
    const r = role(m);
    if (r === "tool") {
      const id = str(m.tool_call_id);
      if (id) { resultIDs.add(id); hasTraffic = true; }
    } else if (r === "assistant") {
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : null;
      if (tcs) for (const tci of tcs) {
        if (isObj(tci)) { const id = str(tci.id); if (id) { callIDs.add(id); hasTraffic = true; } }
      }
    }
  }
  if (!hasTraffic) return { out: messages, changed: false };
  // keepCalls：调用 id 双侧齐全（调用存在且结果存在）。重复 id 与乱序均按集合处理。
  const keepCalls = new Set<string>();
  for (const id of callIDs) if (resultIDs.has(id)) keepCalls.add(id);
  let changed = false;
  // 1) assistant.tool_calls：按 keepCalls 对称裁剪——只留有结果的调用，过滤后为空则删键。
  for (const m of messages) {
    if (!isObj(m) || role(m) !== "assistant") continue;
    const tcs = Array.isArray(m.tool_calls) ? (m.tool_calls as unknown[]) : null;
    if (!tcs || tcs.length === 0) continue;
    const keptCalls = tcs.filter((tci) => isObj(tci) && keepCalls.has(str(tci.id)));
    if (keptCalls.length === tcs.length) continue; // 整批齐全：零改动
    changed = true;
    if (keptCalls.length === 0) { delete m.tool_calls; continue; }
    m.tool_calls = keptCalls;
  }
  // 2) role:tool 结果：只有对应 tool_call 被保留才保留；孤儿结果整条删除。
  const kept = messages.filter((m) => {
    if (!isObj(m)) return true;
    if (role(m) === "tool") {
      const id = str(m.tool_call_id);
      if (!keepCalls.has(id)) { changed = true; return false; }
    }
    return true;
  });
  if (!changed) return { out: messages, changed: false };
  return { out: kept, changed: true };
}

// mergeReasoningContent 把 src 的 reasoning_content 并入 dst（两边都有则换行拼接）。
// deepseek 多轮要求 assistant 带思维链回填，合并时丢弃会换一个错误。
function mergeReasoningContent(dst: Obj, src: Obj): void {
  const rc = str(src.reasoning_content);
  if (!rc) return;
  const prevRC = str(dst.reasoning_content);
  dst.reasoning_content = prevRC ? prevRC + "\n" + rc : rc;
}

// mergeAdjacentToolCalls 把**背靠背**的 assistant.tool_calls 消息合成一条（tool_calls 依原序拼接）。
//
//  部分客户端把同一批并行工具调用拆成多条紧邻的独立 assistant 消息：
//    assistant tool_calls=[c00] | assistant tool_calls=[c01] | tool c00 | tool c01
//  上游 deepseek 系要求「声明 tool_calls 的 assistant 之后必须紧跟它自己的结果」，
//  紧随的若是另一条带 tool_calls 的 assistant 即返回 400 11148，整条会话报废。
//  网关按最严口径归一，客户端不必感知。
//
//  合并条件从严：两条消息**相邻**、后一条 content 为空、前一条本身带 tool_calls。
//  reasoning_content 不丢：后一条有则搬到合并结果，两边都有则换行拼接。
export function mergeAdjacentToolCalls(messages: unknown[]): { out: unknown[]; changed: boolean } {
  if (messages.length < 2) return { out: messages, changed: false };
  const out: unknown[] = [];
  let changed = false;
  for (const m of messages) {
    const msg = isObj(m) ? m : null;
    if (msg && role(msg) === "assistant" && out.length > 0) {
      const prev = isObj(out[out.length - 1]) ? (out[out.length - 1] as Obj) : null;
      // 形态一：本条是带 tool_calls 的 assistant 且没有正文 → 并入上一条带 tool_calls 的 assistant。
      if (Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length > 0 && emptyContent(msg.content)) {
        if (prev && role(prev) === "assistant" && Array.isArray(prev.tool_calls) && (prev.tool_calls as unknown[]).length > 0) {
          prev.tool_calls = [...(prev.tool_calls as unknown[]), ...(msg.tool_calls as unknown[])];
          mergeReasoningContent(prev, msg);
          changed = true;
          continue;
        }
      }
      // 形态二（反向）：本条是纯正文 assistant，上一条是带 tool_calls 但没正文的 assistant
      // → 把正文折进上一条，合成 assistant(正文 + tool_calls)。
      if (!("tool_calls" in msg)) {
        const txt = str(msg.content);
        if (txt && prev && role(prev) === "assistant"
          && Array.isArray(prev.tool_calls) && (prev.tool_calls as unknown[]).length > 0 && emptyContent(prev.content)) {
          prev.content = txt;
          mergeReasoningContent(prev, msg);
          changed = true;
          continue;
        }
      }
    }
    out.push(m);
  }
  if (!changed) return { out: messages, changed: false };
  return { out, changed: true };
}

// resolveToolPairing 配对管线入口（对齐 Go 在 PrepareBody 里的组合顺序）：
// 先合并背靠背 → 再重排结果块 → 最后剔除孤儿。返回是否发生变化。
export function resolveToolPairing(obj: Obj): boolean {
  const messages = obj.messages;
  if (!Array.isArray(messages)) return false;
  let cur: unknown[] = messages;
  let changed = false;
  const m1 = mergeAdjacentToolCalls(cur);
  if (m1.changed) { cur = m1.out; changed = true; }
  const r1 = repackToolResultBlocks(cur);
  if (r1.changed) { cur = r1.out; changed = true; }
  const c1 = cleanupOrphanToolCalls(cur);
  if (c1.changed) { cur = c1.out; changed = true; }
  if (changed) obj.messages = cur;
  return changed;
}
