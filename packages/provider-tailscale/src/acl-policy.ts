import type {
  ResourcePort,
  ResourceScopes,
  ResolvedScopes,
} from "@infrasync/core/provider";
import type { TailscaleClient } from "./client.js";
import * as z from "zod";
import { ProviderApiError } from "@infrasync/core/errors";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const aclRuleSchema = z.object({
  action: z.enum(["accept", "deny"]),
  src: z.array(z.string().trim().min(1)).readonly(),
  dst: z.array(z.string().trim().min(1)).readonly(),
  proto: z.string().trim().optional(),
});

const sshRuleSchema = z.object({
  action: z.enum(["accept", "check"]),
  src: z.array(z.string().trim().min(1)).readonly(),
  dst: z.array(z.string().trim().min(1)).readonly(),
  users: z.array(z.string().trim().min(1)).readonly(),
  checkPeriod: z.string().trim().optional(),
});

const nodeAttrRuleSchema = z.object({
  target: z.array(z.string().trim().min(1)).readonly(),
  attr: z.array(z.string().trim().min(1)).readonly(),
});

const aclTestSchema = z.object({
  src: z.string().trim().min(1),
  accept: z.array(z.string().trim()).readonly().optional(),
  deny: z.array(z.string().trim()).readonly().optional(),
});

export const aclPolicySpecSchema = z.object({
  kind: z.literal("ACLPolicy"),
  acls: z.array(aclRuleSchema).readonly(),
  groups: z
    .record(z.string(), z.array(z.string().trim().min(1)).readonly())
    .optional(),
  tagOwners: z
    .record(z.string(), z.array(z.string().trim().min(1)).readonly())
    .optional(),
  autoApprovers: z
    .object({
      routes: z
        .record(z.string(), z.array(z.string().trim()).readonly())
        .optional(),
      exitNode: z.array(z.string().trim()).readonly().optional(),
    })
    .optional(),
  ssh: z.array(sshRuleSchema).readonly().optional(),
  nodeAttrs: z.array(nodeAttrRuleSchema).readonly().optional(),
  tests: z.array(aclTestSchema).readonly().optional(),
});

export type ACLPolicySpec = z.infer<typeof aclPolicySpecSchema>;

const aclPolicyStateSchema = z
  .looseObject({
    acls: z.array(aclRuleSchema).readonly(),
    groups: z
      .record(z.string(), z.array(z.string().trim()).readonly())
      .optional(),
    tagOwners: z
      .record(z.string(), z.array(z.string().trim()).readonly())
      .optional(),
    autoApprovers: z
      .looseObject({
        routes: z
          .record(z.string(), z.array(z.string().trim()).readonly())
          .optional(),
        exitNode: z.array(z.string().trim()).readonly().optional(),
      })
      .optional(),
    ssh: z.array(sshRuleSchema).readonly().optional(),
    nodeAttrs: z.array(nodeAttrRuleSchema).readonly().optional(),
    tests: z.array(aclTestSchema).readonly().optional(),
  })
  .brand<"TailscaleAclPolicyState">()
  .readonly();

const identitySchema = aclPolicySpecSchema.pick({ kind: true });

const desiredStateSchema = aclPolicySpecSchema.pick({
  acls: true,
  groups: true,
  tagOwners: true,
  ssh: true,
  nodeAttrs: true,
  tests: true,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function specToApiPolicy(spec: ACLPolicySpec): Record<string, unknown> {
  const acls = spec.acls.map((rule) => ({
    action: rule.action,
    src: [...rule.src],
    dst: [...rule.dst],
    ...(rule.proto !== undefined ? { proto: rule.proto } : {}),
  }));

  const groups =
    spec.groups !== undefined
      ? Object.fromEntries(
          Object.entries(spec.groups).map(([k, v]) => [k, [...v]]),
        )
      : undefined;

  const tagOwners =
    spec.tagOwners !== undefined
      ? Object.fromEntries(
          Object.entries(spec.tagOwners).map(([k, v]) => [k, [...v]]),
        )
      : undefined;

  const autoApprovers =
    spec.autoApprovers !== undefined
      ? {
          ...(spec.autoApprovers.routes !== undefined
            ? {
                routes: Object.fromEntries(
                  Object.entries(spec.autoApprovers.routes).map(([k, v]) => [
                    k,
                    [...v],
                  ]),
                ),
              }
            : {}),
          ...(spec.autoApprovers.exitNode !== undefined
            ? { exitNode: [...spec.autoApprovers.exitNode] }
            : {}),
        }
      : undefined;

  const ssh = spec.ssh?.map((rule) => ({
    action: rule.action,
    src: [...rule.src],
    dst: [...rule.dst],
    users: [...rule.users],
    ...(rule.checkPeriod !== undefined
      ? { checkPeriod: rule.checkPeriod }
      : {}),
  }));

  const nodeAttrs = spec.nodeAttrs?.map((rule) => ({
    target: [...rule.target],
    attr: [...rule.attr],
  }));

  const tests = spec.tests?.map((test) => ({
    src: test.src,
    ...(test.accept !== undefined ? { accept: [...test.accept] } : {}),
    ...(test.deny !== undefined ? { deny: [...test.deny] } : {}),
  }));

  return {
    acls,
    ...(groups !== undefined ? { groups } : {}),
    ...(tagOwners !== undefined ? { tagOwners } : {}),
    ...(autoApprovers !== undefined ? { autoApprovers } : {}),
    ...(ssh !== undefined ? { ssh } : {}),
    ...(nodeAttrs !== undefined ? { nodeAttrs } : {}),
    ...(tests !== undefined ? { tests } : {}),
  };
}

// ─── Resource implementation ─────────────────────────────────────────────────

export class ACLPolicyResource implements ResourcePort<
  typeof aclPolicySpecSchema,
  typeof aclPolicyStateSchema
> {
  readonly kind = "ACLPolicy";
  readonly specSchema = aclPolicySpecSchema;
  readonly stateSchema = aclPolicyStateSchema;
  readonly identitySchema = identitySchema;
  readonly desiredStateSchema = desiredStateSchema;

  readonly scopes: ResourceScopes = {
    tailnetId: { config: "tailnetId" },
  };

  constructor(
    private readonly client: TailscaleClient,
    private readonly resolvedScopes: ResolvedScopes,
  ) {}

  getStateId(state: unknown): string {
    void state;
    return "acl-policy";
  }

  async read(): Promise<unknown> {
    const tailnet = this.resolvedScopes.get("tailnetId");
    return this.client.getAcl(tailnet);
  }

  async create(spec: unknown): Promise<unknown> {
    const parsed = aclPolicySpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ProviderApiError("tailscale", "create", parsed.error.issues);
    }
    const tailnet = this.resolvedScopes.get("tailnetId");
    const apiPolicy = specToApiPolicy(parsed.data);
    return this.client.setAcl(tailnet, apiPolicy);
  }

  async update(id: string, spec: unknown): Promise<unknown> {
    // Singleton resource — id is the fixed state ID, not used by the API
    void id;
    return this.create(spec);
  }
}
