import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/types.ts",
    "src/errors.ts",
    "src/refs.ts",
    "src/provider.ts",
    "src/resource.ts",
    "src/dag.ts",
    "src/plan.ts",
    "src/sync.ts",
    "src/assert-sdk.ts",
    "src/dns-record.ts",
    "src/compiler.ts",
    "src/declarative.ts",
    "src/handles.ts",
    "src/infra.ts",
  ],
  format: "esm",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
});
