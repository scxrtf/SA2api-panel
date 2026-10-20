import type { NextConfig } from "next";

// 说明：本项目全部为动态 API 路由 + 单页面板，cacheComponents/ppr 无收益且与
// route segment 的 runtime/dynamic 配置冲突，故不启用。
const nextConfig: NextConfig = {
  // 保留 /panel/ 的尾斜杠形式：关闭 Next 默认的「去尾斜杠 308」，
  // 否则根路径跳转到 /panel/ 后会被再次重定向成 /panel。
  // 只影响 URL 归一化，不会像 trailingSlash: true 那样改到 /api/* 的请求地址。
  skipTrailingSlashRedirect: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
