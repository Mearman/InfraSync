/**
 * Golden tests for the CDKTF TypeScript exporter.
 *
 * Each fixture directory under `fixtures/cdktf-ts/` contains:
 *   - `ir.json`: the InfraIR input
 *   - `options.json` (optional): CdktfTypeScriptExportOptions overrides
 *   - `golden/`: expected output files written by the exporter
 *
 * Run with `UPDATE_GOLDEN=1` to regenerate golden files from current exporter output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { infraIRSchema } from "@infrasync/core/schemas";
import type { InfraIR } from "@infrasync/core/types";
import { cdktfTypeScriptExporter } from "../exporters/cdktf-ts.js";
import type { CdktfTypeScriptExportOptions } from "../exporters/cdktf-ts.js";

const cdktfOptionsSchema = z.object({
  stackName: z.string().trim().optional(),
  providerSources: z.record(z.string().trim(), z.string().trim()).optional(),
});

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "cdktf-ts");
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

interface Fixture {
  readonly name: string;
  readonly dir: string;
  readonly ir: InfraIR;
  readonly options: CdktfTypeScriptExportOptions;
}

const GOLDEN_FILES = [
  "main.ts",
  "cdktf.json",
  "package.json",
  "tsconfig.json",
  "README.md",
  ".gitignore",
] as const;

// ─── Type guard for warnings fixture ────────────────────────────────────────

function isWarningArray(
  value: unknown,
): value is readonly { readonly code: string; readonly message: string }[] {
  if (!Array.isArray(value)) return false;
  return value.every((item): boolean => isWarningEntry(item));
}

function isWarningEntry(
  value: unknown,
): value is { readonly code: string; readonly message: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  if (!("code" in candidate) || !("message" in candidate)) return false;
  const codeValue = candidate.code;
  const messageValue = candidate.message;
  return typeof codeValue === "string" && typeof messageValue === "string";
}

async function loadFixtures(): Promise<readonly Fixture[]> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const fixtures: Fixture[] = [];

  for (const dirName of dirs) {
    const dir = join(FIXTURES_DIR, dirName);
    const irPath = join(dir, "ir.json");
    const optionsPath = join(dir, "options.json");

    const irRaw = await readFile(irPath, "utf-8");
    const irParsed: unknown = JSON.parse(irRaw);
    const ir = infraIRSchema.parse(irParsed);

    let options: CdktfTypeScriptExportOptions = {};
    try {
      const optionsRaw = await readFile(optionsPath, "utf-8");
      const optionsParsed: unknown = JSON.parse(optionsRaw);
      const parsed = cdktfOptionsSchema.safeParse(optionsParsed);
      if (parsed.success) {
        options = parsed.data;
      }
    } catch {
      // No options file — use defaults
    }

    fixtures.push({ name: dirName, dir, ir, options });
  }

  return fixtures;
}

async function readGoldenFile(
  goldenDir: string,
  fileName: string,
): Promise<string> {
  return readFile(join(goldenDir, fileName), "utf-8");
}

async function writeGoldenFile(
  goldenDir: string,
  fileName: string,
  content: string,
): Promise<void> {
  await mkdir(goldenDir, { recursive: true });
  await writeFile(join(goldenDir, fileName), content, "utf-8");
}

function buildFileMap(
  files: readonly { readonly path: string; readonly content: string }[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    map.set(file.path, file.content);
  }
  return map;
}

const fixtures = await loadFixtures();

for (const fixture of fixtures) {
  test(`golden: ${fixture.name}`, async () => {
    const result = await cdktfTypeScriptExporter.generate(
      fixture.ir,
      fixture.options,
    );

    const generatedFiles = buildFileMap(result.files);
    const goldenDir = join(fixture.dir, "golden");

    // Verify exporter produced the expected set of files
    const generatedPaths = [...generatedFiles.keys()].sort();
    const expectedPaths = [...GOLDEN_FILES].sort();
    assert.deepEqual(
      generatedPaths,
      expectedPaths,
      `Generated file list does not match expected golden file list`,
    );

    if (UPDATE_GOLDEN) {
      for (const fileName of GOLDEN_FILES) {
        const content = generatedFiles.get(fileName);
        assert.ok(content !== undefined, `Missing generated file: ${fileName}`);
        await writeGoldenFile(goldenDir, fileName, content);
      }

      await writeGoldenFile(
        goldenDir,
        "warnings.json",
        JSON.stringify(result.warnings, null, 2) + "\n",
      );
      return;
    }

    // Compare each golden file against generated output
    for (const fileName of GOLDEN_FILES) {
      const generated = generatedFiles.get(fileName);
      assert.ok(generated !== undefined, `Missing generated file: ${fileName}`);

      const golden = await readGoldenFile(goldenDir, fileName);
      assert.equal(
        generated,
        golden,
        `Golden mismatch for ${fixture.name}/${fileName}`,
      );
    }

    // Compare warnings
    const goldenWarningsRaw = await readGoldenFile(goldenDir, "warnings.json");
    const goldenWarningsParsed: unknown = JSON.parse(goldenWarningsRaw);
    if (!isWarningArray(goldenWarningsParsed)) {
      throw new Error(
        `Invalid warnings fixture: ${fixture.name}/golden/warnings.json`,
      );
    }
    const goldenWarnings = goldenWarningsParsed;

    assert.deepEqual(
      result.warnings,
      goldenWarnings,
      `Warnings mismatch for ${fixture.name}`,
    );
  });
}

// ─── Structural tests (behaviour verification beyond golden matching) ────────

test("exporter rejects unknown adapter without provider source", async () => {
  const ir: InfraIR = {
    name: "fail-test",
    providers: [{ key: "custom", adapterName: "my-custom", config: {} }],
    resources: [],
  };

  await assert.rejects(async () => {
    cdktfTypeScriptExporter.generate(ir, {});
  }, /No Terraform provider source mapping for adapter "my-custom"/);
});

test("exporter accepts custom provider source override", async () => {
  const ir: InfraIR = {
    name: "override-test",
    providers: [{ key: "custom", adapterName: "my-custom", config: {} }],
    resources: [],
  };

  const result = await cdktfTypeScriptExporter.generate(ir, {
    providerSources: { "my-custom": "acme/my-custom" },
  });

  assert.equal(result.files.length, 6);
  assert.equal(result.warnings.length, 0);

  const mainTs = result.files.find((f) => f.path === "main.ts");
  assert.ok(mainTs !== undefined);
  assert.ok(
    mainTs.content.includes('"acme/my-custom"'),
    "Custom provider source should appear in generated main.ts",
  );
});

test("exporter rejects duplicate provider instance keys", async () => {
  const ir: InfraIR = {
    name: "dupe-test",
    providers: [
      { key: "cf", adapterName: "cloudflare", config: {} },
      { key: "cf", adapterName: "cloudflare", config: {} },
    ],
    resources: [],
  };

  await assert.rejects(async () => {
    cdktfTypeScriptExporter.generate(ir, {});
  }, /Duplicate provider instance key "cf"/);
});

test("exporter rejects resource referencing unknown provider", async () => {
  const ir: InfraIR = {
    name: "unknown-provider-test",
    providers: [],
    resources: [
      {
        name: "orphan",
        provider: "nonexistent",
        kind: "Thing",
        mode: "manage",
        spec: {},
        dependsOn: [],
        refBindings: [],
      },
    ],
  };

  await assert.rejects(async () => {
    cdktfTypeScriptExporter.generate(ir, {});
  }, /references unknown provider instance "nonexistent"/);
});

test("exporter rejects resource with dependsOn referencing unknown resource", async () => {
  const ir: InfraIR = {
    name: "bad-dep-test",
    providers: [{ key: "cf", adapterName: "cloudflare", config: {} }],
    resources: [
      {
        name: "thing",
        provider: "cf",
        kind: "Thing",
        mode: "manage",
        spec: { kind: "Thing" },
        dependsOn: ["nonexistent"],
        refBindings: [],
      },
    ],
  };

  await assert.rejects(async () => {
    cdktfTypeScriptExporter.generate(ir, {});
  }, /depends on unknown resource "nonexistent"/);
});

test("exporter rejects RefToken without resource graph context (top-level spec)", async () => {
  // A provider config that contains a $ref — refs in provider config have no
  // resource graph context, so they must fail.
  const ir: InfraIR = {
    name: "ref-in-provider-test",
    providers: [
      {
        key: "cf",
        adapterName: "cloudflare",
        config: {
          zoneId: { $ref: { resource: "zone", path: "id" } },
        },
      },
    ],
    resources: [],
  };

  await assert.rejects(async () => {
    cdktfTypeScriptExporter.generate(ir, {});
  }, /RefToken cannot be translated without resource graph context/);
});

test("exporter rejects duplicate resource names", async () => {
  const ir: InfraIR = {
    name: "dupe-resource-test",
    providers: [{ key: "cf", adapterName: "cloudflare", config: {} }],
    resources: [
      {
        name: "thing",
        provider: "cf",
        kind: "DnsRecord",
        mode: "manage",
        spec: { kind: "DnsRecord", name: "a" },
        dependsOn: [],
        refBindings: [],
      },
      {
        name: "thing",
        provider: "cf",
        kind: "DnsRecord",
        mode: "manage",
        spec: { kind: "DnsRecord", name: "b" },
        dependsOn: [],
        refBindings: [],
      },
    ],
  };

  await assert.rejects(async () => {
    cdktfTypeScriptExporter.generate(ir, {});
  }, /Duplicate resource name "thing"/);
});

test("exporter uses stack name override in class and stack ID", async () => {
  const ir: InfraIR = {
    name: "original",
    providers: [],
    resources: [],
  };

  const result = await cdktfTypeScriptExporter.generate(ir, {
    stackName: "custom-stack",
  });

  const mainTs = result.files.find((f) => f.path === "main.ts");
  assert.ok(mainTs !== undefined);
  assert.ok(
    mainTs.content.includes("CustomStackStack"),
    "Stack class name should be derived from custom stack name",
  );
  assert.ok(
    mainTs.content.includes('"custom_stack"'),
    "Stack ID should use sanitised custom stack name",
  );
});
