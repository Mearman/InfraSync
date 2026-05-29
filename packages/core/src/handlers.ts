/**
 * Handlers — change-triggered post-apply side effects.
 *
 * Handlers run *after* Phase 3 (execute), triggered by changes to specific
 * resources. They are not part of the DAG — they are side effects like
 * notifications, cache purges, and webhooks.
 *
 * Key constraints:
 * - Each handler runs at most once per apply, even if multiple triggering
 *   resources changed.
 * - Handler failures are reported in SyncResult but don't roll back the apply.
 * - Handlers run only in "apply" mode, not "plan" mode.
 * - Handler `run` functions are not serialisable — they can't be saved to
 *   plan files.
 */

import type { FieldDiff } from "./resource.js";
import type { PlanAction } from "./action-dag.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The actions a handler can trigger on. */
export type HandlerAction = "create" | "update" | "delete";

/**
 * Describes which resource change triggered a handler, including the
 * action performed and the field-level diff.
 */
export interface TriggeredOutcome {
  readonly resource: string;
  readonly action: PlanAction;
  readonly diff: readonly FieldDiff[];
}

/**
 * The result of running a single handler.
 */
export interface HandlerOutcome {
  readonly handler: string;
  readonly triggeredResources: readonly string[];
  readonly status: "success" | "failed";
  readonly error?: string;
}

/**
 * A handler definition — a post-apply side effect triggered by resource changes.
 *
 * Declared in the authoring API and registered on InfraScope. Collected
 * separately from the serialisable IR because `run` contains a function.
 */
export interface InfraHandler {
  /** Unique handler name for identification and logging. */
  readonly name: string;

  /**
   * Resource names that trigger this handler. Use "*" to match all resources.
   * A handler runs if *any* of its trigger resources changed with a matching action.
   */
  readonly triggers: readonly string[];

  /**
   * Which actions trigger this handler. Omit to trigger on all actions.
   */
  readonly on?: readonly HandlerAction[];

  /**
   * The side-effect function. Receives all triggering outcomes.
   * Runs at most once per apply even if multiple triggering resources changed.
   */
  readonly run: (outcomes: readonly TriggeredOutcome[]) => Promise<void>;
}

// ─── Handler execution ───────────────────────────────────────────────────────

/**
 * Matches resource outcomes to handler triggers and executes matched handlers.
 *
 * - Each handler runs at most once per apply.
 * - Handlers run in declaration order.
 * - Handler failures are reported but don't affect other handlers.
 * - No-op outcomes are excluded — handlers only see meaningful changes.
 */
export async function executeHandlers(
  handlers: readonly InfraHandler[],
  outcomes: readonly {
    readonly name: string;
    readonly action: PlanAction;
    readonly diff: readonly FieldDiff[];
  }[],
): Promise<readonly HandlerOutcome[]> {
  // Filter to meaningful actions only (exclude no-op and read)
  const changedOutcomes = outcomes.filter(
    (o) =>
      o.action === "create" || o.action === "update" || o.action === "delete",
  );

  if (changedOutcomes.length === 0 || handlers.length === 0) {
    return [];
  }

  const handlerOutcomes: HandlerOutcome[] = [];

  for (const handler of handlers) {
    const triggered = matchTriggers(handler, changedOutcomes);

    if (triggered.length === 0) {
      continue;
    }

    try {
      await handler.run(triggered);
      handlerOutcomes.push({
        handler: handler.name,
        triggeredResources: triggered.map((t) => t.resource),
        status: "success",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handlerOutcomes.push({
        handler: handler.name,
        triggeredResources: triggered.map((t) => t.resource),
        status: "failed",
        error: message,
      });
    }
  }

  return handlerOutcomes;
}

// ─── Trigger matching ────────────────────────────────────────────────────────

/**
 * Determine which changed outcomes match a handler's triggers.
 *
 * A handler triggers if:
 * 1. One of its trigger resource names matches a changed outcome
 *    (or triggers includes "*" for wildcard matching), AND
 * 2. The outcome's action is in the handler's `on` list
 *    (or `on` is omitted/empty, meaning all actions match).
 */
function matchTriggers(
  handler: InfraHandler,
  changedOutcomes: readonly {
    readonly name: string;
    readonly action: PlanAction;
    readonly diff: readonly FieldDiff[];
  }[],
): readonly TriggeredOutcome[] {
  const wildcard = handler.triggers.includes("*");
  const allowedActions = handler.on;

  const matched: TriggeredOutcome[] = [];

  for (const outcome of changedOutcomes) {
    // Check trigger match (wildcard or explicit resource name)
    const triggerMatch = wildcard || handler.triggers.includes(outcome.name);
    if (!triggerMatch) continue;

    // Check action match (omit/empty on means all actions)
    if (allowedActions !== undefined && allowedActions.length > 0) {
      if (!allowedActions.some((a) => a === outcome.action)) {
        continue;
      }
    }

    matched.push({
      resource: outcome.name,
      action: outcome.action,
      diff: outcome.diff,
    });
  }

  return matched;
}
