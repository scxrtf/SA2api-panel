"use client";
// CloseRouter 机柜（RackScene）的 Web 复刻：九个功能单元一排，
// 编号 / LED 灯条 / 名称，点亮单元抬升 + 橙色描边，下方底座承托。
// 点击单元切换视图，与侧边栏、页头圆点分页器共享同一选中态。
import React from "react";
import { NAV, pad2, type View } from "../nav";

export function Rack({ view, onSelect }: { view: View; onSelect: (v: View) => void }) {
  return (
    <div className="rack" role="tablist" aria-label="功能机柜">
      <div className="rack-units">
        {NAV.map((n, i) => {
          const on = n.id === view;
          return (
            <button key={n.id} role="tab" aria-selected={on}
              className={"rack-unit" + (on ? " on" : "")}
              onClick={() => onSelect(n.id)}>
              <span className="ru-num">{pad2(i + 1)} · {n.code}</span>
              <span className="ru-led"></span>
              <span className="ru-lbl">{n.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 机柜底座 + 点亮单元到内容页的连接线 */
export function RackBase() {
  return (
    <>
      <div className="rack-base"></div>
      <div className="rack-link"></div>
    </>
  );
}
