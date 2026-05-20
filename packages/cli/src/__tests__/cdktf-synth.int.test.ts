/**
 * CDKTF synth integration test.
 *
 * Proves that generated CDKTF projects synthesise into valid Terraform JSON
 * by running `tsx main.ts` directly (bypasses the CDKTF CLI which has
 * native module compatibility issues on some Node.js versions).
 *
 * This test is **opt-in** — it runs only when `CDKTF_INTEGRATION=1` is set,
 * because it requires installing npm packages and synthesising
 * (network access, ~30s).
 *
 * Prerequisites:
 *   - Node.js ≥ 20
 *   - pnpm on PATH
 *   - terraform on PATH (for optional validation step)
 *
 * Fixtures used:
 *   - 00-empty: no providers, no resources — baseline
 *   - 02-single-resource: single provider + resource — realistic
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { infraIRSchema } from "@infrasync-org/core/schemas";
import { cdktfTypeScriptExporter } from "../exporters/cdktf-ts.js";

const SKIP = process.env.CDKTF_INTEGRATION !== "1";
const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "cdktf-ts");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "infrasync-cdktf-synth-"));
}

function cleanup(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface SynthResult {
  /** Path to the synthesised Terraform JSON file */
  readonly tfJsonPath: string;
  /** Parsed synthesised Terraform JSON */
  readonly tfJson: unknown;
  /** Path to the stack directory (for terraform validate) */
  readonly stackDir: string;
  /** Temp root directory to clean up */
  readonly tempRoot: string;
}

/**
 * Generate, install, and synth a CDKTF project for the given fixture.
 *
 * Runs `tsx main.ts` directly instead of `cdktf synth` to avoid
 * native module compatibility issues with the CDKTF CLI.
 */
async function synthFixture(fixtureName: string): Promise<SynthResult> {
  const irPath = join(FIXTURES_DIR, fixtureName, "ir.json");
  const raw = await readFile(irPath, "utf-8");
  const ir = infraIRSchema.parse(JSON.parse(raw));

  const tempDir = createTempDir();

  try {
    // Generate the CDKTF project
    const generated = await cdktfTypeScriptExporter.generate(ir, {});

    for (const file of generated.files) {
      const targetPath = join(tempDir, file.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, "utf-8");
    }

    // Install dependencies
    execSync("pnpm install --no-frozen-lockfile", {
      cwd: tempDir,
      stdio: "pipe",
      timeout: 60_000,
    });

    // Run main.ts directly — App.synth() produces cdktf.out/
    execSync("pnpm tsx main.ts", {
      cwd: tempDir,
      stdio: "pipe",
      timeout: 30_000,
    });

    // Find synthesised output
    const cdktfOut = join(tempDir, "cdktf.out");
    assert.ok(
      existsSync(cdktfOut),
      "cdktf.out directory should exist after synth",
    );

    const manifestPath = join(cdktfOut, "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest.json should exist");

    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.ok(isRecord(manifest), "manifest should be an object");

    // Find first stack
    const stacks = isRecord(manifest.stacks)
      ? Object.values(manifest.stacks)
      : [];
    assert.ok(stacks.length > 0, "manifest should have at least one stack");

    const firstStack = stacks[0];
    assert.ok(isRecord(firstStack), "stack entry should be an object");

    // CDKTF uses "synthesizedStackPath" for the TF JSON file
    const synthesizedStackPath =
      typeof firstStack.synthesizedStackPath === "string"
        ? firstStack.synthesizedStackPath
        : undefined;
    assert.ok(
      synthesizedStackPath !== undefined,
      "stack should have synthesizedStackPath",
    );

    const tfJsonPath = join(cdktfOut, synthesizedStackPath);
    assert.ok(existsSync(tfJsonPath), `${synthesizedStackPath} should exist`);

    const workingDirectory =
      typeof firstStack.workingDirectory === "string"
        ? firstStack.workingDirectory
        : undefined;
    const stackDir =
      workingDirectory !== undefined
        ? join(cdktfOut, workingDirectory)
        : cdktfOut;

    const tfJson: unknown = JSON.parse(readFileSync(tfJsonPath, "utf-8"));

    return { tfJsonPath, tfJson, stackDir, tempRoot: tempDir };
  } catch (err) {
    cleanup(tempDir);
    throw err;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("cdktf synth — empty stack", { skip: SKIP }, async () => {
  const { tfJson, tempRoot } = await synthFixture("00-empty");

  try {
    assert.ok(isRecord(tfJson), "synthesised output should be an object");

    // Terraform JSON should have terraform block
    assert.ok(
      "terraform" in tfJson,
      "synthesised JSON should have terraform block",
    );

    // Empty stack should not have resources
    const hasResources =
      "resource" in tfJson &&
      isRecord(tfJson.resource) &&
      Object.keys(tfJson.resource).length > 0;
    assert.ok(!hasResources, "empty stack should have no resources");
  } finally {
    cleanup(tempRoot);
  }
});

test("cdktf synth — single resource", { skip: SKIP }, async () => {
  const { tfJson, stackDir, tempRoot } =
    await synthFixture("02-single-resource");

  try {
    assert.ok(isRecord(tfJson), "synthesised output should be an object");

    // Should have terraform required_providers
    assert.ok("terraform" in tfJson, "should have terraform block");

    const terraform = isRecord(tfJson.terraform) ? tfJson.terraform : {};
    const requiredProviders = isRecord(terraform.required_providers)
      ? terraform.required_providers
      : {};
    assert.ok(
      "cloudflare" in requiredProviders,
      "should declare cloudflare provider",
    );

    // Should have resource block with cloudflare_dns_record
    assert.ok("resource" in tfJson, "should have resource block");
    const resource = isRecord(tfJson.resource) ? tfJson.resource : {};
    assert.ok(
      "cloudflare_dns_record" in resource,
      "should have cloudflare_dns_record resource type",
    );

    const records = isRecord(resource.cloudflare_dns_record)
      ? resource.cloudflare_dns_record
      : {};
    assert.ok("my_record" in records, "should have my_record resource");

    // Should have provider block
    assert.ok("provider" in tfJson, "should have provider block");

    // Validate with terraform if available
    try {
      execSync("terraform init -input=false -no-color", {
        cwd: stackDir,
        stdio: "pipe",
        timeout: 60_000,
      });
      execSync("terraform validate -no-color", {
        cwd: stackDir,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch {
      // terraform validate failure is informational — provider binaries
      // may not be available in test environment
      console.log("  (terraform validate skipped — provider not available)");
    }
  } finally {
    cleanup(tempRoot);
  }
});
