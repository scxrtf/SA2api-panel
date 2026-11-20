"use client";

import { Circle, FileText, GitFork, GitMerge, MessageSquare, Play, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { engineName, sessionColor, statusName, type GraphNode, type Session } from "@/lib/workspace/contracts";
import { anchorId } from "./light";

const icons = { run: Play, fork: GitFork, merge: GitMerge, reply: MessageSquare, tool: Wrench, file: FileText };
const step = 44;
export function WorkspaceTree({ nodes, sessions, selected, onSelect }: {
  nodes: GraphNode[]; sessions: Session[]; selected?: string; onSelect: (node: GraphNode) => void
}) {
  if (!nodes.length) return <div className="aw-empty">客户端发出请求后，这里会显示会话节点。</div>;
  const visible = new Set(nodes.map((node) => node.sessionId));
  const lanes = sessions.filter((s) => visible.has(s.id));
  const indices = new Map(lanes.map((s, index) => [s.id, index]));
  const coordinates = new Map(nodes.map((n, index) => [n.id, { x: 15 + (indices.get(n.sessionId) ?? 0) * 22, y: step / 2 + index * step }]));
  const gutter = 28 + lanes.length * 22;
  return (
    <div className="aw-graph" style={{ minWidth: gutter + 228 }}>
      <svg className="aw-edges" aria-hidden="true" width={gutter} height={nodes.length * step}>
        {nodes.flatMap((node) => {
          const to = coordinates.get(node.id)!;
          return node.parents.flatMap((parent) => {
            const from = coordinates.get(parent);
            if (!from) return [];
            return <path key={node.id + "|" + parent}
              d={from.x === to.x ? `M ${from.x} ${from.y} V ${to.y}` :
                `M ${from.x} ${from.y} C ${from.x} ${from.y + 22}, ${to.x} ${to.y - 22}, ${to.x} ${to.y}`}
              stroke={sessionColor(node.sessionId)} strokeWidth="1.35" strokeOpacity=".48" fill="none" />;
          });
        })}
      </svg>
      <ol aria-label="会话工作树">
        {nodes.map((node) => {
          const where = coordinates.get(node.id)!;
          const Icon = icons[node.kind] ?? Circle;
          const lane = lanes[indices.get(node.sessionId) ?? 0];
          return (
            <li key={node.id} style={{ paddingInlineStart: gutter, height: step }} className="aw-graph-row">
              <span className="aw-node-dot" id={anchorId("node", node.id)} data-session={node.sessionId}
                style={{ left: where.x, color: sessionColor(node.sessionId) }}><Icon size={11} /></span>
              <Button variant="ghost" size="sm" aria-current={selected === node.id ? "true" : undefined}
                onClick={() => onSelect(node)} className="aw-node-button" title={node.label}>
                <span>{node.label}</span>
                <span className="aw-muted">{node.status ? statusName[node.status] : lane ? lane.gateway?.client ?? engineName[lane.engine] : ""}</span>
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
