import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/handle.ts",
    "src/helpers.ts",
    "src/dns-record.ts",
    "src/access-app.ts",
    "src/access-policy.ts",
    "src/identity-provider.ts",
    "src/pages-domain.ts",
  ],
  format: "esm",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
});
