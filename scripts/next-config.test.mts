import assert from "node:assert/strict";
import test from "node:test";
import type { NextConfig } from "next";
import importedConfig from "../next.config.ts";

// tsx's CJS interop and native ESM expose Next's default export differently.
const raw: unknown = importedConfig;
const config = (raw && typeof raw === "object" && "default" in raw ? raw.default : raw) as NextConfig;

test("Tailwind loader 仅作用于入口，不覆盖 CSS module 扩展名", () => {
  const rules = config.turbopack?.rules;
  assert.ok(rules?.["globals.css"]);
  assert.equal(rules?.["*.css"], undefined);
  assert.equal(rules?.["*.module.css"], undefined);
});

test("vendored TypeScript 入口可解析，未引用不存在的编译后 .js", async () => {
  const light = await import("../src/vendor/lancer-light-ui/index.ts");
  assert.equal(typeof light.createLightLayer, "function");
  assert.equal(typeof light.svgElement, "function");
});
