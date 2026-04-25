/**
 * CLI command: `infrasync fidelity`
 *
 * Reads a serialised adapter result JSON file and prints a human-readable
 * fidelity report. Works with output from any adapter — terraform-config
 * import/export, terraform-state, terraform-plan.
 */
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FidelityIssue {
  readonly path: string;
  readonly class: string;
  readonly message: string;
  readonly action: string;
}

interface FidelityReport {
  readonly overall: string;
  readonly issues: readonly FidelityIssue[];
}

interface AdapterResultDocument {
  readonly fidelity: FidelityReport;
  readonly warnings: readonly string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFidelityResult(
  value: unknown,
): value is { fidelity: FidelityReport; warnings?: unknown } {
  if (!isRecord(value)) return false;
  if (!isRecord(value.fidelity)) return false;
  if (typeof value.fidelity.overall !== "string") return false;
  if (!Array.isArray(value.fidelity.issues)) return false;
  return true;
}

function extractWarnings(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const raw: unknown = value.warnings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((w: unknown): w is string => typeof w === "string");
}

// ─── Report formatting ───────────────────────────────────────────────────────

function classIcon(cls: string): string {
  switch (cls) {
    case "lossless":
      return "✓";
    case "lossy":
      return "~";
    case "unsupported":
      return "✗";
    default:
      return "?";
  }
}

function overallLabel(cls: string): string {
  switch (cls) {
    case "lossless":
      return "Lossless — all semantics preserved";
    case "lossy":
      return "Lossy — some semantics approximated or stored in extensions";
    case "unsupported":
      return "Unsupported — safe mapping not possible for some constructs";
    default:
      return `Unknown (${cls})`;
  }
}

function formatReport(result: AdapterResultDocument): string {
  const { fidelity, warnings } = result;
  const lines: string[] = [];

  lines.push("Fidelity Report");
  lines.push("═══════════════");
  lines.push(
    `Overall: ${classIcon(fidelity.overall)} ${overallLabel(fidelity.overall)}`,
  );
  lines.push("");

  if (fidelity.issues.length === 0) {
    lines.push("No fidelity issues detected.");
  } else {
    lines.push(`Issues (${String(fidelity.issues.length)}):`);
    lines.push("─────────────────────────────────────────────────────────");
    for (const issue of fidelity.issues) {
      const icon = classIcon(issue.class);
      lines.push(`  ${icon} [${issue.class}] ${issue.path}`);
      lines.push(`     ${issue.message} (${issue.action})`);
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${String(warnings.length)}):`);
    lines.push("─────────────────────────────────────────────────────────");
    for (const warning of warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  return lines.join("\n");
}

// ─── Command entry point ─────────────────────────────────────────────────────

export async function runFidelityCommand(
  filePath: string,
  options: { readonly json?: boolean | undefined },
): Promise<void> {
  if (filePath === "") {
    console.error("Error: --file is required for the fidelity command.");
    process.exit(1);
  }

  const resolvedPath = resolve(filePath);
  console.log(`Reading adapter result from ${resolvedPath}...`);

  const raw = await readFile(resolvedPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  if (!isFidelityResult(parsed)) {
    console.error(
      "Error: file does not contain a valid fidelity report. Expected an adapter result with { fidelity: { overall, issues }, warnings }.",
    );
    process.exit(1);
  }

  const result: AdapterResultDocument = {
    fidelity: parsed.fidelity,
    warnings: extractWarnings(parsed),
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
  }
}
