import { defineConfig } from "tsup";
import { globSync } from "node:fs";

const entries = Object.fromEntries(
  globSync("src/*.ts", { cwd: process.cwd() })
    .filter((f) => !f.includes("__tests__"))
    .map((file) => {
      const name = file.replace("src/", "").replace(".ts", "");
      return [name, file];
    }),
);

export default defineConfig({
  entry: entries,
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  outDir: "dist",
});
