import type { NextConfig } from "next";

// 说明：本项目全部为动态 API 路由 + 单页面板，cacheComponents/ppr 无收益且与
// route segment 的 runtime/dynamic 配置冲突，故不启用。
const nextConfig: NextConfig = {
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
