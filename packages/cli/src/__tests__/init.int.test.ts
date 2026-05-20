/**
 * Integration tests for `infrasync init` scaffolding.
 *
 * Tests template generation (non-interactive) by running the command
 * with --name, --provider, and --outdir flags, then verifying the
 * generated files have correct structure and content.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isRecord } from "@infrasync-org/core/resource";
import { runInitCommand } from "../commands/init.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "infrasync-init-test-"));
}

describe("infrasync init", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates all required files", async () => {
    await runInitCommand([
      "--name",
      "test-project",
      "--provider",
      "cloudflare",
      "--outdir",
      tempDir,
    ]);

    const rawPackageJson: unknown = JSON.parse(
      await readFile(join(tempDir, "package.json"), "utf-8"),
    );
    assert.ok(isRecord(rawPackageJson));
    const name = rawPackageJson.name;
    assert.equal(typeof name, "string");
    assert.equal(name, "test-project");
    assert.equal(rawPackageJson.type, "module");
    const deps = rawPackageJson.dependencies;
    assert.ok(isRecord(deps));
    assert.ok(
      "@infrasync-org/cloudflare" in deps,
      "must include cloudflare provider",
    );
    assert.ok("@infrasync-org/core" in deps, "must include core");
    const scripts = rawPackageJson.scripts;
    assert.ok(isRecord(scripts));
    assert.ok("plan" in scripts, "must have plan script");
  });

  it("generates valid tsconfig.json", async () => {
    await runInitCommand([
      "--name",
      "test-project",
      "--provider",
      "cloudflare",
      "--outdir",
      tempDir,
    ]);

    const rawTsconfig: unknown = JSON.parse(
      await readFile(join(tempDir, "tsconfig.json"), "utf-8"),
    );
    assert.ok(isRecord(rawTsconfig));
    const compilerOptions = rawTsconfig.compilerOptions;
    assert.ok(isRecord(compilerOptions));
    assert.equal(compilerOptions.strict, true);
    assert.equal(compilerOptions.module, "Node16");
  });

  it("generates infra.config.ts with cloudflare provider", async () => {
    await runInitCommand([
      "--name",
      "test-project",
      "--provider",
      "cloudflare",
      "--outdir",
      tempDir,
    ]);

    const config = await readFile(join(tempDir, "infra.config.ts"), "utf-8");
    assert.ok(config.includes("defineInfra"));
    assert.ok(config.includes("@infrasync-org/cloudflare"));
    assert.ok(config.includes("DnsRecord"));
    assert.ok(config.includes("CF_API_TOKEN"));
  });

  it("generates .tool-versions with node entry", async () => {
    await runInitCommand([
      "--name",
      "test-project",
      "--provider",
      "cloudflare",
      "--outdir",
      tempDir,
    ]);

    const toolVersions = await readFile(
      join(tempDir, ".tool-versions"),
      "utf-8",
    );
    assert.ok(toolVersions.startsWith("node "));
  });

  it("throws for unknown provider", async () => {
    await assert.rejects(
      () =>
        runInitCommand([
          "--name",
          "test-project",
          "--provider",
          "nonexistent",
          "--outdir",
          tempDir,
        ]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Unknown provider/);
        return true;
      },
    );
  });
});
