import { createHash } from "node:crypto";
import { runNode, runStatusActivity, TEXT_LIMIT, type Activity, type Session, type Status } from "../../src/lib/workspace/contracts";
import type { Ticket, WorkspaceStore } from "../../src/lib/workspace/store";

const hash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 25);
export function traceText(value: string, max = TEXT_LIMIT) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(\b(?:Authorization|API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD)\s*[:=]\s*)(?:Bearer\s+)?[^\s"'\x60,;]+/gi, "$1[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[已隐藏]").slice(0, max);
}
export interface RunResult { text: string; outputId?: string; cancelled?: boolean }
export class Bridge {
  private pending = new Map<string, { activity: Activity; size: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastFinal = new Map<string, { text: string; outputId: string }>();
  constructor(readonly store: WorkspaceStore, readonly ticket: Ticket, readonly session: Session) {}
  get job() { return this.ticket.job; }
  anchor(session = this.session) {
    if (session.id !== this.session.id) return `branch:${session.id}`;
    return this.job.phase === "join" ? `merge:${this.job.id}` : runNode(this.job.id);
  }
  result(): RunResult { return this.lastFinal.get(this.session.id) ?? { text: "" }; }
  private id(kind: string, key: string, session: Session) { return `${kind}:${hash(`${this.job.id}:${session.id}:${key}`)}`; }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const { activity } of this.pending.values()) this.store.publish(this.ticket, { activity, append: true });
    this.pending.clear();
  }
  replyDelta(key: string, delta: string, session = this.session) {
    if (!delta) return;
    const id = this.id("reply", key, session);
    const previous = this.pending.get(id);
    const activity: Activity = {
      id, sessionId: session.id, runId: this.job.id, kind: "assistant", title: "回复",
      text: (previous?.activity.text ?? "") + delta, status: "running",
    };
    if (activity.text.length > TEXT_LIMIT) activity.text = activity.text.slice(0, TEXT_LIMIT);
    this.pending.set(id, { activity, size: activity.text.length });
    if (activity.text.length >= 2048) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 120);
  }
  reply(key: string, value: string, status: "completed" | "failed" | "cancelled" = "completed", session = this.session) {
    if (!value.trim() && !this.pending.size) return;
    this.flush();
    const text = traceText(value);
    if (!text.trim()) return;
    const id = this.id("reply", key, session);
    const activity: Activity = { id, sessionId: session.id, runId: this.job.id, kind: "assistant", title: "回复", text, status };
    this.store.publish(this.ticket, {
      activity,
      node: { id, sessionId: session.id, runId: this.job.id, kind: "reply", label: "回复", status, parents: [this.anchor(session)], activityId: id },
      beacon: status === "completed" ? { from: "activity", fromId: id, nodeId: id } : undefined,
    });
    if (status === "completed") this.lastFinal.set(session.id, { text, outputId: id });
  }
  tool(key: string, label: string, status: Status, detail = "", session = this.session) {
    const id = this.id("tool", key, session);
    this.store.publish(this.ticket, {
      activity: {
        id, sessionId: session.id, runId: this.job.id, kind: "tool", title: traceText(label, 120),
        text: traceText(detail, 5000), status,
      },
      node: { id, sessionId: session.id, runId: this.job.id, kind: "tool", label: traceText(label, 70), parents: [this.anchor(session)], status, activityId: id },
    });
    return id;
  }
  nativeBranch(externalId: string, index: number, sourceNode: string) {
    return this.store.agentBranch(this.ticket, externalId, `Codex 子代理 ${index}`, sourceNode);
  }
  file(name: string, bytes: Buffer, outputId?: string, patch = false) {
    return this.store.putArtifact(this.ticket, name, bytes, outputId ?? runStatusActivity(this.job.id), outputId ?? this.anchor(), patch);
  }
}
