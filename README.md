# InfraSync

Idempotent, deterministic, stateless infrastructure management for TypeScript.

InfraSync is a TypeScript package and CLI for managing cloud infrastructure declaratively — without a state file. Each run reads the current state from the provider, compares it against your desired configuration, and applies only the changes needed. No stored state to corrupt, no lock files to stale, no remote backend to configure.

An alternative to Terraform for teams who want infrastructure-as-code without the operational overhead of state management.

## Why

Terraform's state file is its greatest strength and its greatest liability. State drift, corrupted state, lock contention, and the operational burden of remote backends are problems that stem from one design decision: storing a separate representation of reality alongside reality itself. InfraSync discards that. The provider API is the state.

The pattern emerged from a real project — a script that configured Cloudflare Access applications, identity providers, policies, DNS records, and custom domains. Every resource operation followed the same shape: list existing resources, match against desired configuration, create or update only what differs. That script is the blueprint for this tool.

## Design Principles

- **Stateless.** No state file, no lock file, no remote backend. The provider API is the source of truth.
- **Idempotent.** Running the same configuration twice produces the same result. Create-if-missing, update-if-changed, skip-if-matching.
- **Deterministic.** Given the same desired configuration and the same current state, the same plan is produced every time.
- **TypeScript-native.** Infrastructure is defined with full type safety. No HCL, no DSL, no template strings. Intellisense, refactoring, and type checking all work. Zod schemas are the single source of truth for every type — runtime validation and static types are always in sync.
- **Programmable first, CLI second.** The core is a library. The CLI is a thin wrapper that loads a config file and invokes the programmatic API.
- **Provider-agnostic.** The sync engine knows nothing about Cloudflare, AWS, or GCP. Providers are adapters that implement a uniform interface over provider-specific APIs.

## Installation

```bash
pnpm add infrasync
```

## Usage

### Programmatic API

Define your infrastructure as a TypeScript configuration spanning multiple providers:

```typescript
import { sync, resource, $ref } from "infrasync";

// resource() returns a typed handle bound to the provider's state schema.
// This handle is what makes $ref type-safe.
const appBucket = resource("aws", "S3Bucket", {
	name: "app-bucket",
	bucketName: "my-bucket",
	region: "eu-west-2",
	versioning: true,
	publicAccessBlock: {
		blockPublicAcls: true,
		blockPublicPolicy: true,
		ignorePublicAcls: true,
		restrictPublicBuckets: true,
	},
});

const result = await sync({
	providers: {
		cloudflare: {
			apiToken: process.env.CLOUDFLARE_API_TOKEN,
		},
		aws: {
			region: "eu-west-2",
			credentials: {
				accessKeyId: process.env.AWS_ACCESS_KEY_ID,
				secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
			},
		},
		github: {
			token: process.env.GITHUB_TOKEN,
		},
	},
	resources: [
		appBucket,
		{
			provider: "cloudflare",
			kind: "DnsRecord",
			domain: "app.example.com",
			type: "CNAME",
			value: $ref(appBucket, "websiteEndpoint"),  // type-checked: RefToken<string>
			ttl: 300,
			proxied: false,
		},
		{
			provider: "aws",
			kind: "DynamodbTable",
			name: "sessions",
			billingMode: "PAY_PER_REQUEST",
			hashKey: { name: "pk", type: "S" },
			sortKey: { name: "sk", type: "S" },
			pointInTimeRecovery: true,
		},
		{
			provider: "github",
			kind: "Repository",
			name: "my-project",
			visibility: "private",
			defaultBranch: "main",
			branchProtection: {
				pattern: "main",
				requireStatusChecks: ["ci", "lint"],
				requirePullRequestReviews: true,
			},
		},
		{
			provider: "cloudflare",
			kind: "AccessApplication",
			name: "Internal Dashboard",
			domain: "dash.example.com",
			type: "self_hosted",
			sessionDuration: "24h",
			policies: [
				{
					name: "Allow Team",
					decision: "allow",
					include: [{ emailDomain: { domain: "example.com" } }],
				},
			],
		},
	],
});

// result.plans — what would change
// result.applied — what was actually changed
// result.unchanged — what was already in the desired state
```

### CLI

```bash
# Apply configuration
npx infrasync apply --config infra.config.ts

# Preview changes without applying
npx infrasync plan --config infra.config.ts

# Show current drift (diff between desired and actual state)
npx infrasync drift --config infra.config.ts
```

## How It Works

InfraSync operates in three phases. Every resource goes through the read phase. Only resources in `"manage"` mode proceed to plan and apply.

### 0. Build the dependency graph

Before any provider API calls, the engine scans every resource for `$ref` tokens and `dependsOn` declarations, then builds a directed acyclic graph (DAG). Each `$ref("name", ...)` creates an edge from the referenced resource to the referencing resource. Topological sort determines processing order — configuration array order is irrelevant.

If the graph contains a cycle, the engine fails immediately with a clear error showing the cycle path.

### 1. Read

Resources are processed in topological order. For each resource, InfraSync routes the query to the named provider adapter, which calls the provider API to discover the current state. No local state file is consulted — the provider is the sole source of truth.

Read state is collected into a **state map** keyed by resource name. As each resource's state is stored, any `$ref` tokens in downstream resources that point to it are resolved with the concrete value. By the time a resource is processed, all of its dependencies have been read and their `$ref` values resolved.

### 2. Plan

For resources in `"manage"` mode only — the desired configuration is compared against the current state. A plan is generated containing:

- **Creates** — resources that exist in the desired config but not in the provider.
- **Updates** — resources that exist in both but have drifted from the desired config.
- **No-ops** — resources that already match the desired config.

Resources in `"read"` mode are skipped — no plan is generated for them.

Planning is deterministic: the same desired config and the same current state always produce the same plan.

### 3. Apply

The plan is executed in topological order. Each create or update is applied, and the resulting state is stored back into the state map so that dependent resources see the updated values. Results are reported per-resource with success/failure status.

## Resource Model

Every resource has a **mode** that controls whether the engine manages it or just reads it:

| Mode                 | Behaviour                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `"manage"` (default) | Read current state → plan changes → apply. Creates if missing, updates if drifted.               |
| `"read"`             | Read current state only. No plan, no apply. State is available for other resources to reference. |

There is no separate "data resource" type. A read-mode resource uses the same spec schema, the same provider adapter, and the same codecs as a managed resource. The only difference is the engine stops after reading.

Each resource has:

| Property             | Description                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | Unique identifier within the configuration. Used as the DAG node key and as the target for `$ref`.                               |
| `provider`           | Which provider adapter to route this resource to (e.g. `"cloudflare"`, `"aws"`, `"github"`)                                      |
| `kind`               | The resource type within that provider (e.g. `DnsRecord`, `S3Bucket`, `Repository`)                                              |
| `mode`               | `"manage"` (default) or `"read"`                                                                                                 |
| `dependsOn`          | Optional explicit dependency edges — names of resources that must be processed before this one, even if no `$ref` connects them. |
| Identity fields      | Fields used to match against existing resources (e.g. `domain` for an app, `name` for a bucket)                                  |
| Desired state fields | Fields that should be enforced (e.g. `versioning` for a bucket, `content` for a DNS record). May contain `$ref` tokens.          |

InfraSync uses **identity fields** to find existing resources (not provider-assigned IDs — those are opaque and provider-specific). If a matching resource exists, its desired state fields are compared and updated only when drifted. If no match is found, the resource is created.

## Read-Mode Resources

Read-mode resources are InfraSync's equivalent of Terraform's data sources — but without a separate concept. Any resource can be read-only by setting `mode: "read"`. The engine queries the provider API, validates the response, and stores the state. Other resources can then reference that state via `$ref`.

### Why a single resource type, not two

Terraform separates `resource` and `data` into distinct blocks with different syntax and semantics. This forces you to know upfront whether something is managed or queried, and it prevents you from changing your mind without rewriting the config.

InfraSync uses one type. The mode is a property, not a category. This means:

- The same schema, codec, and adapter handle both cases.
- You can switch a resource from `"read"` to `"manage"` by changing one field — no rewrite needed.
- Read-mode resources go through the same validation pipeline (`specSchema.safeParse()`, `stateSchema.safeParse()`) as managed resources.
- The state map is uniform — the engine doesn't need two different lookup mechanisms.

## Dependency Graph

InfraSync builds a **directed acyclic graph (DAG)** from the configuration. Processing order is derived from the graph topology, not from the array order of resources. You can organise your configuration in whatever order makes sense for readability — the engine determines the correct execution order.

### Edge sources

Edges in the DAG come from two sources:

| Edge source     | Syntax                                              | Creates attribute binding?                   |
| --------------- | --------------------------------------------------- | -------------------------------------------- |
| **`$ref`**      | `$ref(handle, "path")` in any spec field            | Yes — the resolved value flows into the spec |
| **`dependsOn`** | `dependsOn: [handleA, handleB]` on a resource       | No — ordering only, no attribute binding     |

`$ref` creates both a dependency edge and an attribute binding. `dependsOn` creates only an edge — useful when there's no attribute reference but the provider API requires one resource to exist before another (e.g. a bucket must exist before a policy attached to it).

### Type-safe references with `resource()` and `$ref()`

The problem with string-based references (`$ref("media-bucket", "websiteEndpoint")`) is that TypeScript can't verify the path exists or that the resolved type is compatible with the field it's injected into. Typos and type mismatches are caught only at runtime.

InfraSync solves this with **typed resource handles**. The `resource()` function returns a handle bound to the provider's state schema. The `$ref()` function accepts this handle and a path type-checked against it:

```typescript
import { sync, resource, $ref } from "infrasync";

// resource() returns a ResourceHandle<TSpec, TState>.
// TState is inferred from the provider's state schema for this kind.
const mediaBucket = resource("aws", "S3Bucket", {
	name: "media-bucket",
	mode: "read",
	bucketName: "my-media-bucket",
	region: "eu-west-2",
});

const mediaPolicy = resource("aws", "S3BucketPolicy", {
	name: "media-policy",
	bucketName: "my-media-bucket",
	policy: {
		Effect: "Allow",
		Principal: "*",
		Action: "s3:GetObject",
		Resource: $ref(mediaBucket, "arn"),
	},
	dependsOn: [mediaBucket],
});

const mediaDns = resource("cloudflare", "DnsRecord", {
	name: "media-dns",
	domain: "media.example.com",
	type: "CNAME",
	value: $ref(mediaBucket, "websiteEndpoint"),
	ttl: 300,
	proxied: true,
});

await sync({
	providers: { /* ... */ },
	resources: [mediaBucket, mediaPolicy, mediaDns],
});
```

#### How the types work end-to-end

There are three layers of type safety for attribute references.

**1. The path is valid.** `$ref()` accepts only paths that exist on the target's state schema:

```typescript
const bucket = resource("aws", "S3Bucket", { /* spec */ });
// typeof bucket = ResourceHandle<S3BucketSpec, S3BucketState>

function $ref<TState, TPath extends DeepPath<TState>>(
	handle: ResourceHandle<any, TState>,
	path: TPath,
): RefToken<DeepPathType<TState, TPath>>;

$ref(bucket, "websiteEndpoint");       // ✅ RefToken<string>
$ref(bucket, "encryption.kmsKeyId");  // ✅ RefToken<string>
$ref(bucket, "websitEndpoint");       // ❌ compile error — typo
$ref(bucket, "nonexistent");           // ❌ compile error — no such path
```

`DeepPath<T>` is a utility type that derives all valid dot-notation paths from the Zod state schema:

```typescript
// Given S3BucketState inferred from s3BucketStateSchema:
// {
//   id: string;
//   arn: string;
//   websiteEndpoint: string;
//   versioning: boolean;
//   encryption: { kmsKeyId: string; algorithm: string };
//   tags: Record<string, string>;
// }

type Paths = DeepPath<S3BucketState>;
// "id" | "arn" | "websiteEndpoint" | "versioning" |
// "encryption" | "encryption.kmsKeyId" | "encryption.algorithm" | "tags"
```

**2. The resolved type matches the consuming field.** This is where it gets tricky. The spec schema defines `value: z.string()`, but `$ref()` returns `RefToken<string>` — a different type. Plain `z.string()` would reject a `RefToken` at runtime, and TypeScript would reject assigning `RefToken<string>` to `string` at compile time.

InfraSync solves this with a custom schema helper called `refable()`. It wraps a Zod schema to accept both the concrete type and a `RefToken` of the same inner type:

```typescript
// InfraSync defines this helper (not a Zod built-in)
function refable<T extends ZodType>(inner: T) {
	return z.union([
		inner,                                                  // concrete value
		z.custom<RefToken<z.infer<T>>>((v) => isRefToken(v)),  // ref token
	]);
}
```

`refable(z.string())` produces `z.union([z.string(), RefToken<string>])`. At the TypeScript level this infers as `string | RefToken<string>`. The compile-time type check then works naturally:

```typescript
const dnsRecordSpecSchema = z.object({
	domain: z.string(),
	type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT"]),
	value: refable(z.string()),   // accepts string | RefToken<string>
	ttl: refable(z.number()),     // accepts number | RefToken<number>
	proxied: z.boolean(),         // plain boolean — no $ref allowed
});

// Inferred type:
type DnsRecordSpec = z.infer<typeof dnsRecordSpecSchema>;
// {
//   domain: string;
//   type: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
//   value: string | RefToken<string>;
//   ttl: number | RefToken<number>;
//   proxied: boolean;
// }
```

Now the compile-time checks work:

```typescript
// ✅ Compiles — RefToken<string> is assignable to string | RefToken<string>
resource("cloudflare", "DnsRecord", {
	value: $ref(mediaBucket, "websiteEndpoint"),
});

// ❌ Compile error — RefToken<boolean> is not assignable to string | RefToken<string>
resource("cloudflare", "DnsRecord", {
	value: $ref(mediaBucket, "versioning"),
});

// ❌ Compile error — RefToken<boolean> is not assignable to boolean
// (proxied is NOT wrapped in refable)
resource("cloudflare", "DnsRecord", {
	proxied: $ref(mediaBucket, "versioning"),
});
```

**3. The engine resolves before validation.** At runtime, the engine walks the spec, replaces every `RefToken` with the concrete value from the state map, then passes the result through `specSchema.safeParse()`. The `refable()` union's `z.custom` branch handles `RefToken` objects during the brief window between construction and resolution. After resolution, only concrete values reach the inner schema:

```typescript
// Engine's resolve step:
const resolved = resolveRefs(rawSpec, stateMap);
// $ref(bucket, "websiteEndpoint")  →  "my-bucket.s3.amazonaws.com"

// Then validate with the inner schema:
const specResult = handler.specSchema.safeParse(resolved);
if (!specResult.success) {
	// report issues and skip
	continue;
}
const spec = specResult.data;
// z.string() validates "my-bucket.s3.amazonaws.com"  →  ✅
```

#### Which fields should use refable()?

Only fields whose values might come from another resource's state — ARNs, endpoints, IDs, URLs. Fields that users always set to a known value stay as plain schemas:

```typescript
const s3BucketPolicySpecSchema = z.object({
	bucketName: z.string(),                                // user always sets this
	policy: z.object({
		Effect: z.enum(["Allow", "Deny"]),
		Principal: z.string(),
		Action: z.string(),
		Resource: refable(z.string()),                    // likely an ARN from $ref
	}),
});
```

#### Inline resources still work

Not every resource needs a handle. Resources with no incoming `$ref` references can be written inline as plain objects, just like before:

```typescript
await sync({
	providers: { /* ... */ },
	resources: [
		// Handle — needed because other resources $ref it
		mediaBucket,
		// Handle — needed because it $refs mediaBucket
		mediaPolicy,
		mediaDns,
		// Inline — nothing references this, no handle needed
		{
			provider: "aws",
			kind: "DynamodbTable",
			name: "sessions",
			billingMode: "PAY_PER_REQUEST",
			hashKey: { name: "pk", type: "S" },
			sortKey: { name: "sk", type: "S" },
			pointInTimeRecovery: true,
		},
	],
});
```

The `resources` array accepts both `ResourceHandle` and plain resource objects. Plain objects have no type-safe `$ref` surface — they're leaf nodes in the DAG.

### How the engine builds the DAG from handles

```typescript
// The resource handle carries dependency identity for the DAG

interface ResourceHandle<TSpec, TState> {
	/** Unique name — the DAG node key */
	readonly name: string;
	readonly provider: string;
	readonly kind: string;
	readonly mode: "manage" | "read";
	readonly rawSpec: TSpec;

	/**
	 * Refs extracted from the spec at construction time.
	 * Each entry maps a spec field path to a [targetHandle, statePath] pair.
	 */
	readonly refs: ReadonlyMap<string, [ResourceHandle<any, any>, string]>;

	/** Handles listed in dependsOn */
	readonly explicitDeps: ReadonlySet<ResourceHandle<any, any>>;
}

function buildDag(
	resources: Array<ResourceHandle<any, any> | RawResource>,
): ResourceNode[] {
	const nodes = new Map<string, ResourceNode>();

	for (const resource of resources) {
		const isHandle = "name" in resource && "refs" in resource;
		const deps = new Set<string>();
		const refBindings = new Map<string, string>();

		if (isHandle) {
			// Edges from $ref — already extracted, type-safe
			for (const [, [target, statePath]] of resource.refs) {
				deps.add(target.name);
			}
			// Edges from dependsOn — handle references, guaranteed to exist
			for (const dep of resource.explicitDeps) {
				deps.add(dep.name);
			}
		} else {
			// Plain object — walk for $ref tokens (untyped fallback)
			walkSpec(resource, (path, token) => {
				deps.add(token.target);
				refBindings.set(path, token.dotPath);
			});
		}

		nodes.set(resource.name, { /* ... */ });
	}

	// Validate, topological sort, return
}
```

Handles carry their dependency edges at construction time — the engine doesn't need to walk specs with string matching. For plain inline resources (no handle), the engine falls back to walking for `$ref` tokens with string keys.

### Processing in topological order

```typescript
// Phases 1–3: Read → plan → apply in DAG order

const stateMap = new Map<string, unknown>();
const allIssues: { resource: string; issues: z.ZodIssue[] }[] = [];

for (const node of sortedNodes) {
	const handler = getHandler(node.provider, node.kind);

	// 1. Resolve all $ref tokens using the state map
	const resolvedSpec = resolveRefs(node.rawSpec, node.refBindings, stateMap);

	// 2. Validate the resolved spec against the schema
	const specResult = handler.specSchema.safeParse(resolvedSpec);
	if (!specResult.success) {
		allIssues.push({ resource: node.name, issues: specResult.error.issues });
		continue;
	}
	const spec = specResult.data;

	// 3. Read current state from the provider
	const rawState = await handler.read(spec);
	let state: z.infer<typeof handler.stateSchema> | undefined;
	if (rawState !== undefined) {
		const stateResult = handler.stateSchema.safeParse(rawState);
		if (!stateResult.success) {
			allIssues.push({ resource: node.name, issues: stateResult.error.issues });
			continue;
		}
		state = stateResult.data; // branded, readonly, coerced
	}

	stateMap.set(node.name, state);

	// 4. Plan and apply for managed resources only
	if (node.mode === "manage") {
		if (state === undefined) {
			const created = await handler.create(spec);
			const createdResult = handler.stateSchema.safeParse(created);
			if (!createdResult.success) {
				allIssues.push({ resource: node.name, issues: createdResult.error.issues });
				continue;
			}
			stateMap.set(node.name, createdResult.data);
		} else {
			const desired = handler.desiredStateSchema.parse(spec);
			const actual = handler.desiredStateSchema.parse(state);
			if (!deepEqual(desired, actual)) {
				const updated = await handler.update((state as any).id, spec);
				const updatedResult = handler.stateSchema.safeParse(updated);
				if (!updatedResult.success) {
					allIssues.push({ resource: node.name, issues: updatedResult.error.issues });
					continue;
				}
				stateMap.set(node.name, updatedResult.data);
			}
		}
	}
}

// Report all collected issues at once
if (allIssues.length > 0) {
	for (const { resource, issues } of allIssues) {
		for (const issue of issues) {
			console.error(`  ${resource}: ${issue.path.join(".")} — ${issue.message}`);
		}
	}
	process.exit(1);
}
```

### Parallel processing

Resources at the same depth in the DAG have no dependencies between them and can be processed concurrently. For example, if three DNS records all depend on the same bucket but not on each other, all three can be read and applied in parallel after the bucket is processed.

```typescript
// Process by depth level for parallelism
const levels = groupByDepth(sortedNodes);

for (const level of levels) {
	await Promise.all(level.map((node) => processNode(node, stateMap)));
}
```

This gives you Terraform-style parallelism for free — the DAG tells you exactly which resources can safely run concurrently.

### Declaring the graph declaratively

The DAG is **implicit** — you don't declare edges explicitly (though `dependsOn` is available for cases that need it). The graph emerges from the data flow:

1. Every `$ref("name", ...)` is an edge: `name → this resource`.
2. Every entry in `dependsOn` is an edge: `dep → this resource`.
3. Resources with no `$ref` and no `dependsOn` have no incoming edges — they are roots.
4. The topological sort produces a valid processing order.

This is the same approach Terraform uses (implicit edges from interpolation references), but expressed as a TypeScript function call rather than a string interpolation.

## Architecture: Ports and Adapters

InfraSync follows the **ports and adapters** pattern (hexagonal architecture). The sync engine is the core domain. It defines **ports** — interfaces that describe what it needs from the outside world — and each provider is an **adapter** that implements those ports for a specific platform. The engine never imports an AWS SDK, a Cloudflare SDK, or any provider-specific dependency. It only calls through the port interfaces.

```
┌─────────────────────────────────────────────────┐
│                   Sync Engine                    │
│                                                  │
│  build DAG → read → plan → apply                 │
│                                                  │
│  depends only on ports, never on adapters        │
└──────────┬──────────┬──────────┬────────────────┘
           │          │          │
     ┌─────▼──┐ ┌─────▼──┐ ┌────▼─────┐
     │ Cloud- │ │  AWS   │ │  GitHub  │  ...any adapter
     │ flare  │ │adapter │ │ adapter  │
     │adapter │ │        │ │          │
     └────┬───┘ └────┬───┘ └────┬─────┘
          │          │          │
     ┌────▼───┐ ┌────▼───┐ ┌───▼──────┐
     │cloud-  │ │@aws-   │ │@octokit/ │
     │flare   │ │sdk/    │ │rest      │
     │npm pkg │ │client-*│ │npm pkg   │
     └────────┘ └────────┘ └──────────┘
```

### Zod as the Schema Backbone

Every type in InfraSync — resource specs, provider state, provider config — is defined as a **Zod schema**. Zod serves as the single source of truth: from each schema you get the TypeScript type (via `z.infer`), runtime validation (via `safeParse()`), and field introspection (via `.shape`). There are no separate interface definitions that could drift from the runtime validation logic.

This matters because InfraSync has two distinct validation boundaries:

1. **The adapter boundary** — the adapter receives `unknown` from a provider API and validates it against a private API response schema. This catches API contract violations (rate limit responses where objects were expected, missing fields, changed shapes) at the source, with full context about what the API actually returned.
2. **The engine boundary** — the engine validates the adapter's output against the public state schema. This is the safety net: even if an adapter has a bug, the engine catches malformed state before it enters the state map or gets compared for convergence.

```
User config ──► specSchema.safeParse() ──► sync engine ──► ResourcePort.read()
                          ▲                                              │
                   validates resource                                    ▼
                   shape and values                          raw API response (unknown)
                                                                  │
                                         ┌───────────────────────┘
                                         │
                                         ▼  apiResponseSchema.safeParse()  ← adapter-internal
                                         validated provider data
                                         │
                                         ▼  adapter maps fields
                                         TState (plain object)
                                         │
                          ┌──────────────┘
                          ▼
                    stateSchema.safeParse()  ← engine validates adapter output
                    branded, readonly, frozen state
                          │
                          ▼
                    plan: create | update | no-op
```

#### What Zod provides

| Concern                   | Without Zod                         | With Zod                                                |
| ------------------------- | ----------------------------------- | ------------------------------------------------------- |
| **Type definitions**      | Separate `interface` declarations   | `z.infer<typeof schema>` — always in sync with runtime  |
| **Input validation**      | Manual guards or trust              | `safeParse()` at every boundary                         |
| **Error reporting**       | One error at a time                 | `safeParse()` collects all errors across all resources   |
| **Field introspection**   | String arrays that can drift        | `Object.keys(schema.shape)` — always matches the type   |
| **Convergence checking**  | Manual field-by-field comparison    | Pick desired-state sub-schema, compare parsed outputs   |
| **CLI config validation** | Fail at runtime with obscure errors | Fail fast with structured `ZodError` messages           |
| **Provider config**       | Trust user input                    | Validate credentials, regions, URLs at `connect()` time |
| **State immutability**    | Trust that nobody mutates the map   | `z.readonly()` freezes parsed state objects             |
| **State type safety**     | Could mix up bucket state with DNS  | `z.brand()` makes states nominally typed               |
| **API type mismatches**   | Adapter manually coerces strings    | `z.coerce` handles stringly-typed API responses         |
| **Config typos**          | Silently ignored extra fields       | `z.strictObject()` rejects unknown keys                 |
| **Extra API fields**      | Adapter strips unknown fields       | `z.looseObject()` passes them through                   |
| **Cross-field rules**     | Manual validation in adapter code   | `z.refine()` on the schema itself                       |
| **Documentation**         | Manually maintained                 | Generate JSON Schema from Zod for docs/IDE support       |

#### Schema design rules

InfraSync applies specific Zod features to each schema type for different guarantees:

| Schema type | Scope | Zod features | Why |
|-------------|-------|-------------|-----|
| **Config schemas** | Public | `z.strictObject()` | Reject typos in credential keys — `"apKey"` instead of `"apiKey"` should fail, not be silently ignored |
| **Spec schemas** | Public | `z.object()`, `z.default()`, `z.refine()`, `refable()`, string formats (`z.hostname()`, `z.url()`, `z.cidrv4()`) | Validate resource shape, fill provider defaults, enforce cross-field rules, accept `$ref` tokens |
| **State schemas** | Public | `z.looseObject()`, `z.coerce`, `z.brand()`, `z.readonly()` | Tolerate extra fields, coerce types, prevent type mix-ups, freeze against mutation |
| **API response schemas** | Adapter-internal | `z.looseObject()`, `z.coerce`, string formats (`z.iso.datetime()`, `z.uuid()`) | Validate raw API responses at the source, catch contract violations with full error context |

"Public" schemas are exposed on the `ResourcePort` and validated by the engine. "Adapter-internal" schemas live inside the adapter implementation — the engine never sees them.

The combination of `z.looseObject().brand().readonly()` on every state schema gives three guarantees with one parse call: extra API fields pass through, the type is nominally distinct from other resource states, and the result is frozen.

### Ports (the contracts)

The sync engine defines two ports: one for providers and one for individual resource kinds. Both are generic over Zod schemas, not raw TypeScript types.

#### `ProviderPort` — the provider-level interface

A provider adapter manages connection lifecycle and routes resource operations to the correct handler:

```typescript
import type { ZodType } from "zod";

interface ProviderPort<TConfig extends ZodType> {
	/** Unique name used in resource definitions (e.g. "cloudflare", "aws") */
	readonly name: string;

	/** Zod schema for this provider's configuration (credentials, region, etc.) */
	readonly configSchema: TConfig;

	/** Initialise the provider client (validate credentials, configure SDK) */
	connect(config: z.infer<TConfig>): Promise<void>;

	/** Gracefully close connections, release resources */
	disconnect(): Promise<void>;

	/** List all resource kinds this provider supports */
	supportedKinds(): string[];

	/** Route a resource operation to the correct handler for a given kind */
	resourceHandler(kind: string): ResourcePort;
}
```

The engine calls `configSchema.safeParse(rawConfig)` before `connect()`. If validation fails, all issues are collected and reported before any API calls are made — the adapter never receives invalid config.

#### `ResourcePort` — the resource-level interface

Each resource kind within a provider implements its own port. Spec and state are Zod schemas — the engine validates at every boundary:

```typescript
import type { ZodType, ZodObject } from "zod";

interface ResourcePort<
	TSpecSchema extends ZodType,
	TStateSchema extends ZodType,
> {
	/** The resource kind this handler manages (e.g. "DnsRecord", "S3Bucket") */
	readonly kind: string;

	/** Zod schema for the desired configuration of this resource */
	readonly specSchema: TSpecSchema;

	/** Zod schema for the current state returned by the provider API */
	readonly stateSchema: TStateSchema;

	/**
	 * Sub-schema containing only identity fields.
	 * Used by the engine to look up existing resources.
	 * Must be a subset of specSchema.
	 */
	readonly identitySchema: ZodObject<any>;

	/**
	 * Sub-schema containing only desired-state fields.
	 * Used by the engine for convergence checking.
	 * Must be a subset of specSchema.
	 */
	readonly desiredStateSchema: ZodObject<any>;

	/**
	 * Query the provider API for resources matching the identity fields in spec.
	 *
	 * Adapters validate the raw API response against a private apiResponseSchema
	 * (adapter-internal), then map fields into the shape expected by stateSchema.
	 * The engine then validates the return value through stateSchema.safeParse().
	 *
	 * Returns undefined if the resource does not exist.
	 */
	read(spec: z.infer<TSpecSchema>): Promise<z.infer<TStateSchema> | undefined>;

	/** Create a resource that does not yet exist */
	create(spec: z.infer<TSpecSchema>): Promise<z.infer<TStateSchema>>;

	/** Update an existing resource to match desired state */
	update(
		id: string,
		spec: z.infer<TSpecSchema>,
	): Promise<z.infer<TStateSchema>>;
}
```

Notice `isConverged()` is gone — the engine implements convergence generically by parsing both state and spec through `desiredStateSchema` and comparing the results. Adapters no longer need to write field-by-field comparison logic.

The adapter has **two validation responsibilities**:

1. **Validate raw API responses** against a private `apiResponseSchema` using `safeParse()`. This catches API contract violations at the source — the adapter author gets structured errors showing exactly which fields the API returned incorrectly. If validation fails, the adapter throws a `ProviderApiError` that the engine catches and adds to `allIssues`.
2. **Map fields** from the API response shape to the state schema shape. Every field access is typed because the API response was validated — no `as` casts needed.

The engine then validates the adapter's return value through `stateSchema.safeParse()` as a safety net. If the adapter has a mapping bug (wrong field, missing field), the engine catches it before the bad data enters the state map.

This two-layer approach means neither the adapter nor the engine trusts its input — each validates independently at its own boundary.

#### How the engine validates at boundaries

Validation happens at two boundaries: inside the adapter (raw API response) and inside the engine (adapter output).

**Adapter boundary** — validates raw API responses with a private schema:

```typescript
// Inside the adapter — the engine never sees this schema
const apiResponseSchema = z.looseObject({
	service_id: z.string(),
	service_name: z.string(),
	config: z.object({
		image: z.string(),
		replicas: z.coerce.number(),
		env_vars: z.record(z.string(), z.string()),
	}),
	state: z.enum(["running", "stopped", "deploying"]),
	created_at: z.iso.datetime(),   // extra field — not in state schema
	updated_at: z.iso.datetime(),   // extra field — not in state schema
});

async read(spec: ServiceSpec): Promise<ServiceState | undefined> {
	const response = await this.client.get(`/services/${spec.name}`);
	if (response.status === 404) return undefined;

	const raw = await response.json(); // unknown
	const result = apiResponseSchema.safeParse(raw);
	if (!result.success) {
		// API contract violation — structured error with field paths
		throw new ProviderApiError("internal-platform", "read", result.error.issues);
	}
	const data = result.data; // fully typed, coerced, extra fields available

	// Map from API shape to state shape — every field access is typed
	return {
		id: data.service_id,
		name: data.service_name,
		image: data.config.image,
		replicas: data.config.replicas,
		env: data.config.env_vars,
		status: data.state,
	};
}
```

**Engine boundary** — validates adapter output with the public state schema:

```typescript
// Inside the sync engine — validates what the adapter returns

// 1. Validate user config against the spec schema
const specResult = resourceHandler.specSchema.safeParse(rawResource);
if (!specResult.success) {
	allIssues.push({ resource: rawResource.name, issues: specResult.error.issues });
	continue;
}
const spec = specResult.data;

// 2. Adapter reads current state (throws ProviderApiError on API contract violation)
let state: z.infer<typeof resourceHandler.stateSchema> | undefined;
try {
	const rawState = await resourceHandler.read(spec);
	if (rawState !== undefined) {
		// 3. Engine validates adapter output against the public state schema
		const stateResult = resourceHandler.stateSchema.safeParse(rawState);
		if (!stateResult.success) {
			// Adapter returned data that doesn't match the state contract
			allIssues.push({ resource: rawResource.name, issues: stateResult.error.issues });
			continue;
		}
		state = stateResult.data; // branded, readonly, coerced
	}
} catch (err) {
	if (err instanceof ProviderApiError) {
		allIssues.push({ resource: rawResource.name, issues: err.issues });
		continue;
	}
	throw err;
}

// 4. Engine checks convergence generically
if (state !== undefined) {
	const desired = resourceHandler.desiredStateSchema.parse(spec);
	const actual = resourceHandler.desiredStateSchema.parse(state);
	if (deepEqual(desired, actual)) {
		// no-op — resource is converged
	} else {
		// plan an update
	}
}
```

Why two layers? The adapter catches API contract violations (wrong shape, missing fields, type changes) with full context about what the API actually returned. The engine catches adapter bugs (wrong field mapping, missing fields) before bad data enters the state map. Neither trusts its input — each validates independently.

#### Data flow through the ports

```
User config (TypeScript)
    │
    ▼  specSchema.safeParse()     ← engine validates user input
    │
Sync Engine ──► ProviderPort.resourceHandler("DnsRecord")
    │                    │
    │                    ▼
    │              ResourcePort.read(spec)
    │                    │
    │                    ▼  (adapter calls provider SDK / REST API)
    │              raw API response (unknown)
    │                    │
    │                    ▼  apiResponseSchema.safeParse()  ← ADAPTER-INTERNAL: validates API contract
    │              validated API data (typed, coerced)
    │                    │
    │                    ▼  adapter maps fields to state shape
    │              plain state object
    │                    │
    ◄────────────────────┘
    │
    ▼  stateSchema.safeParse()     ← ENGINE: validates adapter output
    │  brands, freezes, tolerates extras
    │
    ▼  desiredStateSchema.parse() on both spec and state
    │  deepEqual(desired, actual)?
    │
    ▼
Plan: create | update | no-op
    │
    ▼
ResourcePort.create(spec)  or  ResourcePort.update(id, spec)
    │                    │
    │                    ▼  apiResponseSchema.safeParse()  ← ADAPTER-INTERNAL again
    │                    ▼  adapter maps fields to state shape
    │                    ▼  stateSchema.safeParse()        ← ENGINE validates again
```

### Codecs: Normalised Resource Specs Across Providers

Different providers often expose the same conceptual resource with different field names, shapes, and constraints. A DNS record on Cloudflare uses `name`/`content`/`proxied`. The same record on AWS Route53 uses `ResourceRecordSet` with `AliasTarget` or `ResourceRecords`. GCP Cloud DNS uses `rrdatas`/`name`/`ttl`. The resource is the same — the wire format is different.

Zod codecs solve this with **bidirectional transforms**. Each provider adapter defines a codec that translates between a normalised spec schema (shared across all providers for that resource kind) and the provider-specific state schema. The codec has two directions:

- **`decode(normalised) → provider-specific`** — before calling `create()`, `update()`, or `read()`, the engine transforms the user's normalised spec into the shape this provider expects.
- **`encode(provider-specific) → normalised`** — after `read()` returns provider-specific state, the engine transforms it back into the normalised shape so convergence checking can compare apples to apples.

```
             Normalised spec                       Provider-specific state
             (user writes this)                     (API returns this)
                    │                                       │
    ┌───────────────▼───────────────┐     ┌──────────────────▼──────────────────┐
    │  kind: "DnsRecord"            │     │  Cloudflare: name, content, proxied  │
    │  domain: "app.example.com"    │     │  AWS: ResourceRecordSet, AliasTarget │
    │  type: "CNAME"                │     │  GCP: rrdatas, name, ttl            │
    │  value: "my-app.pages.dev"    │     │                                     │
    │  ttl: 300                     │     │                                     │
    └───────────────┬───────────────┘     └──────────────────┬──────────────────┘
                    │                                       │
                    ▼  codec.decode()                        ▼  codec.encode()
                    │  (spec → provider)                      │  (provider → normalised)
                    ▼                                       ▼
              Provider adapter                         Provider adapter
              calls SDK with                          returns state that
              provider-specific params                the engine compares
```

#### Defining a normalised spec schema

A normalised schema is a plain Zod object schema shared across all providers for a given resource kind:

```typescript
// src/core/schemas/dns-record.ts
import { z } from "zod";

/** Normalised DNS record spec — works across Cloudflare, AWS, GCP */
export const dnsRecordSpecSchema = z
	.object({
		kind: z.literal("DnsRecord"),
		domain: z.hostname(), // identity field
		type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]), // identity field
		value: z.string().min(1), // desired state field
		ttl: z.number().int().min(0).default(300), // desired state field (with default)
		proxied: z.boolean().default(false), // desired state field (ignored by providers that don't support it)
	})
	.refine(
		(spec) => {
			// CNAME cannot be at zone apex
			if (spec.type === "CNAME") {
				const parts = spec.domain.split(".");
				return spec.domain !== parts.slice(-2).join(".");
			}
			return true;
		},
		{ error: "CNAME records cannot be placed at the zone apex", path: ["type"] },
	);
export type DnsRecordSpec = z.infer<typeof dnsRecordSpecSchema>;

export const dnsRecordIdentitySchema = dnsRecordSpecSchema.pick({
	domain: true,
	type: true,
});

export const dnsRecordDesiredStateSchema = dnsRecordSpecSchema.pick({
	value: true,
	ttl: true,
	proxied: true,
});
```

#### Provider-specific codecs

Each provider defines a codec that maps between the normalised spec and its own API shape:

```typescript
// src/providers/cloudflare/dns-record-codec.ts
import { z } from "zod";
import { dnsRecordSpecSchema } from "../../core/schemas/dns-record";

/** Cloudflare's API shape for a DNS record.
 *  looseObject: tolerate extra fields like metadata, comment, tags.
 *  brand: prevent mix-ups with Route53 or GCP state.
 *  readonly: freeze after parsing.
 *  coerce: Cloudflare sometimes returns ttl as a string. */
const cloudflareDnsStateSchema = z
	.looseObject({
		id: z.string(),
		zone_id: z.string(),
		type: z.string(),
		name: z.string(),
		content: z.string(),
		proxied: z.coerce.boolean(),
		ttl: z.coerce.number(),
	})
	.brand<"CloudflareDnsState">()
	.readonly();

/** Codec: normalised ↔ Cloudflare */
export const cloudflareDnsCodec = z.codec(
	dnsRecordSpecSchema, // input schema: normalised spec
	cloudflareDnsStateSchema, // output schema: Cloudflare state
	{
		// Normalised → Cloudflare (used before create/update)
		decode: (spec) => ({
			type: spec.type,
			name: spec.domain,
			content: spec.value,
			ttl: spec.ttl,
			proxied: spec.proxied,
		}),

		// Cloudflare → normalised (used after read, for convergence checking)
		encode: (state) => ({
			kind: "DnsRecord" as const,
			domain: state.name,
			type: state.type as DnsRecordSpec["type"],
			value: state.content,
			ttl: state.ttl,
			proxied: state.proxied,
		}),
	},
);
```

```typescript
// src/providers/aws/route53-record-codec.ts
import { z } from "zod";
import { dnsRecordSpecSchema } from "../../core/schemas/dns-record";

/** AWS Route53's API shape for a resource record set.
 *  looseObject: Route53 returns many fields we don't model.
 *  brand: prevents passing this where Cloudflare state is expected. */
const route53RecordStateSchema = z
	.looseObject({
		Name: z.string(),
		Type: z.string(),
		TTL: z.coerce.number().optional(),
		ResourceRecords: z.array(z.object({ Value: z.string() })).optional(),
		AliasTarget: z.object({ DNSName: z.string() }).optional(),
	})
	.brand<"Route53DnsState">()
	.readonly();

/** Codec: normalised ↔ AWS Route53 */
export const route53DnsCodec = z.codec(
	dnsRecordSpecSchema,
	route53RecordStateSchema,
	{
		decode: (spec) => ({
			Name: `${spec.domain}.`, // Route53 requires trailing dot
			Type: spec.type,
			TTL: spec.ttl,
			ResourceRecords: [{ Value: spec.value }],
		}),

		encode: (state) => ({
			kind: "DnsRecord" as const,
			domain: state.Name.replace(/\.$/, ""), // strip trailing dot
			type: state.Type as DnsRecordSpec["type"],
			value:
				state.ResourceRecords?.[0]?.Value ?? state.AliasTarget?.DNSName ?? "",
			ttl: state.TTL ?? 300,
			proxied: false, // Route53 has no proxy concept
		}),
	},
);
```

#### Using the codec in the ResourcePort

The `ResourcePort` uses the codec's `decode` direction to transform specs before calling the SDK, and the engine uses `encode` to normalise state for convergence checking:

```typescript
// src/providers/cloudflare/dns-record.ts
import type { ResourcePort } from "infrasync";
import {
	dnsRecordSpecSchema,
	dnsRecordIdentitySchema,
	dnsRecordDesiredStateSchema,
} from "../../core/schemas/dns-record";
import { cloudflareDnsCodec } from "./dns-record-codec";
import type { DnsRecordSpec } from "../../core/schemas/dns-record";

export class CloudflareDnsRecord implements ResourcePort<
	typeof dnsRecordSpecSchema,
	typeof cloudflareDnsCodec._output
> {
	readonly kind = "DnsRecord";
	readonly specSchema = dnsRecordSpecSchema;
	readonly stateSchema = cloudflareDnsCodec._output; // Cloudflare-specific state schema
	readonly identitySchema = dnsRecordIdentitySchema;
	readonly desiredStateSchema = dnsRecordDesiredStateSchema;
	readonly codec = cloudflareDnsCodec;

	constructor(private client: Cloudflare) {}

	async read(spec: DnsRecordSpec) {
		// codec.decode transforms normalised spec into Cloudflare lookup params
		const cfParams = this.codec.decode(spec);
		const zone = await this.client.zones.list({
			name: extractZone(spec.domain),
		});
		const records = await this.client.dns.records.list({
			zone_id: zone.result[0].id,
			type: cfParams.type as any,
			name: { exact: cfParams.name },
		});
		return records.result[0]; // raw Cloudflare state — engine will encode() it back
	}

	async create(spec: DnsRecordSpec) {
		const cfParams = this.codec.decode(spec);
		const zone = await this.client.zones.list({
			name: extractZone(spec.domain),
		});
		return this.client.dns.records.create({
			zone_id: zone.result[0].id,
			...cfParams,
		});
	}

	async update(id: string, spec: DnsRecordSpec) {
		const cfParams = this.codec.decode(spec);
		const zone = await this.client.zones.list({
			name: extractZone(spec.domain),
		});
		return this.client.dns.records.update(id, {
			zone_id: zone.result[0].id,
			...cfParams,
		});
	}
}
```

#### The user writes one spec, targets any provider

```typescript
const result = await sync({
  providers: {
    cloudflare: { apiToken: process.env.CLOUDFLARE_API_TOKEN },
    aws: { region: "eu-west-2", credentials: { ... } },
  },
  resources: [
    // Same spec shape — only the provider field changes
    {
      provider: "cloudflare",
      kind: "DnsRecord",
      domain: "app.example.com",
      type: "CNAME",
      value: "my-app.pages.dev",
      ttl: 300,
      proxied: true,               // Cloudflare-specific, ignored by AWS codec
    },
    {
      provider: "aws",
      kind: "DnsRecord",
      domain: "api.example.com",
      type: "CNAME",
      value: "my-bucket.s3.amazonaws.com",
      ttl: 60,
      // proxied omitted — codec defaults to false
    },
  ],
});
```

The engine decodes each spec through the target provider's codec before calling `read`/`create`/`update`, and encodes the state back for convergence checking. Provider-specific fields (like Cloudflare's `proxied`) are preserved in the normalised spec — codecs for providers that don't support them simply ignore them during `decode` and supply a default during `encode`.

#### What codecs buy you

| Without codecs                                                                        | With codecs                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Each provider defines its own spec schema — different field names, different shapes   | One normalised spec schema per resource kind, shared across all providers      |
| Switching providers means rewriting resource specs                                    | Change `provider: "cloudflare"` to `provider: "aws"` — the spec stays the same |
| Convergence checking must handle provider-specific shapes                             | Engine compares normalised state, so convergence logic is provider-agnostic    |
| Provider-specific quirks (trailing dots, different enum values) leak into user config | Codecs absorb quirks — user writes clean, normalised values                    |

#### When not to use codecs

Not every resource kind benefits from normalisation. Some resources are provider-specific by nature — Cloudflare Access policies or AWS IAM roles have no equivalent on other providers. For these, the adapter defines its own `specSchema` without a codec. The codec layer is opt-in: normalise where it adds value, leave provider-specific resources in their native shape.

### Adapters (the implementations)

Adapters are concrete implementations of the ports for a specific provider. Each adapter:

1. Depends on the provider's npm SDK package.
2. Implements `ProviderPort` with `connect()` initialising the SDK client.
3. Implements `ResourcePort` for each supported resource kind, translating between InfraSync's spec types and the provider SDK's request/response types.
4. Handles provider-specific concerns: pagination, rate limiting, error mapping, retry logic.

Adapters live in `src/providers/<name>/` and are registered with the sync engine at configuration time. They are the only part of the codebase that imports provider SDKs.

### Built-in Providers

| Provider       | Status  | npm Package                                                                                                                                                                | Resource Kinds                                                                                                                                               |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cloudflare** | Initial | [`cloudflare`](https://www.npmjs.com/package/cloudflare) — official TypeScript SDK, v5.x, ~1M weekly downloads                                                             | `DnsRecord`, `AccessApplication`, `AccessPolicy`, `IdentityProvider`, `PagesCustomDomain`                                                                    |
| **AWS**        | Planned | [`@aws-sdk/client-*`](https://www.npmjs.com/package/@aws-sdk/client-s3) — official modular SDK, one package per service, v3.x, ~25M weekly downloads                       | `S3Bucket`, `DynamodbTable`, `LambdaFunction`, `IamRole`, `IamPolicy`, `CloudFrontDistribution`, `Route53Record`, `Ec2SecurityGroup`, `SnsTopic`, `SqsQueue` |
| **GCP**        | Planned | [`@google-cloud/*`](https://www.npmjs.com/package/@google-cloud/storage) — official client libraries, one package per service, v7.x, ~9M weekly downloads                  | `StorageBucket`, `CloudFunction`, `IamServiceAccount`, `DnsRecordSet`, `PubSubTopic`, `CloudRunService`                                                      |
| **GitHub**     | Planned | [`@octokit/rest`](https://www.npmjs.com/package/@octokit/rest) — official GitHub REST API client, v22.x, ~14M weekly downloads                                             | `Repository`, `BranchProtection`, `Team`, `TeamRepository`, `ActionsSecret`                                                                                  |
| **Vercel**     | Planned | [`@vercel/sdk`](https://www.npmjs.com/package/@vercel/sdk) — official type-safe TypeScript SDK (beta), v1.x, covers projects, domains, env vars, DNS, deployments          | `Project`, `Domain`, `EnvironmentVariable`                                                                                                                   |
| **Supabase**   | Planned | [`supabase-management-js`](https://www.npmjs.com/package/supabase-management-js) — community-maintained under `supabase-community`, auto-generated from OpenAPI spec, v2.x | `Project`, `Database`, `AuthConfig`                                                                                                                          |

### Writing a Custom Provider

Any team can write a provider adapter for an internal platform or a service not yet supported. You define Zod schemas for your config, spec, and state types, implement the two ports, and register the adapter in your configuration.

#### 1. Define Zod schemas for config, spec, and state

Zod schemas are the single source of truth. TypeScript types are inferred from them — no separate `interface` declarations needed.

```typescript
// schemas.ts
import { z } from "zod";

/** Provider configuration — validated at connect() time */
export const configSchema = z.object({
	baseUrl: z.url(),
	apiKey: z.string().min(1),
});
export type InternalPlatformConfig = z.infer<typeof configSchema>;

/** Desired configuration for a Service resource */
export const serviceSpecSchema = z.object({
	name: z.string().min(1), // identity field
	image: z.string().min(1), // desired state field
	replicas: z.number().int().min(1).max(100), // desired state field
	env: z.record(z.string(), z.string()), // desired state field
});
export type ServiceSpec = z.infer<typeof serviceSpecSchema>;

/** Current state returned by the provider API */
export const serviceStateSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	image: z.string(),
	replicas: z.number(),
	env: z.record(z.string(), z.string()),
	status: z.enum(["running", "stopped", "deploying"]),
});
export type ServiceState = z.infer<typeof serviceStateSchema>;

/** Identity sub-schema — picks only the fields used for resource lookup */
export const serviceIdentitySchema = serviceSpecSchema.pick({ name: true });

/** Desired state sub-schema — picks only the fields the engine should enforce */
export const serviceDesiredStateSchema = serviceSpecSchema.pick({
	image: true,
	replicas: true,
	env: true,
});
```

Why `.pick()` for identity and desired state? The engine needs to know which fields identify a resource versus which fields it should enforce. `.pick()` produces a sub-schema whose shape is guaranteed to be a subset of `specSchema` — it cannot drift from the spec definition.

#### 2. Implement the `ResourcePort`

```typescript
// service-resource.ts
import type { ResourcePort } from "infrasync";
import {
	serviceSpecSchema,
	serviceStateSchema,
	serviceIdentitySchema,
	serviceDesiredStateSchema,
} from "./schemas";
import type { ServiceSpec, ServiceState } from "./schemas";

export class ServiceResource implements ResourcePort<
	typeof serviceSpecSchema,
	typeof serviceStateSchema
> {
	readonly kind = "Service";
	readonly specSchema = serviceSpecSchema;
	readonly stateSchema = serviceStateSchema;
	readonly identitySchema = serviceIdentitySchema;
	readonly desiredStateSchema = serviceDesiredStateSchema;

	constructor(private client: InternalPlatformClient) {}

	async read(spec: ServiceSpec): Promise<ServiceState | undefined> {
		const response = await this.client.get(`/services/${spec.name}`);
		if (response.status === 404) return undefined;
		// stateSchema.safeParse() is called by the engine — no need to validate here
		return response.json() as Promise<ServiceState>;
	}

	async create(spec: ServiceSpec): Promise<ServiceState> {
		const response = await this.client.post("/services", {
			body: JSON.stringify(spec),
		});
		return response.json() as Promise<ServiceState>;
	}

	async update(id: string, spec: ServiceSpec): Promise<ServiceState> {
		const response = await this.client.patch(`/services/${id}`, {
			body: JSON.stringify(spec),
		});
		return response.json() as Promise<ServiceState>;
	}

	// No isConverged() needed — the engine compares desiredStateSchema fields
	// generically using deep equality.
}
```

#### 3. Implement the `ProviderPort`

```typescript
// index.ts
import { defineProvider } from "infrasync";
import type { ProviderPort } from "infrasync";
import { configSchema } from "./schemas";
import type { InternalPlatformConfig } from "./schemas";
import { ServiceResource } from "./service-resource";
import { InternalPlatformClient } from "./client";

export const internalPlatformProvider = defineProvider<typeof configSchema>({
	name: "internal-platform",
	configSchema,

	client: undefined as InternalPlatformClient | undefined,

	async connect(config: InternalPlatformConfig) {
		// config has already been validated by configSchema.safeParse()
		this.client = new InternalPlatformClient(config.baseUrl, config.apiKey);
		await this.client.get("/health");
	},

	async disconnect() {
		this.client = undefined;
	},

	supportedKinds() {
		return ["Service"];
	},

	resourceHandler(kind: string) {
		if (kind === "Service") return new ServiceResource(this.client!);
		throw new Error(`Unsupported resource kind: ${kind}`);
	},
});
```

#### 4. Register and use

```typescript
import { sync } from "infrasync";
import { internalPlatformProvider } from "./providers/internal-platform";

const result = await sync({
	providers: {
		"internal-platform": {
			baseUrl: "https://infra.internal",
			apiKey: process.env.INTERNAL_API_KEY,
		},
	},
	customProviders: [internalPlatformProvider],
	resources: [
		{
			provider: "internal-platform",
			kind: "Service",
			name: "billing-api",
			image: "registry.internal/billing-api:latest",
			replicas: 3,
			env: { NODE_ENV: "production", PORT: "3000" },
		},
	],
});
```

At runtime, the engine:

1. `safeParse()`s the raw config through `configSchema` before calling `connect()`. All issues are collected across all resources before reporting.
2. `safeParse()`s each resource through `specSchema` before calling `read()`, `create()`, or `update()`. Refinements and defaults are applied.
3. `safeParse()`s each API response through `stateSchema`. Extra fields pass through (loose), values are coerced (string → number), the result is branded and frozen.
4. Compares `desiredStateSchema.parse(spec)` against `desiredStateSchema.parse(state)` for convergence.

If any safeParse fails, the engine produces structured errors with exact field paths — no silent failures, no `as` casts hiding mismatches, no one-at-a-time error reporting.

#### Checklist for new providers

- [ ] Define Zod schemas (single source of truth for types and validation):
  - [ ] `configSchema` — `z.strictObject()` for credentials, base URL, region, etc. Rejects unknown keys.
  - [ ] `specSchema` — `z.object()` with `z.default()` for optional fields, `z.refine()` for cross-field rules, `refable()` for fields that accept `$ref`, string formats (`z.hostname()`, `z.url()`, `z.cidrv4()`) where appropriate
  - [ ] `stateSchema` — `z.looseObject().brand().readonly()` with `z.coerce` for stringly-typed fields. Tolerates extra API fields, prevents type mix-ups, freezes against mutation.
  - [ ] `identitySchema` — `specSchema.pick({ ... })` with identity fields only
  - [ ] `desiredStateSchema` — `specSchema.pick({ ... })` with desired-state fields only
- [ ] Implement `ResourcePort` for each kind:
  - [ ] Expose the schemas as readonly properties
  - [ ] `read()` — query the API, return `undefined` if not found
  - [ ] `create()` — provision a new resource
  - [ ] `update()` — modify an existing resource
  - [ ] No `isConverged()` needed — the engine does this generically
- [ ] Implement `ProviderPort`:
  - [ ] Expose `configSchema`
  - [ ] `connect()` — initialise SDK client, validate credentials
  - [ ] `disconnect()` — clean up resources
  - [ ] `supportedKinds()` — list resource kind strings
  - [ ] `resourceHandler()` — route kind string to the correct `ResourcePort`
- [ ] Handle provider-specific concerns: pagination, rate limiting, error mapping
- [ ] Register via `customProviders` in the sync configuration

## Comparison with Terraform

|                         | InfraSync                                 | Terraform                                  |
| ----------------------- | ----------------------------------------- | ------------------------------------------ |
| **State**               | None — reads from provider API            | Local or remote state file                 |
| **Language**            | TypeScript                                | HCL                                        |
| **Locking**             | Not needed                                | Required for team use                      |
| **State drift**         | Impossible by design                      | Possible; requires `terraform refresh`     |
| **Drift detection**     | Every run is a drift check                | Separate `terraform plan` step             |
| **Type safety**         | Full (TypeScript)                         | Partial (HCL validation)                   |
| **Extensibility**       | Write a provider adapter in TypeScript    | Write a Terraform provider in Go           |
| **Data sources**        | Same resource type with `mode: "read"`    | Separate `data` blocks                     |
| **Cross-provider refs** | `$ref()` with DAG resolution              | `data` sources + implicit dependency graph |
| **Multi-provider**      | Resources from any provider in one config | Same (provider plugin system)              |
| **Learning curve**      | TypeScript knowledge transfers            | HCL and Terraform-specific concepts        |
| **Orphan handling**     | No state → no orphans                     | `terraform state rm` for cleanup           |
| **Concurrency**         | Provider API rate limits only             | State lock contention                      |

## Limitations

Trade-offs from the stateless design:

- **No resource deletion.** Without state, InfraSync cannot know whether a resource was previously managed and should be removed. It only creates and updates. Deletion is a deliberate operation outside its scope — this is a safety feature, not a bug.
- **API-dependent identity matching.** Resources are matched by identity fields (name, domain, type), not by provider-assigned IDs. If a provider's API cannot reliably list and filter by these fields, matching may be ambiguous.
- **Rate limits.** Every run queries provider APIs to read current state. For large infrastructures, this may hit rate limits. Terraform avoids this by reading from local state.
- **No cycles.** The dependency graph must be acyclic. If `$ref` and `dependsOn` form a cycle, the engine fails at DAG-build time with the cycle path. This is inherent to any declarative DAG — cycles mean there is no valid processing order.
- **`$ref` paths must be known statically.** The path in `$ref(handle, "path")` is a static string literal, not a runtime expression. Dynamic path computation (e.g. building a path from a variable) is not supported. This constraint enables `DeepPath<T>` type derivation and compile-time validation.

## Project Structure

```
src/
  core/
    sync.ts                # Main sync engine (build DAG → read → plan → apply)
    dag.ts                 # DAG construction, topological sort, cycle detection
    refs.ts                # $ref token type, RefToken<T>, DeepPath<T>, resolution
    plan.ts                # Plan computation and diffing
    resource.ts            # Resource model types and identity matching
    provider.ts            # Provider adapter interface and defineProvider
    schemas/               # Normalised spec schemas shared across providers
      dns-record.ts        # Normalised DnsRecord (works on Cloudflare, AWS, GCP)
      bucket.ts            # Normalised object storage bucket (S3, GCS, R2)
  providers/
    cloudflare/
      index.ts             # Cloudflare adapter registration
      access-app.ts        # AccessApplication resource handler
      access-policy.ts     # AccessPolicy resource handler
      dns-record.ts        # DnsRecord resource handler + codec
      dns-record-codec.ts  # Codec: normalised ↔ Cloudflare DNS shape
      identity-provider.ts # IdentityProvider resource handler
      pages-domain.ts      # PagesCustomDomain resource handler
    aws/
      index.ts             # AWS adapter registration
      route53-record.ts    # Route53Record resource handler + codec
      route53-record-codec.ts # Codec: normalised ↔ Route53 shape
      s3-bucket.ts         # S3Bucket resource handler + codec
      dynamodb-table.ts    # DynamodbTable resource handler
    github/
      index.ts             # GitHub adapter registration
      repository.ts        # Repository resource handler
  cli/
    index.ts               # CLI entry point
    commands/
      apply.ts             # Apply command
      plan.ts              # Plan command (dry run)
      drift.ts             # Drift detection command
  index.ts                 # Public API exports
```

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```
