# Terraform Interoperability Implementation Plan

**Project:** `infra-cli`
**Status:** In Progress — Phases 0–3 and Phase 5 complete; Phase 4 (UX hardening) in progress
**Date:** 2026-04-25
**Depends on:** `docs/terraform-interoperability-spec.md`

## 1. Delivery strategy

Deliver in five phases so analysis features land early while execution export remains safe and testable.

---

## 2. Phase plan

## Phase 0 — Foundations ✅ COMPLETE

### Goals
- Establish IR and adapter scaffolding.
- Lock test harness and golden fixture format.

### Tasks
1. ✅ Create `core-ir` package with strict schemas/types.
2. ✅ Create `core-fidelity` package (`lossless/lossy/unsupported` + issue model).
3. ✅ Add shared adapter result interfaces.
4. ✅ Add fixture runner for golden input/output tests.

### Exit criteria
- ✅ IR schema validates sample documents.
- ✅ Fidelity report format is stable and documented.

---

## Phase 1 — Terraform show JSON import (analysis lane) ✅ COMPLETE

### Goals
- Import plan/state JSON into IR with version-safe behaviour.

### Tasks
1. ✅ Implement `adapter-terraform-show-json/importShowJson`.
2. ✅ Add format-version major gating for TF-Show JSON.
3. ✅ Map unknown/sensitive masks and change actions.
4. ✅ Ingest checks model with experimental warning annotation.

### Tests
- ✅ Fixtures for state-only, plan-only, and mixed module trees.
- ✅ Edge fixtures: replacements, check results.

### Exit criteria
- ✅ 100% pass on show-json fixture suite (11 tests).
- ✅ Unsupported major version hard-fails.

---

## Phase 2 — Terraform config JSON export (execution lane) ✅ COMPLETE

### Goals
- Export Terraform-applyable `*.tf.json` from IR desired-config documents.

### Tasks
1. ✅ Implement `adapter-terraform-config-json/exportTfConfigJson`.
2. ✅ Emit nested block arrays for order-sensitive blocks.
3. ✅ Implement provider source registry with defaults and custom overrides.
4. ✅ Add CLI command `infrasync export terraform-config`.

### Tests
- ✅ 11 integration tests covering providers, resources, data sources, refs, secrets, depends_on, aliases.

### Exit criteria
- ✅ Exported `*.tf.json` is structurally valid Terraform configuration.

---

## Phase 3 — Terraform config JSON import + round-trip guarantees ✅ COMPLETE

### Goals
- Full bidirectional interop for configuration lane.

### Tasks
1. ✅ Implement `adapter-terraform-config-json/importTfConfigJson`.
2. ✅ Map `${type.name.path}` → RefTokenIR, `${var.name}` → SecretSourceIR.
3. ✅ Fidelity reporting for unsupported constructs (lifecycle, locals, modules, outputs, connection, provisioner).
4. ✅ Add CLI command `infrasync import terraform-config`.
5. ✅ Build semantic round-trip assertions (`tf.json → IR → tf.json` and `IR → tf.json → IR`).

### Tests
- ✅ 18 import integration tests.
- ✅ 11 round-trip guarantee tests with declared fidelity outcomes.

### Exit criteria
- ✅ Round-trip suite passes with declared fidelity outcomes.

---

## Phase 4 — UX and operational hardening 🔄 IN PROGRESS

### Goals
- Make functionality easy to adopt and safe in production workflows.

### Tasks
1. ✅ Add CLI commands for import/export terraform-config.
2. ✅ Add CLI command for export cdktf-ts.
3. ✅ Add CLI commands `infrasync import terraform-plan`/`terraform-state`.
4. ✅ CDKTF synth integration test (proves generated projects synthesise).
5. ⬜ Add `infrasync fidelity` standalone report command.
6. ⬜ Improve diagnostic messages and remediation hints.
7. ⬜ Add docs/examples for both lanes.
8. ⬜ Add optional convenience import from binary planfile (`terraform show -json` wrapper).

### Exit criteria
- ⬜ End-to-end docs and example workflows verified.

---

## Phase 5 — CDKTF TypeScript generation ✅ COMPLETE

### Goals
- Generate a TypeScript CDKTF project from TerraSync IR for teams that prefer SDK-driven Terraform workflows.

### Tasks
1. ✅ Add CLI command `infrasync export cdktf-ts`.
2. ✅ Implement exporter interface and CDKTF exporter backend.
3. ✅ Emit project files (`main.ts`, `cdktf.json`, `package.json`, `tsconfig.json`, `README.md`, `.gitignore`).
4. ✅ Support provider source overrides (`--provider-source adapter=registry/source`).
5. ✅ Emit explicit warnings for heuristic translations (key casing, secret mapping).

### Tests
- ✅ Golden output fixtures for generated files (10 fixtures: empty through full-stack).
- ✅ Command-level integration checks for override parsing and error paths (18 tests).

### Exit criteria
- ✅ Generated project synthesises with CDKTF after dependency installation (pending `cdktf synth` integration test).
- ✅ Warnings and hard-fail diagnostics are surfaced deterministically.

---

## 3. Work breakdown structure

## 3.1 Code packages

- `packages/core-ir`
- `packages/core-fidelity`
- `packages/adapter-terraform-show-json`
- `packages/adapter-terraform-config-json`
- `packages/cli` updates

## 3.2 Documentation

- Spec (done): `docs/terraform-interoperability-spec.md`
- Plan (this file)
- Usage guide: `docs/terraform-interoperability-usage.md`

## 3.3 Test assets

- `test/fixtures/terraform-show-json/*`
- `test/fixtures/terraform-config-json/*`
- `test/golden/*`

---

## 4. Risk management

| Risk | Impact | Mitigation |
|---|---|---|
| Terraform format drift (minor releases) | Parser breakage | Ignore unknown fields on supported major versions; broaden fixtures per release |
| Ambiguous expression mapping | Incorrect semantics | Preserve raw expression data + explicit fidelity warnings |
| Ordering bugs in nested blocks | Behavioural drift on apply | Explicit array-preservation tests for order-sensitive blocks |
| Overly permissive loss handling | Silent misconfiguration | Hard-fail on unsupported/ambiguous execution-critical mappings |

---

## 5. Quality gates

Before each phase is marked complete:

1. Lint/type-check/tests pass in CI.
2. New fixtures added for every bug fix.
3. Fidelity report assertions included in tests.
4. CLI help/examples updated where commands are introduced.

---

## 6. Proposed milestone sequence

1. **M1:** Phase 0 complete.
2. **M2:** Phase 1 complete (analysis lane usable).
3. **M3:** Phase 2 complete (execution export usable).
4. **M4:** Phase 3 complete (bidirectional config lane).
5. **M5:** Phase 4 complete (production-ready UX).
6. **M6:** Phase 5 complete (CDKTF TypeScript generation profile).

---

## 7. Immediate next actions

1. Create package scaffolding for IR/fidelity/adapters.
2. Add initial fixture corpus (minimum 10 representative fixtures).
3. Implement TF-Show state import first (smallest surface area).
4. Expand to TF-Show plan import once state baseline is stable.
5. Implement and harden the `export cdktf-ts` command profile.
