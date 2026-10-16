import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "workbuddy2api 面板",
  description: "WorkBuddy 账号池网关管理面板（Next.js 全栈版）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
