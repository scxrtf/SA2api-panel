// 面板视图注册表：九层机柜单元 ↔ 九个功能页，与 CloseRouter 七层机柜同一模型。
import type { ReactNode } from "react";
import React from "react";

export type View = "accounts" | "usage" | "packages" | "taskscenter" | "models" | "aichecker" | "gateway" | "connect" | "config" | "logs";

export interface NavItem {
  id: View;
  label: string;     // 侧边栏名称
  code: string;      // 机柜单元等宽编号（对齐 CloseRouter BAY_CODES）
  title: string;     // 页头大标题
  sub: string;       // 页头副标题
  icon: ReactNode;
}

const svgProps = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4 } as const;

export const NAV: NavItem[] = [
  { id: "accounts", label: "账号池", code: "POOL", title: "账号池", sub: "池内账号状态与批量操作",
    icon: React.createElement("svg", svgProps, React.createElement("circle", { cx: 8, cy: 5.5, r: 2.6 }), React.createElement("path", { d: "M2.8 13.5c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4" })) },
  { id: "usage", label: "用量", code: "USAGE", title: "用量", sub: "请求与积分消耗统计",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M2 13.5h12" }), React.createElement("path", { d: "M4.5 13.5V8.2M8 13.5V3.5M11.5 13.5v-3" })) },
  { id: "packages", label: "积分构成", code: "PKG", title: "积分构成", sub: "各账号套餐包与到期分布",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M2.2 5.4 8 2.5l5.8 2.9v5.2L8 13.5l-5.8-2.9z" }), React.createElement("path", { d: "M2.2 5.4 8 8.3l5.8-2.9M8 8.3v5.2" })) },
  { id: "taskscenter", label: "任务中心", code: "TASK", title: "任务中心", sub: "成长任务扫描与队列执行",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M3 2.5h10v9H8l-3 3v-3H3z" }), React.createElement("path", { d: "M6 6.5h4M6 9h2.5" })) },
  { id: "models", label: "模型与档位", code: "MODEL", title: "模型与档位", sub: "可用模型目录与连通性实测",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M8 1.8 14 5v6L8 14.2 2 11V5z" }), React.createElement("path", { d: "M2 5l6 3.2L14 5M8 8.2v6" })) },
  { id: "aichecker", label: "模型鉴别", code: "CHECK", title: "模型鉴别", sub: "统计指纹比对，鉴别渠道掺假（hlwy-ai-checker）",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M6.5 1.8h3v5.2l3.5 5.6a1.8 1.8 0 0 1-1.6 2.7H4.6a1.8 1.8 0 0 1-1.6-2.7L6.5 7z" }), React.createElement("path", { d: "M5.2 10.5h5.6" })) },
  { id: "gateway", label: "供应商与密钥", code: "GW", title: "供应商与密钥", sub: "聚合供应商与网关子密钥",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M2.5 8h3M10.5 8h3M8 2.5v3M8 10.5v3" }), React.createElement("circle", { cx: 8, cy: 8, r: 2.2 }), React.createElement("circle", { cx: 4, cy: 8, r: 1.4 }), React.createElement("circle", { cx: 12, cy: 8, r: 1.4 })) },
  { id: "connect", label: "接入引导", code: "LINK", title: "接入引导", sub: "OpenAI / Anthropic 客户端接入片段",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M6.5 9.5 9.5 6.5" }), React.createElement("path", { d: "M3 10.5c.8.8 2 .8 2.8 0L7 9.3M13 5.5c-.8-.8-2-.8-2.8 0L9 6.7" }), React.createElement("circle", { cx: 3.5, cy: 10.5, r: 1.2 }), React.createElement("circle", { cx: 12.5, cy: 5.5, r: 1.2 })) },
  { id: "config", label: "配置", code: "CFG", title: "配置", sub: "运行与调度参数，保存即热生效",
    icon: React.createElement("svg", svgProps, React.createElement("circle", { cx: 8, cy: 8, r: 2.2 }), React.createElement("path", { d: "M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" })) },
  { id: "logs", label: "运行日志", code: "LOG", title: "运行日志", sub: "请求日志与运行日志",
    icon: React.createElement("svg", svgProps, React.createElement("path", { d: "M2.5 3.5h11M2.5 8h11M2.5 12.5h7" })) },
];

export const pad2 = (n: number) => String(n).padStart(2, "0");
