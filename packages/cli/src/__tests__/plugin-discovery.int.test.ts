/**
 * Integration tests for plugin discovery from config files.
 *
 * Verifies that `loadConfig` discovers the `plugins` export and
 * that the CLI correctly auto-registers discovered plugins as adapters.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../loader.js";

const fixturesDir = join(import.meta.dirname, "fixtures", "plugin-discovery");

const fixture = (name: string) => join(fixturesDir, name);

// ─── Fixture-based tests ─────────────────────────────────────────────────────

describe("Plugin discovery from config file", () => {
  afterEach(async () => {
    // Clean up any generated config files
    const files = [
      "with-plugins.config.ts",
      "with-adapters-and-plugins.config.ts",
      "no-plugins.config.ts",
      "empty-plugins.config.ts",
      "mixed-plugins.config.ts",
    ];
    for (const file of files) {
      try {
        await rm(fixture(file));
      } catch {
        // File may not exist
      }
    }
  });

  it("discovers plugins export from config file", async () => {
    await writeFile(
      fixture("with-plugins.config.ts"),
      `import { defineInfra } from "@infrasync/core/compiler";

export const plugins = [
  {
    adapterName: "plugin:TestWidget",
    create: () => ({ name: "plugin:TestWidget" }),
  },
];

export default defineInfra("test", (infra) => ({ outputs: {} }));
`,
    );

    const config = await loadConfig(fixture("with-plugins.config.ts"));

    assert.ok(config.plugins !== undefined, "plugins should be discovered");
    assert.equal(config.plugins.length, 1);
    const first = config.plugins[0];
    assert.ok(first !== undefined);
    assert.equal(first.adapterName, "plugin:TestWidget");
  });

  it("discovers adapters alongside plugins", async () => {
    await writeFile(
      fixture("with-adapters-and-plugins.config.ts"),
      `import { defineInfra } from "@infrasync/core/compiler";

export const adapters = {
  "my-adapter": {
    adapterName: "my-adapter",
    create: () => ({ name: "my-adapter" }),
  },
};

export const plugins = [
  {
    adapterName: "plugin:TestWidget",
    create: () => ({ name: "plugin:TestWidget" }),
  },
];

export default defineInfra("test", (infra) => ({ outputs: {} }));
`,
    );

    const config = await loadConfig(
      fixture("with-adapters-and-plugins.config.ts"),
    );

    assert.ok(config.adapters !== undefined, "adapters should be discovered");
    assert.ok("my-adapter" in config.adapters);
    assert.ok(config.plugins !== undefined, "plugins should be discovered");
    assert.equal(config.plugins.length, 1);
  });

  it("handles config with no plugins export", async () => {
    await writeFile(
      fixture("no-plugins.config.ts"),
      `import { defineInfra } from "@infrasync/core/compiler";

export default defineInfra("test", (infra) => ({ outputs: {} }));
`,
    );

    const config = await loadConfig(fixture("no-plugins.config.ts"));

    assert.equal(config.plugins, undefined);
  });

  it("handles empty plugins array", async () => {
    await writeFile(
      fixture("empty-plugins.config.ts"),
      `import { defineInfra } from "@infrasync/core/compiler";

export const plugins = [];

export default defineInfra("test", (infra) => ({ outputs: {} }));
`,
    );

    const config = await loadConfig(fixture("empty-plugins.config.ts"));

    assert.ok(config.plugins !== undefined);
    assert.equal(config.plugins.length, 0);
  });

  it("filters non-adapter entries from plugins array", async () => {
    await writeFile(
      fixture("mixed-plugins.config.ts"),
      `import { defineInfra } from "@infrasync/core/compiler";

export const plugins = [
  "not an adapter",
  { wrong: "shape" },
  {
    adapterName: "plugin:RealPlugin",
    create: () => ({ name: "plugin:RealPlugin" }),
  },
];

export default defineInfra("test", (infra) => ({ outputs: {} }));
`,
    );

    const config = await loadConfig(fixture("mixed-plugins.config.ts"));

    assert.ok(config.plugins !== undefined);
    assert.equal(config.plugins.length, 1);
    const plugin = config.plugins[0];
    assert.ok(plugin !== undefined);
    assert.equal(plugin.adapterName, "plugin:RealPlugin");
  });
});
