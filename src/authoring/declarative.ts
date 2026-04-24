import type { DeclarativeFragment, DeclarativeResource } from "./infra.js";

/**
 * Create a declarative fragment — a set of resources expressed as data.
 *
 * Declarative fragments are first-class authoring units that participate in
 * the same dependency graph, provider instances, and ref resolution as
 * functionally authored infra. They can be used alongside functional scopes
 * within the same `defineInfra()` call.
 *
 * Spec fields may contain RefToken values for cross-resource references:
 *
 * ```typescript
 * const bucket = awsProd.resource("S3Bucket", "bucket", spec);
 *
 * infra.use(
 *   declarative("ops", {
 *     resources: [
 *       {
 *         provider: "awsProd",
 *         kind: "LambdaFunction",
 *         name: "api",
 *         env: { BUCKET_ARN: bucket.ref.arn },
 *       },
 *     ],
 *   }),
 * );
 * ```
 */
export function declarative(
  name: string,
  fragment: {
    readonly resources: readonly DeclarativeResource[];
  },
): DeclarativeFragment {
  return Object.freeze({
    name,
    resources: fragment.resources,
  });
}
