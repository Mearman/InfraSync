/**
 * Attribute-level deep differ.
 *
 * Recursively compares two values and produces AttributeDiff entries
 * classified by the plugin registry's safety rules.
 */
import type {
  AttributeDiff,
  SafetyClassification,
  SafetyRule,
  MigrationDirection,
  ResourceAction,
} from "./schemas.js";

interface DiffOptions {
  basePath: string;
  before: unknown;
  after: unknown;
  rules: readonly SafetyRule[];
  direction: MigrationDirection;
  action: ResourceAction;
}

interface ClassificationResult {
  safety: SafetyClassification;
  mitigation?:
    | "create-before-destroy"
    | "destroy-before-create"
    | "in-place-replace"
    | "none";
}

/**
 * Deep-diff two values, producing an AttributeDiff for each leaf-level change.
 */
export function diffAttributes(options: DiffOptions): AttributeDiff[] {
  const { basePath, before, after, rules, direction, action } = options;

  // Both null/undefined or both identical — no diff
  if (before === after) return [];
  if (before === undefined && after === undefined) return [];

  // One side undefined — attribute added or removed
  if (before === undefined || after === undefined) {
    const classification = classifyAttribute(
      basePath,
      before,
      after,
      rules,
      direction,
      action,
    );
    return [
      {
        path: basePath,
        before,
        after,
        safety: classification.safety,
        rule: before === undefined ? "attribute-added" : "attribute-removed",
        ...(classification.mitigation !== undefined
          ? { mitigation: classification.mitigation }
          : {}),
      },
    ];
  }

  // Type mismatch at leaf
  if (typeof before !== typeof after) {
    const classification = classifyAttribute(
      basePath,
      before,
      after,
      rules,
      direction,
      action,
    );
    return [
      {
        path: basePath,
        before,
        after,
        safety: classification.safety,
        rule: "type-mismatch",
        ...(classification.mitigation !== undefined
          ? { mitigation: classification.mitigation }
          : {}),
      },
    ];
  }

  // Primitive comparison
  if (
    typeof before !== "object" ||
    typeof after !== "object" ||
    before === null ||
    after === null
  ) {
    if (before === after) return [];
    const classification = classifyAttribute(
      basePath,
      before,
      after,
      rules,
      direction,
      action,
    );
    return [
      {
        path: basePath,
        before,
        after,
        safety: classification.safety,
        rule: "value-changed",
        ...(classification.mitigation !== undefined
          ? { mitigation: classification.mitigation }
          : {}),
      },
    ];
  }

  // Array comparison
  if (Array.isArray(before) && Array.isArray(after)) {
    return diffArrays({
      basePath,
      before,
      after,
      rules,
      direction,
      action,
    });
  }

  // If one is array and other isn't, treat as leaf diff
  if (Array.isArray(before) !== Array.isArray(after)) {
    const classification = classifyAttribute(
      basePath,
      before,
      after,
      rules,
      direction,
      action,
    );
    return [
      {
        path: basePath,
        before,
        after,
        safety: classification.safety,
        rule: "structure-mismatch",
        ...(classification.mitigation !== undefined
          ? { mitigation: classification.mitigation }
          : {}),
      },
    ];
  }

  // Object comparison — recurse into keys
  const diffs: AttributeDiff[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const childPath = `${basePath}.${key}`;
    const bv = isRecord(before) ? before[key] : undefined;
    const av = isRecord(after) ? after[key] : undefined;

    const childDiffs = diffAttributes({
      basePath: childPath,
      before: bv,
      after: av,
      rules,
      direction,
      action,
    });
    diffs.push(...childDiffs);
  }

  return diffs;
}

function diffArrays(
  options: DiffOptions & {
    before: readonly unknown[];
    after: readonly unknown[];
  },
): AttributeDiff[] {
  const { basePath, before, after, rules, direction, action } = options;
  const diffs: AttributeDiff[] = [];

  const maxLen = Math.max(before.length, after.length);
  for (let i = 0; i < maxLen; i++) {
    const childPath = `${basePath}[${String(i)}]`;
    const bv = i < before.length ? before[i] : undefined;
    const av = i < after.length ? after[i] : undefined;

    const childDiffs = diffAttributes({
      basePath: childPath,
      before: bv,
      after: av,
      rules,
      direction,
      action,
    });
    diffs.push(...childDiffs);
  }

  if (before.length !== after.length) {
    const classification = classifyAttribute(
      basePath,
      before.length,
      after.length,
      rules,
      direction,
      action,
    );
    diffs.push({
      path: `${basePath}.length`,
      before: before.length,
      after: after.length,
      safety: classification.safety,
      rule: "array-length-changed",
      ...(classification.mitigation !== undefined
        ? { mitigation: classification.mitigation }
        : {}),
    });
  }

  return diffs;
}

/**
 * Classify an attribute change using the plugin safety rules.
 * Falls back to generic heuristics if no rule matches.
 */
function classifyAttribute(
  path: string,
  before: unknown,
  after: unknown,
  rules: readonly SafetyRule[],
  direction: MigrationDirection,
  action: ResourceAction,
): ClassificationResult {
  // Check plugin rules first
  for (const rule of rules) {
    const pathMatches = rule.pathIsRegex
      ? new RegExp(rule.path).test(path)
      : rule.path === path;

    if (!pathMatches) continue;
    if (rule.direction !== "both" && rule.direction !== direction) continue;
    if (rule.actions.length > 0 && !rule.actions.includes(action)) continue;

    return {
      safety: rule.severity,
      ...(rule.mitigation !== undefined ? { mitigation: rule.mitigation } : {}),
    };
  }

  // Generic fallback heuristics
  return genericClassify(path, before, after);
}

/**
 * Generic safety classification heuristics applied when no plugin rule matches.
 */
function genericClassify(
  path: string,
  before: unknown,
  after: unknown,
): ClassificationResult {
  // Identifier changes are destructive but can use CBD
  const identifierSuffixes = [".id", ".zone_id", ".name", ".bucket", ".region"];
  for (const suffix of identifierSuffixes) {
    if (path.endsWith(suffix)) {
      return {
        safety: "destructive",
        mitigation: "create-before-destroy",
      };
    }
  }

  // Attribute removed — risky (potential data loss)
  if (after === undefined) return { safety: "risky" };

  // Attribute added — safe
  if (before === undefined) return { safety: "safe" };

  // Type mismatch — risky
  if (typeof before !== typeof after) return { safety: "risky" };

  // Default — safe
  return { safety: "safe" };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
