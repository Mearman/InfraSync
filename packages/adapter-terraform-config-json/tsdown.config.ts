import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/*.ts", "!src/**/__tests__/**"],
  format: "esm",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
});
