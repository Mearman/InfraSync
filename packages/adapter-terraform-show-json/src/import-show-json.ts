/**
 * Adapter for importing Terraform state JSON (`terraform show -json <state>`)
 * and plan JSON (`terraform show -json <plan>`) into Terraform IR.
 *
 * This is the **analysis lane** — read-only, no apply capability.
 *
 * Schemas live in `schemas.ts`. Parse at the adapter boundary only.
 */
import { FidelityReportBuilder } from "@infrasync/core-fidelity/fidelity";
import type { AdapterResult } from "@infrasync/core-fidelity/fidelity";
import {
  tfShowStateEnvelopeSchema,
  tfShowPlanEnvelopeSchema,
  type TFShowResourceChange,
  type TFShowValues,
} from "./schemas.js";
import {
  parseTerraformAddress,
  type TerraformIR,
  type TerraformResourceIR,
  type TerraformResourceState,
  type TerraformResourceChange as TerraformIRResourceChange,
  type TerraformChangeAction,
  type TerraformOutputIR,
  type TerraformCheckIR,
  type TerraformCheckStatus,
  type TerraformSourceMeta,
} from "@infrasync/core-ir/schemas";

// ─── Version policy ──────────────────────────────────────────────────────────

const SUPPORTED_STATE_FORMAT_VERSIONS = new Set([
  "1.0",
  "1.1",
  "1.2",
  "1.3",
  "1.4",
]);
const SUPPORTED_PLAN_FORMAT_VERSIONS = new Set(["1.0", "1.1", "1.2"]);

function getMajorVersion(formatVersion: string): number {
  const separatorIndex = formatVersion.indexOf(".");
  if (separatorIndex === -1) return Number(formatVersion);
  return Number(formatVersion.slice(0, separatorIndex));
}

// ─── State import ────────────────────────────────────────────────────────────

/**
 * Import a Terraform state JSON document into Terraform IR.
 *
 * @throws Error if the format version has an unsupported major version.
 */
export function importStateJson(raw: string): AdapterResult<TerraformIR> {
  const parsed: unknown = JSON.parse(raw);
  const envelope = tfShowStateEnvelopeSchema.parse(parsed);
  const reporter = new FidelityReportBuilder();

  const formatVersion = envelope.format_version;
  gateVersion(formatVersion, "state", reporter);

  const source: TerraformSourceMeta = {
    system: "terraform",
    format: "tf_show_state_json",
    terraformVersion: envelope.terraform_version,
    formatVersion,
  };

  const resources: TerraformResourceIR[] = [];
  const outputs: TerraformOutputIR[] = [];

  if (envelope.values !== undefined) {
    collectStateOutputs(envelope.values, outputs);
    collectStateResources(envelope.values, [], resources, reporter);
  }

  return reporter.result<TerraformIR>({
    irVersion: "1.0",
    kind: "observed_state",
    source,
    resources: [...resources],
    outputs: [...outputs],
    checks: [],
    extensions: {},
  });
}

// ─── Plan import ─────────────────────────────────────────────────────────────

/**
 * Import a Terraform plan JSON document into Terraform IR.
 *
 * @throws Error if the format version has an unsupported major version.
 */
export function importPlanJson(raw: string): AdapterResult<TerraformIR> {
  const parsed: unknown = JSON.parse(raw);
  const envelope = tfShowPlanEnvelopeSchema.parse(parsed);
  const reporter = new FidelityReportBuilder();

  const formatVersion = envelope.format_version;
  gateVersion(formatVersion, "plan", reporter);

  const source: TerraformSourceMeta = {
    system: "terraform",
    format: "tf_show_plan_json",
    terraformVersion: envelope.terraform_version,
    formatVersion,
  };

  const resources: TerraformResourceIR[] = [];
  const outputs: TerraformOutputIR[] = [];
  const checks: TerraformCheckIR[] = [];

  // Collect planned values
  if (envelope.planned_values !== undefined) {
    collectStateOutputs(envelope.planned_values, outputs);
    collectStateResources(envelope.planned_values, [], resources, reporter);
  }

  // Overlay change information
  if (envelope.resource_changes !== undefined) {
    overlayChanges(envelope.resource_changes, resources, reporter);
  }

  // Collect checks (experimental in Terraform)
  if (envelope.checks !== undefined) {
    collectChecks(envelope.checks, checks, reporter);
  }

  return reporter.result<TerraformIR>({
    irVersion: "1.0",
    kind: "planned_change",
    source,
    resources: [...resources],
    outputs: [...outputs],
    checks: [...checks],
    extensions: {},
  });
}

// ─── Version gating ──────────────────────────────────────────────────────────

function gateVersion(
  formatVersion: string,
  kind: "state" | "plan",
  reporter: FidelityReportBuilder,
): void {
  const supported =
    kind === "state"
      ? SUPPORTED_STATE_FORMAT_VERSIONS
      : SUPPORTED_PLAN_FORMAT_VERSIONS;

  if (supported.has(formatVersion)) return;

  const major = getMajorVersion(formatVersion);

  if (major !== 1) {
    throw new Error(
      `Unsupported ${kind} format_version "${formatVersion}". ` +
        `Only major version 1 is supported. ` +
        `Supported versions: ${[...supported].join(", ")}`,
    );
  }

  reporter.addIssue({
    path: "format_version",
    class: "lossy",
    message: `Unknown ${kind} format_version "${formatVersion}" — parsing may be incomplete`,
    action: "approximated",
  });
}

// ─── State output collection ─────────────────────────────────────────────────

function collectStateOutputs(
  valuesContainer: TFShowValues,
  outputs: TerraformOutputIR[],
): void {
  if (valuesContainer.outputs === undefined) return;

  for (const [name, output] of Object.entries(valuesContainer.outputs)) {
    if (!("value" in output) && !("sensitive" in output)) continue;
    outputs.push({
      name,
      value: "value" in output ? output.value : undefined,
      sensitive:
        "sensitive" in output && typeof output.sensitive === "boolean"
          ? output.sensitive
          : false,
    });
  }
}

// ─── State resource collection ───────────────────────────────────────────────

function collectStateResources(
  valuesContainer: TFShowValues,
  modulePath: readonly string[],
  resources: TerraformResourceIR[],
  reporter: FidelityReportBuilder,
): void {
  const rootModule = valuesContainer.root_module;
  if (rootModule === undefined) return;

  if (rootModule.resources !== undefined) {
    for (const rawResource of rootModule.resources) {
      const resource = buildStateResource(rawResource, modulePath, reporter);
      if (resource !== undefined) {
        resources.push(resource);
      }
    }
  }

  if (rootModule.child_modules !== undefined) {
    for (const childModule of rootModule.child_modules) {
      const address = childModule.address;
      const moduleName =
        address !== undefined ? extractModuleName(address) : undefined;

      const childPath =
        moduleName !== undefined ? [...modulePath, moduleName] : modulePath;

      collectStateResources(
        { root_module: childModule },
        childPath,
        resources,
        reporter,
      );
    }
  }
}

function buildStateResource(
  raw: Record<string, unknown>,
  modulePath: readonly string[],
  reporter: FidelityReportBuilder,
): TerraformResourceIR | undefined {
  const address = getStringField(raw, "address");
  if (address === undefined) {
    reporter.addIssue({
      path: "resource",
      class: "lossy",
      message: "Resource missing address field — skipping",
      action: "dropped",
    });
    return undefined;
  }

  const mode = getStringField(raw, "mode");
  const type = getStringField(raw, "type");
  const name = getStringField(raw, "name");
  const providerName = getStringField(raw, "provider_name");
  const values = getObjectField(raw, "values");
  const sensitiveValues = getArrayField(raw, "sensitive_values");

  const addressParts = parseTerraformAddress(address);

  const resolvedParts: typeof addressParts = {
    modulePath:
      modulePath.length > 0 ? [...modulePath] : addressParts.modulePath,
    mode: mode === "data" ? "data" : addressParts.mode,
    type: type ?? addressParts.type,
    name: name ?? addressParts.name,
    instanceKey: addressParts.instanceKey,
  };

  let state: TerraformResourceState | undefined;
  if (values !== undefined) {
    state = {
      values,
      sensitiveMask:
        sensitiveValues === undefined || sensitiveValues.length === 0
          ? undefined
          : extractSensitiveMask(sensitiveValues),
    };
  }

  const knownFields = new Set([
    "address",
    "mode",
    "type",
    "name",
    "provider_name",
    "values",
    "sensitive_values",
    "depends_on",
    "index",
    "schema_version",
  ]);
  const rawExtensions = collectUnknownFields(raw, knownFields);
  const hasUnknownFields = Object.keys(rawExtensions).length > 0;

  if (hasUnknownFields) {
    reporter.addIssue({
      path: `resource.${address}`,
      class: "lossy",
      message: `Resource has unknown fields: ${Object.keys(rawExtensions).join(", ")}`,
      action: "preserved_in_extension",
    });
  }

  return {
    address,
    addressParts: resolvedParts,
    provider: {
      localName:
        providerName ??
        deriveProviderLocalName(resolvedParts.type, address, reporter),
      fullName: providerName,
    },
    state,
    extensions: {
      terraform: hasUnknownFields ? { raw: rawExtensions } : undefined,
    },
  };
}

// ─── Change overlay ──────────────────────────────────────────────────────────

function overlayChanges(
  changes: readonly TFShowResourceChange[],
  resources: TerraformResourceIR[],
  reporter: FidelityReportBuilder,
): void {
  const resourceByAddress = new Map<string, TerraformResourceIR>();
  for (const resource of resources) {
    resourceByAddress.set(resource.address, resource);
  }

  for (const changeEntry of changes) {
    const address = changeEntry.address;
    const actions = changeEntry.change?.actions;
    if (actions === undefined) continue;

    const mode = changeEntry.mode;
    const type = changeEntry.type;
    const name = changeEntry.name;
    const providerName = changeEntry.provider_name;

    if (mode === undefined || type === undefined || name === undefined) {
      reporter.addIssue({
        path: `resource_change.${address}`,
        class: "lossy",
        message: `Resource change missing required fields (mode=${String(mode)}, type=${String(type)}, name=${String(name)}) — skipping`,
        action: "dropped",
      });
      continue;
    }

    const validatedActions = validateChangeActions(actions);
    const derivedProviderName = providerName ?? type.split("_")[0];
    if (derivedProviderName === undefined || derivedProviderName.length === 0) {
      reporter.addIssue({
        path: `resource_change.${address}`,
        class: "lossy",
        message: `Resource change has no provider_name and it cannot be derived from type "${type}" — skipping`,
        action: "dropped",
      });
      continue;
    }

    const change: TerraformIRResourceChange = {
      address,
      previousAddress: changeEntry.previous_address,
      mode,
      type,
      name,
      instanceKey: parseInstanceKey(changeEntry.index),
      providerName: derivedProviderName,
      change: {
        actions: [...validatedActions],
        before: changeEntry.change?.before,
        after: changeEntry.change?.after,
        afterUnknown: changeEntry.change?.after_unknown,
        replacePaths: changeEntry.change?.replace_paths,
        actionReason: changeEntry.action_reason,
        importing: changeEntry.change?.importing,
      },
    };

    const existing = resourceByAddress.get(address);
    if (existing !== undefined) {
      const index = resources.indexOf(existing);
      resources[index] = {
        ...existing,
        change,
      };
    } else {
      // Resource in changes but not in planned_values (e.g. delete-only)
      const addressParts = parseTerraformAddress(address);
      resources.push({
        address,
        addressParts,
        provider: {
          localName:
            changeEntry.provider_name?.split("/").at(-1)?.split(".").at(0) ??
            addressParts.type.split("_")[0] ??
            "",
          fullName: changeEntry.provider_name,
        },
        change,
        extensions: {},
      });
    }
  }
}

function validateChangeActions(
  actions: readonly string[],
): readonly TerraformChangeAction[] {
  const valid = new Set<string>([
    "no-op",
    "create",
    "read",
    "update",
    "delete",
    "create-before-destroy",
    "destroy-before-create",
  ]);

  return actions.filter((action): action is TerraformChangeAction =>
    valid.has(action),
  );
}

function parseInstanceKey(key: unknown): string | number | undefined {
  if (typeof key === "number") return key;
  if (typeof key === "string") return key;
  return undefined;
}

// ─── Check collection ────────────────────────────────────────────────────────

function collectChecks(
  rawChecks: unknown,
  checks: TerraformCheckIR[],
  reporter: FidelityReportBuilder,
): void {
  if (typeof rawChecks !== "object" || rawChecks === null) return;

  reporter.addWarning(
    "Terraform checks are experimental — structure may change between versions",
  );

  if (!Array.isArray(rawChecks)) return;

  for (const checkGroup of rawChecks) {
    if (!isRecord(checkGroup)) continue;
    if (!("objects" in checkGroup)) continue;

    const groupAddress = getStringField(checkGroup, "address");

    const objects = getArrayField(checkGroup, "objects");

    if (objects === undefined) continue;

    for (const checkObj of objects) {
      const status = getStringField(checkObj, "status");
      const message = getStringField(checkObj, "message");
      const checkAddress =
        getStringField(checkObj, "address") ?? groupAddress ?? "unknown";

      if (status !== undefined) {
        checks.push({
          address: checkAddress,
          status: mapCheckStatus(status),
          message,
        });
      }
    }
  }
}

function mapCheckStatus(raw: string): TerraformCheckStatus {
  if (raw === "pass" || raw === "fail" || raw === "error") return raw;
  return "unknown";
}

// ─── Type guard ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function getStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function getObjectField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  if (isRecord(value)) return value;
  return undefined;
}

function getArrayField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown>[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function extractSensitiveMask(
  sensitiveValues: Record<string, unknown>[],
): string[] {
  return sensitiveValues.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const keys = Object.keys(entry);
    const firstKey = keys[0];
    if (firstKey === undefined) return [];
    return [firstKey];
  });
}

function collectUnknownFields(
  raw: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
): Record<string, unknown> {
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!knownFields.has(key)) {
      unknown[key] = value;
    }
  }
  return unknown;
}

function extractModuleName(address: string): string {
  const segments = address.split(".");
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === "module") {
      const next = segments[i + 1];
      if (next !== undefined) return next;
    }
  }
  return address;
}

function deriveProviderLocalName(
  resourceType: string,
  address: string,
  reporter: FidelityReportBuilder,
): string {
  const derived = resourceType.split("_")[0];
  if (derived !== undefined && derived.length > 0) {
    reporter.addIssue({
      path: `resource.${address}`,
      class: "lossy",
      message: `Provider name derived from resource type "${resourceType}" as "${derived}"`,
      action: "approximated",
    });
    return derived;
  }
  throw new Error(
    `Cannot determine provider for resource "${address}" with type "${resourceType}"`,
  );
}
