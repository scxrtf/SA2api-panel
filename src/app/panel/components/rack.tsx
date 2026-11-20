"use client";

import { useLayoutEffect, useRef } from "react";
import { TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NAV, pad2, type View } from "../nav";

export function Rack({ view }: { view: View }) {
  const scroll = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    const tab = selected.current;
    if (!viewport || !tab) return;
    const reveal = (target: HTMLElement) => {
      const outer = viewport.getBoundingClientRect();
      const inner = target.getBoundingClientRect();
      if (inner.right > outer.right - 4) viewport.scrollLeft += inner.right - outer.right + 4;
      else if (inner.left < outer.left + 4) viewport.scrollLeft += inner.left - outer.left - 4;
    };
    reveal(tab);
    const observer = new ResizeObserver(() => reveal(tab));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [view]);

  return (
    <div ref={scroll} className="panel-rack" onFocus={(event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") return;
      const viewport = scroll.current;
      if (!viewport) return;
      const outer = viewport.getBoundingClientRect(), tab = target.getBoundingClientRect();
      if (tab.left < outer.left + 4) viewport.scrollLeft += tab.left - outer.left - 4;
      else if (tab.right > outer.right - 4) viewport.scrollLeft += tab.right - outer.right + 4;
    }}>
      <TabsList variant="line" aria-label="功能机柜" className="panel-rack-list">
        {NAV.map((entry, index) => (
          <TabsTrigger key={entry.id} value={entry.id} ref={entry.id === view ? selected : undefined}
            className="panel-rack-tab" title={entry.title}>
            <span className="panel-rack-mark" aria-hidden="true">{entry.icon}<span>{pad2(index + 1)}</span></span>
            <span>{entry.label}</span>
          </TabsTrigger>
        ))}
        <TabsIndicator className="panel-rack-indicator" />
      </TabsList>
    </div>
  );
}
