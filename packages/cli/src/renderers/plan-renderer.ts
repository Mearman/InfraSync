/**
 * Plan rendering — produces human-readable, DOT, and JSON output for an ActionDag.
 *
 * Three output formats:
 * - Text: coloured terminal summary with per-action details and field diffs.
 * - DOT: Graphviz-compatible directed graph for visualisation.
 * - JSON: serialised ActionDag for --save-plan / --from-plan.
 */
import type { ActionDag, ActionNode } from "@infrasync-org/core/action-dag";
import { actionDagSchema } from "@infrasync-org/core/action-dag";

// ─── Action icons ────────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, string> = {
  create: "+",
  update: "~",
  delete: "-",
  "no-op": "=",
  read: "?",
};

// ─── Text renderer ───────────────────────────────────────────────────────────

/**
 * Render the plan as a human-readable text summary.
 *
 * Shows action counts, per-action details with field diffs,
 * and dependency ordering.
 */
export function renderPlanText(dag: ActionDag): string {
  const lines: string[] = [];

  const counts = countActions(dag.actions);
  const countParts: string[] = [];
  if (counts.create !== undefined && counts.create > 0)
    countParts.push(`${String(counts.create)} create`);
  if (counts.update !== undefined && counts.update > 0)
    countParts.push(`${String(counts.update)} update`);
  if (counts.delete !== undefined && counts.delete > 0)
    countParts.push(`${String(counts.delete)} delete`);
  if (counts["no-op"] !== undefined && counts["no-op"] > 0)
    countParts.push(`${String(counts["no-op"])} no-op`);
  if (counts.read !== undefined && counts.read > 0)
    countParts.push(`${String(counts.read)} read`);

  lines.push(
    `Plan: ${String(dag.actions.length)} actions (${countParts.join(", ")})`,
  );
  lines.push("");

  // Group actions by resource (for multi-step transitions)
  const byResource = groupByResource(dag.actions);

  for (const [resource, actions] of byResource) {
    for (const action of actions) {
      const icon = ACTION_ICONS[action.action] ?? "?";
      const kind = action.kind;
      lines.push(`${icon} ${kind} "${resource}" (${action.action})`);

      // Show field diffs for updates
      if (action.diff !== undefined && action.diff.length > 0) {
        for (const diff of action.diff) {
          lines.push(
            `    ${diff.path}: ${formatValue(diff.actual)} → ${formatValue(diff.desired)}`,
          );
        }
      }

      // Show deps for multi-step sequences
      if (action.deps.length > 0) {
        const depLabels = action.deps
          .filter(
            (d) =>
              !d.startsWith("transition:") && !d.startsWith("precondition:"),
          )
          .map((d) => d);
        if (depLabels.length > 0) {
          lines.push(`    depends on: ${depLabels.join(", ")}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ─── DOT renderer ────────────────────────────────────────────────────────────

/**
 * Render the plan as a DOT (Graphviz) directed graph.
 *
 * Each action node becomes a graph node. Dependency edges become
 * directed edges. Actions are colour-coded by type.
 */
export function renderPlanDot(dag: ActionDag): string {
  const lines: string[] = [];
  lines.push("digraph ActionDAG {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, style=filled, fontname="monospace"];');
  lines.push("");

  const actionColours: Record<string, string> = {
    create: "#d4edda", // green
    update: "#fff3cd", // yellow
    delete: "#f8d7da", // red
    "no-op": "#e2e3e5", // grey
    read: "#cce5ff", // blue
  };

  for (const action of dag.actions) {
    const colour = actionColours[action.action] ?? "#ffffff";
    const label = `${action.kind}\\n${action.resource}\\n(${action.action})`;
    lines.push(`  "${action.id}" [label="${label}", fillcolor="${colour}"];`);
  }

  lines.push("");

  for (const action of dag.actions) {
    for (const dep of action.deps) {
      lines.push(`  "${dep}" -> "${action.id}";`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}

// ─── JSON serialisation ──────────────────────────────────────────────────────

/**
 * Serialise an ActionDag to JSON string.
 *
 * The output can be deserialised with `parsePlan` and executed
 * via `--from-plan`.
 */
export function serialisePlan(dag: ActionDag): string {
  return JSON.stringify(dag, null, 2);
}

/**
 * Parse a serialised ActionDag, validating through the Zod schema.
 *
 * Returns the validated ActionDag or throws with a descriptive error.
 */
export function parsePlan(json: string): ActionDag {
  const raw: unknown = JSON.parse(json);
  const result = actionDagSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid plan file: ${issues}`);
  }
  return result.data;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countActions(actions: readonly ActionNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) {
    counts[action.action] = (counts[action.action] ?? 0) + 1;
  }
  return counts;
}

function groupByResource(
  actions: readonly ActionNode[],
): Map<string, ActionNode[]> {
  const groups = new Map<string, ActionNode[]>();
  for (const action of actions) {
    const list = groups.get(action.resource);
    if (list !== undefined) {
      list.push(action);
    } else {
      groups.set(action.resource, [action]);
    }
  }
  return groups;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
