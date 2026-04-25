import type { ResourceIR } from "./types.js";
import { DagCycleError } from "./errors.js";

// ─── DagNode ─────────────────────────────────────────────────────────────────

/** A resource and its dependency edges in the DAG. */
export interface DagNode {
  readonly resource: ResourceIR;
  /** Names of resources this node depends on (must be processed first) */
  readonly deps: ReadonlySet<string>;
}

// ─── Build DAG ───────────────────────────────────────────────────────────────

/**
 * Build DAG nodes from compiled resources.
 *
 * Edges come from two sources:
 * 1. Symbolic ref bindings — a ref in this resource's spec targets another resource
 * 2. Explicit dependsOn — declared ordering without attribute binding
 */
export function buildDag(resources: readonly ResourceIR[]): DagNode[] {
  return resources.map((resource) => {
    const deps = new Set<string>();

    const refBindings = resource.refBindings;
    if (refBindings !== undefined) {
      for (const binding of refBindings) {
        deps.add(binding.targetResource);
      }
    }

    const dependsOn = resource.dependsOn;
    if (dependsOn !== undefined) {
      for (const dep of dependsOn) {
        deps.add(dep);
      }
    }

    return { resource, deps };
  });
}

// ─── Topological sort by level ───────────────────────────────────────────────

/**
 * Topological sort grouped by depth level.
 *
 * Resources at the same level have no dependencies between them and can be
 * processed concurrently. Level 0 contains roots (no dependencies), level 1
 * contains resources that depend only on roots, and so on.
 *
 * Uses Kahn's algorithm. If any nodes remain unprocessed after the algorithm
 * completes, a cycle exists and a DagCycleError is thrown.
 */
export function topologicalSortByLevel(nodes: readonly DagNode[]): DagNode[][] {
  const nodeMap = new Map<string, DagNode>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const name = node.resource.name;
    nodeMap.set(name, node);
    inDegree.set(name, node.deps.size);
    if (!dependents.has(name)) {
      dependents.set(name, []);
    }

    for (const dep of node.deps) {
      const list = dependents.get(dep);
      if (list !== undefined) {
        list.push(name);
      } else {
        dependents.set(dep, [name]);
      }
    }
  }

  const levels: DagNode[][] = [];
  let queue: string[] = [];

  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  let processed = 0;

  while (queue.length > 0) {
    const level: DagNode[] = [];
    const nextQueue: string[] = [];

    for (const name of queue) {
      const node = nodeMap.get(name);
      if (node !== undefined) {
        level.push(node);
      }
      processed++;

      for (const dependent of dependents.get(name) ?? []) {
        const currentDegree = inDegree.get(dependent);
        if (currentDegree !== undefined) {
          const newDegree = currentDegree - 1;
          inDegree.set(dependent, newDegree);
          if (newDegree === 0) {
            nextQueue.push(dependent);
          }
        }
      }
    }

    if (level.length > 0) {
      levels.push(level);
    }
    queue = nextQueue;
  }

  if (processed < nodes.length) {
    throw new DagCycleError(findCycle(nodes));
  }

  return levels;
}

// ─── Cycle detection ─────────────────────────────────────────────────────────

/**
 * Find a cycle in the DAG using DFS with three-colour marking.
 *
 * Returns the cycle path (e.g. ["a", "b", "c", "a"]) or an empty array
 * if no cycle exists. An empty array should never be returned from this
 * function when called after Kahn's algorithm detects unprocessed nodes,
 * but the return type is honest about the possibility.
 */
function findCycle(nodes: readonly DagNode[]): readonly string[] {
  const nodeMap = new Map(nodes.map((n) => [n.resource.name, n]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const node of nodes) {
    const cycle = findCycleDfs(
      node.resource.name,
      nodeMap,
      visiting,
      visited,
      [],
    );
    if (cycle.length > 0) return cycle;
  }

  return [];
}

function findCycleDfs(
  name: string,
  nodeMap: Map<string, DagNode>,
  visiting: Set<string>,
  visited: Set<string>,
  path: readonly string[],
): readonly string[] {
  if (visited.has(name)) return [];
  if (visiting.has(name)) {
    const cycleStart = path.indexOf(name);
    if (cycleStart === -1) return [name, name];
    return [...path.slice(cycleStart), name];
  }

  const node = nodeMap.get(name);
  if (node === undefined) return [];

  visiting.add(name);
  const newPath = [...path, name];

  for (const dep of node.deps) {
    const cycle = findCycleDfs(dep, nodeMap, visiting, visited, newPath);
    if (cycle.length > 0) return cycle;
  }

  visiting.delete(name);
  visited.add(name);
  return [];
}
