# Terraform Interoperability Usage Guide

**Status:** Phase 4 (UX hardening) — in progress
**Last updated:** 2026-04-25

InfraSync provides bidirectional interoperability with Terraform across two JSON formats:

- **Execution lane** — Terraform Configuration JSON (`*.tf.json`) for `terraform plan`/`apply`
- **Analysis lane** — Terraform Show JSON (`terraform show -json`) for state/plan inspection

Both lanes share a fidelity reporting system that classifies every translation as `lossless`, `lossy`, or `unsupported`.

---

## Execution Lane

### Export: InfraIR → `*.tf.json`

Generate Terraform-applyable configuration JSON from an InfraSync IR:

```bash
# From an infra config file
infrasync export terraform-config --config infra.config.ts --out generated.tf.json

# From a serialised IR file
infrasync export terraform-config --ir infra.ir.json --out generated.tf.json

# Override provider source
infrasync export terraform-config --config infra.config.ts --out generated.tf.json \
  --provider-source cloudflare=my-registry/cloudflare
```

The output is a valid `*.tf.json` file:

```json
{
  "terraform": {
    "required_providers": {
      "cloudflare": { "source": "cloudflare/cloudflare" }
    }
  },
  "provider": {
    "cloudflare": { "api_token": "${env.CF_TOKEN}" }
  },
  "resource": {
    "cloudflare_dns_record": {
      "www": {
        "name": "example.com",
        "type": "A",
        "content": "1.2.3.4",
        "zone_id": "abc123",
        "ttl": 300
      }
    }
  }
}
```

Apply with Terraform:

```bash
terraform init
terraform plan -var-file=secrets.tfvars
terraform apply -var-file=secrets.tfvars
```

### Import: `*.tf.json` → InfraIR

Convert an existing Terraform JSON configuration into InfraSync IR:

```bash
infrasync import terraform-config --file main.tf.json --out infra.ir.json
```

The import adapter maps Terraform constructs to InfraSync IR:

| Terraform construct | InfraSync IR mapping |
|---|---|
| `resource` blocks | `ResourceIR` entries |
| `data` blocks | `ResourceIR` entries with data source flag |
| `provider` blocks | `ProviderInstanceIR` entries |
| `depends_on` | `dependsOn` arrays |
| `${type.name.path}` | `RefTokenIR` references |
| `${var.name}` | `SecretSourceIR` entries |

Unsupported constructs (`lifecycle`, `locals`, `module`, `output`, `connection`, `provisioner`) are reported as fidelity issues.

### Round-trip guarantees

The execution lane supports bidirectional round-tripping:

```bash
# IR → TF → IR
infrasync export terraform-config --ir infra.ir.json --out temp.tf.json
infrasync import terraform-config --file temp.tf.json --out roundtrip.ir.json

# TF → IR → TF
infrasync import terraform-config --file original.tf.json --out temp.ir.json
infrasync export terraform-config --ir temp.ir.json --out roundtrip.tf.json
```

Both directions are tested with structural equivalence assertions and declared fidelity outcomes. Known asymmetries:

- Resource names are normalised to snake_case during TF export
- Provider instance keys are derived from adapter names (PascalCase)
- Ref expressions preserve their original path structure

---

## Analysis Lane

### Import: Terraform State JSON

Import state from `terraform show -json`:

```bash
terraform show -json > state.json
infrasync import terraform-state --file state.json --out state.ir.json
```

### Import: Terraform Plan JSON

Import plan output from `terraform show -json`:

```bash
terraform show -json tfplan > plan.json
infrasync import terraform-plan --file plan.json --out plan.ir.json
```

Version gating is enforced:
- State format versions 1.0–1.4 are supported
- Plan format versions 1.0–1.2 are supported
- Unknown major versions hard-fail
- Unknown minor versions produce a `lossy` fidelity warning

---

## Fidelity Reporting

Every adapter operation produces a fidelity report classifying translations:

| Class | Meaning |
|---|---|
| `lossless` | All semantics preserved — round-trip safe |
| `lossy` | Semantics approximated or stored in extensions |
| `unsupported` | Safe mapping not possible |

### View fidelity inline

Import and export commands print fidelity reports automatically:

```bash
infrasync import terraform-config --file complex.tf.json
# Output includes:
#   ~ [lossy] lifecycle: create_before_destroy not modelled (approximated)
#   ✗ [unsupported] module: module blocks not supported (dropped)
```

### Standalone fidelity command

Display a fidelity report from any serialised adapter result:

```bash
# Human-readable
infrasync fidelity --file adapter-result.json

# JSON output
infrasync fidelity --file adapter-result.json --json
```

---

## CDKTF TypeScript Export

Generate a CDKTF TypeScript project from InfraSync IR:

```bash
infrasync export cdktf-ts --ir infra.ir.json --out ./cdktf-project
```

This produces a reviewable CDKTF scaffold:

```
cdktf-project/
├── main.ts          # CDKTF stack with addOverride() blocks
├── cdktf.json       # CDKTF project config
├── package.json     # Dependencies (cdktf, constructs, cdktf-cli)
├── tsconfig.json    # TypeScript config
├── README.md        # Generated project README
└── .gitignore
```

With provider source overrides:

```bash
infrasync export cdktf-ts --ir infra.ir.json --out ./cdktf \
  --provider-source cloudflare=cloudflare/cloudflare \
  --provider-source aws=hashicorp/aws
```

After generation, synthesise with Terraform:

```bash
cd cdktf-project
pnpm install
pnpm tsx main.ts    # Produces cdktf.out/ with Terraform JSON
```

---

## Adapter Packages

| Package | Purpose |
|---|---|
| `@infrasync/adapter-terraform-config-json` | Bidirectional `*.tf.json` ⇄ InfraIR |
| `@infrasync/adapter-terraform-show-json` | Import `terraform show -json` state/plan → TerraformIR |
| `@infrasync/core-fidelity` | Fidelity report builder and schemas |
| `@infrasync/core-ir` | TerraformIR schemas and address parser |

---

## Programmatic Usage

### Export TF Config JSON

```typescript
import { exportTfConfigJson } from "@infrasync/adapter-terraform-config-json/export-config-json";

const result = exportTfConfigJson(ir, {
  providerSources: { cloudflare: "cloudflare/cloudflare" },
});

console.log(result.content); // JSON string
console.log(result.fidelity.overall); // "lossless" | "lossy" | "unsupported"
console.log(result.warnings); // string[]
```

### Import TF Config JSON

```typescript
import { importTfConfigJson } from "@infrasync/adapter-terraform-config-json/import-config-json";

const result = importTfConfigJson(tfJsonString);
console.log(result.ir); // InfraIR
console.log(result.fidelity.issues); // FidelityIssue[]
```

### Import TF State/Plan

```typescript
import { importStateJson, importPlanJson } from "@infrasync/adapter-terraform-show-json/import-show-json";

const stateResult = importStateJson(stateJsonString);
console.log(stateResult.document); // TerraformIR

const planResult = importPlanJson(planJsonString);
console.log(planResult.document); // TerraformIR
```
