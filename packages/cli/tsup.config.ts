import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    loader: "src/loader.ts",
    registry: "src/registry.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  outDir: "dist",
  external: ["jiti"],
});
