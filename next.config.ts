import type { NextConfig } from "next";

const responsesRoot = "/api/v1/responses";
const responsesAliases = ["/v1/responses", "/api/responses", "/responses"];

// 说明：本项目全部为动态 API 路由 + 单页面板，cacheComponents/ppr 无收益且与
// route segment 的 runtime/dynamic 配置冲突，故不启用。
const nextConfig: NextConfig = {
  // Isolated verification builds/dev servers must not overwrite a live .next.
  distDir: process.env.WB2A_NEXT_DIST_DIR || ".next",
  // 允许局域网其他设备访问 dev server 的 HMR 资源（/_next/hmr）。
  allowedDevOrigins: ["192.168.156.52"],
  // 保留 /panel/ 的尾斜杠形式：关闭 Next 默认的「去尾斜杠 308」，
  // 否则根路径跳转到 /panel/ 后会被再次重定向成 /panel。
  // 只影响 URL 归一化，不会像 trailingSlash: true 那样改到 /api/* 的请求地址。
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const responsesBases = [responsesRoot, ...responsesAliases];
    // SDKs append resources to base_url. A pasted full Responses endpoint (or
    // an existing Chat completion endpoint) must not turn /responses into a
    // response ID and accidentally hit the item handler with a POST (405).
    const pastedEndpoints = [...responsesBases, "/api/v1/chat/completions", "/v1/chat/completions"];
    const createAliases = pastedEndpoints.flatMap((base) => [base + "/responses", base + "/v1/responses"]);
    const modelsAliases = [
      "/v1/models", "/api/models", "/models", "/api/v1/v1/models", "/v1/v1/models",
      ...responsesBases.flatMap((base) => [base + "/models", base + "/v1/models"]),
    ];
    return {
      beforeFiles: [
        ...modelsAliases.map((source) => ({ source, destination: "/api/v1/models" })),
        ...[...createAliases, "/api/v1/v1/responses", "/v1/v1/responses", ...responsesAliases].map((base) => ({
          source: base + "/:path*",
          destination: responsesRoot + "/:path*",
        })),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  turbopack: {
    rules: {
      // Only the Tailwind entry needs this loader. Rewriting *.module.css to
      // *.css makes Turbopack lose CSS-module identity and breaks :global().
      "globals.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
