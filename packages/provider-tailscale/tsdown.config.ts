import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/*.ts"],
  format: "esm",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
});
