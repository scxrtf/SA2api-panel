"use client";

import { useEffect, useRef, type RefObject } from "react";
import { sessionColor, type WorkspaceEvent } from "@/lib/workspace/contracts";
import { createLightLayer, type LightLayer } from "@/vendor/lancer-light-ui";

export const anchorId = (kind: "model" | "engine" | "activity" | "node", id: string) => `aw-${kind}-${id}`;
function visible(el: HTMLElement | null) {
  if (!el?.isConnected || document.hidden) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return false;
  for (let scroller = el.parentElement; scroller; scroller = scroller.parentElement) {
    if (!scroller.hasAttribute("data-aw-viewport")) continue;
    const bounds = scroller.getBoundingClientRect();
    if (rect.right <= bounds.left || rect.left >= bounds.right || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return false;
  }
  return true;
}
export function useWorkspaceLights(root: RefObject<HTMLElement | null>, events: WorkspaceEvent[], disabled: boolean, mounted: boolean) {
  const layer = useRef<LightLayer | null>(null);
  const active = useRef(0);
  const played = useRef(new Set<number>());
  useEffect(() => {
    if (!mounted || !root.current) return;
    const instance = createLightLayer(root.current);
    layer.current = instance;
    return () => { layer.current = null; instance.destroy(); };
  }, [mounted, root]);
  useEffect(() => {
    if (!events.length) { played.current.clear(); return; }
    const frame = requestAnimationFrame(() => {
      for (const event of events) {
        const beam = event.beacon;
        if (!beam || played.current.has(event.seq)) continue;
        played.current.add(event.seq);
        if (played.current.size > 256) played.current.delete(played.current.values().next().value!);
        const instance = layer.current;
        if (disabled || !instance || active.current >= 5 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) continue;
        const source = document.getElementById(anchorId(beam.from, beam.fromId));
        const actual = visible(source) || beam.from !== "model" ? source : document.getElementById(anchorId("engine", beam.fromId));
        const target = document.getElementById(anchorId("node", beam.nodeId));
        if (!actual || !target || !visible(actual) || !visible(target)) continue;
        active.current++;
        const flight = instance.emit({
          id: String(event.seq), source: () => actual, target: () => target,
          color: sessionColor(target.dataset.session ?? event.node?.sessionId ?? beam.fromId),
          sourceKind: beam.from === "model" ? "model" : undefined,
        });
        void flight.finished.finally(() => { active.current--; });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [disabled, events]);
}
