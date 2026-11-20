import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Maintenance CLIs intentionally use CommonJS, unlike the application.
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // One-off diagnostics inspect dynamic DB/HTTP shapes. Keep the strict
    // no-explicit-any rule on all production source and regression tests.
    files: ["scripts/_*.mts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".codex/**",
    ".codex-backup/**",
    ".runtime/**",
    "scripts/_sseout/**",
    "**/*.bak*",
    "**/*.log",
  ]),
]);

export default eslintConfig;
