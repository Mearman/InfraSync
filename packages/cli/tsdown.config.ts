import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/loader.ts", "src/registry.ts"],
  format: "esm",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["jiti"],
});
