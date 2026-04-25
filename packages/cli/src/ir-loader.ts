import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as z from "zod";

// ─── IR Schema ───────────────────────────────────────────────────────────────

const refBindingIRSchema = z.object({
  specPath: z.string().trim().min(1),
  targetResource: z.string().trim().min(1),
  statePath: z.string().trim().min(1),
});

export const infraIRSchema = z.object({
  name: z.string().trim().min(1),
  providers: z.array(
    z.object({
      key: z.string().trim().min(1),
      adapterName: z.string().trim().min(1),
      config: z.record(z.string().trim(), z.unknown()),
    }),
  ),
  resources: z.array(
    z.object({
      name: z.string().trim().min(1),
      provider: z.string().trim().min(1),
      kind: z.string().trim().min(1),
      mode: z.enum(["manage", "read"]),
      spec: z.record(z.string().trim(), z.unknown()),
      dependsOn: z.array(z.string().trim()),
      refBindings: z.array(refBindingIRSchema),
    }),
  ),
});

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Load and validate a serialised InfraIR JSON file.
 *
 * Reads the file, parses JSON, and validates the shape against
 * the IR schema. Returns validated data ready for the sync engine.
 *
 * @param irPath - Path to the JSON file
 * @returns Validated InfraIR
 * @throws Error if the file cannot be read, parsed, or validated
 */
export async function loadIR(
  irPath: string,
): Promise<z.infer<typeof infraIRSchema>> {
  const absolute = resolve(irPath);
  const raw = await readFile(absolute, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON from "${absolute}"`);
  }

  const result = infraIRSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join(".");
        return path.length > 0
          ? `  ${path}: ${issue.message}`
          : `  ${issue.message}`;
      })
      .join("\n");
    throw new Error(`Invalid InfraIR in "${absolute}":\n${issues}`);
  }

  return result.data;
}
