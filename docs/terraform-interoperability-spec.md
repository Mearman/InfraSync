# Terraform Interoperability Specification

**Project:** `infra-cli` (TerraSync interoperability)
**Status:** In Progress — Execution lane bidirectional, analysis lane import, and CDKTF export complete
**Date:** 2026-04-25

## 1. Objective

Provide bidirectional interoperability with Terraform across both supported JSON formats:

1. **Configuration JSON** (`*.tf.json`) for execution workflows (`plan`/`apply`).
2. **Internals JSON** (`terraform show -json`) for analysis workflows (plan/state inspection).

The design must keep execution and analysis lanes separate while sharing one canonical internal representation (IR).

---

## 2. Scope

### In scope
- Import/export: TerraSync IR ⇄ Terraform configuration JSON.
- Import only: Terraform plan/state JSON → TerraSync IR.
- Field-level fidelity reporting (`lossless`, `lossy`, `unsupported`).
- Strict version handling for Terraform internals JSON.

### Out of scope
- Generating Terraform binary plan files.
- Applying `terraform show -json` output directly.
- Implementing a full Terraform expression evaluator.

---

## 3. Terminology

- **TF-Config JSON:** `*.tf.json`, input language equivalent to HCL.
- **TF-Show JSON:** `terraform show -json <plan|state>`, output format for introspection.
- **TerraSync IR:** neutral internal model used by `infra-cli`.

---

## 4. Architecture

## 4.1 Lanes

1. **Execution lane:** `TerraSync IR ⇄ TF-Config JSON`
2. **Analysis lane:** `TF-Show JSON → TerraSync IR`

## 4.2 Components

- `adapters/terraform-config-json`
  - parse `*.tf.json` into IR
  - render IR to `*.tf.json`
- `adapters/terraform-show-json`
  - parse plan JSON into IR change model
  - parse state JSON into IR observed-state model
- `core/ir`
  - schema + validation
- `core/fidelity`
  - fidelity/loss diagnostics

---

## 5. Canonical IR (v1)

## 5.1 Envelope

```json
{
  "irVersion": "1.0",
  "kind": "desired_config | planned_change | observed_state",
  "source": {
    "system": "terraform",
    "format": "tf_config_json | tf_show_plan_json | tf_show_state_json",
    "terraformVersion": "optional",
    "formatVersion": "optional"
  },
  "resources": [],
  "modules": [],
  "outputs": [],
  "checks": [],
  "diagnostics": [],
  "extensions": {}
}
```

## 5.2 Resource model (minimum)

- `address` (opaque Terraform absolute address)
- `addressParts` (`modulePath`, `mode`, `type`, `name`, optional `instanceKey`)
- `provider` (`localName`, optional `fullName`, optional `alias`)
- `config` (`arguments`, `nestedBlocks`, `meta`)
- `state` (`values`, `unknownMask`, `sensitiveMask`)
- `change` (`actions`, `before`, `after`, `afterUnknown`, `replacePaths`, `actionReason`, etc)
- `extensions.terraform.raw` (unrecognised/raw fields for fidelity)

## 5.3 Expression model

Expression values are preserved as one of:
- `literal`
- `template`
- `reference`
- `unknown`

No runtime evaluation is performed.

---

## 6. Adapter contracts

```ts
type FidelityClass = "lossless" | "lossy" | "unsupported";

interface FidelityIssue {
  path: string;
  class: FidelityClass;
  message: string;
  action: "preserved_in_extension" | "approximated" | "dropped";
}

interface AdapterResult<T> {
  document: T;
  fidelity: {
    overall: FidelityClass;
    issues: FidelityIssue[];
  };
  warnings: string[];
}
```

Required behaviour:
- Unsupported major versions of TF-Show JSON must fail.
- Unknown fields on supported major versions must not fail.
- All lossy transformations must be reported.

---

## 7. Mapping rules

## 7.1 TF-Config JSON → IR

- Top-level block keys map to IR entities (`resource`, `data`, `module`, `output`, etc).
- Nested label objects map to `addressParts`.
- Argument values use Terraform JSON expression mapping rules.
- Order-sensitive nested blocks (e.g. `provisioner`) must preserve array order.
- Special literal-only fields (`module.source`, `variable.default`, etc) are marked literal in IR metadata.
- `"//"` comment properties are preserved in `extensions.terraform.raw.comments`.

## 7.2 IR → TF-Config JSON

- Emit only Terraform-valid configuration constructs.
- Reconstruct nested block arrays where order is significant.
- Emit literal-only fields as literal strings/values.
- Do not emit TerraSync-only semantics unless represented via valid Terraform fields.

## 7.3 TF-Show Plan JSON → IR

Map and preserve:
- `prior_state`
- `applyable`, `complete`, `errored`
- `planned_values`, `proposed_unknown`
- `resource_changes`, `output_changes`
- `resource_drift`, `relevant_attributes`
- `checks` (experimental upstream; still ingested)

Replacement semantics must be represented by action sets containing both `create` and `delete`.

## 7.4 TF-Show State JSON → IR

Map and preserve:
- `values` tree
- `terraform_version`

Note: deposed objects are not present in values representation.

---

## 8. Fidelity policy

### Classes
- **lossless:** semantics preserved.
- **lossy:** semantics approximated or stored only in extensions.
- **unsupported:** safe mapping not possible.

### Hard failures
- Unsupported TF-Show `format_version` major.
- Invalid required structure.
- Ambiguous transformation that could alter execution behaviour.

---

## 9. CLI surface (proposed)

```bash
infra-cli import terraform-config --file main.tf.json
infra-cli export terraform-config --in ir.json --out generated.tf.json

infra-cli import terraform-plan --file plan.show.json
infra-cli import terraform-state --file state.show.json

infra-cli export cdktf-ts --in ir.json --out ./generated/cdktf
infra-cli export cdktf-ts --in ir.json --out ./generated/cdktf --provider-source cloudflare=cloudflare/cloudflare

infra-cli fidelity --input adapter-result.json
```

Optional convenience:

```bash
infra-cli import terraform-plan --planfile tfplan
# internally runs: terraform show -json tfplan
```

---

## 10. Test requirements

1. Golden fixtures for TF-Config JSON covering all top-level block types.
2. Golden fixtures for TF-Show JSON across Terraform 1.3–1.15.
3. Edge-case fixtures for:
   - `count` / `for_each`
   - moved resources (`previous_address`)
   - imports (`importing.id`)
   - deposed instances
   - unknown/sensitive masks
4. Round-trip semantic equivalence for `tf.json -> IR -> tf.json`.
5. Contract tests for version-gating rules.

---

## 11. Acceptance criteria

Interoperability is accepted when:
- both lanes are implemented with stable interfaces,
- fidelity reports are emitted on every adapter operation,
- version-gating and round-trip tests pass,
- unsupported cases fail loudly with actionable diagnostics.

---

## 12. CDKTF TypeScript export profile

A secondary export profile should support generating a CDKTF TypeScript project directly from TerraSync IR:

- **Input:** TerraSync IR.
- **Output:** CDKTF project (`main.ts`, `cdktf.json`, `package.json`, `tsconfig.json`).
- **Mechanism:** emit Terraform JSON via CDKTF `addOverride`, not provider-specific generated constructs.
- **Provider mapping:** adapter name → Terraform provider source must be explicit and overridable.
- **Fidelity:** emit warnings for heuristic key conversions and secret mapping (`env` → `requireEnv`).

This profile is intended for reviewable bootstrap generation, not guaranteed lossless execution parity for all provider/resource semantics.
