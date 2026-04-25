/**
 * Utility for running `terraform show -json` on a binary plan or state file.
 *
 * Provides convenience for the CLI — users can pass `--planfile tfplan`
 * instead of manually running `terraform show -json tfplan > plan.json`.
 */
import { execSync } from "node:child_process";

/**
 * Run `terraform show -json <path>` and return the JSON output.
 *
 * @throws Error if terraform is not on PATH or the command fails.
 */
export function runTerraformShowJson(filePath: string): string {
  try {
    return execSync(`terraform show -json ${escapeShellArg(filePath)}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (err: unknown) {
    if (err instanceof Error && "status" in err && err.status === 127) {
      throw new Error(
        "terraform binary not found on PATH. Install Terraform or use --file with a pre-generated JSON file instead.",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `terraform show -json failed: ${message}\n\nHint: You can pre-generate the JSON file manually:\n  terraform show -json ${filePath} > plan.json\n  infrasync import terraform-plan --file plan.json`,
    );
  }
}

/**
 * Check if terraform is available on PATH.
 */
export function isTerraformAvailable(): boolean {
  try {
    execSync("terraform version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function escapeShellArg(arg: string): string {
  // Single-quote escape — safest for shell arguments
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
