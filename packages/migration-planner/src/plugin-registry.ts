/**
 * Plugin registry for the migration planner.
 *
 * Manages registration and lookup of provider-specific plugins that define
 * resource matching, safety rules, and attribute path mapping.
 */
import type {
  MigrationPlugin,
  MigrationDirection,
  ResourceMapping,
  SafetyRule,
  AttributeMapper,
} from "./schemas.js";

export class PluginRegistry {
  private readonly plugins = new Map<string, MigrationPlugin>();

  register(plugin: MigrationPlugin): void {
    const existing = this.plugins.get(plugin.adapterName);
    if (existing !== undefined && existing.name !== plugin.name) {
      throw new Error(
        `Adapter "${plugin.adapterName}" already registered as "${existing.name}", cannot re-register as "${plugin.name}"`,
      );
    }
    this.plugins.set(plugin.adapterName, plugin);
  }

  get(adapterName: string): MigrationPlugin | undefined {
    return this.plugins.get(adapterName);
  }

  all(): readonly MigrationPlugin[] {
    return [...this.plugins.values()];
  }

  /** Resolve the InfraSync kind for a TF resource type, or undefined */
  resolveInfraKind(tfType: string): string | undefined {
    for (const plugin of this.plugins.values()) {
      const mapping = plugin.resourceMappings.find((m) => m.tfType === tfType);
      if (mapping !== undefined) return mapping.infraKind;
    }
    return undefined;
  }

  /** Resolve the TF type for an InfraSync kind, or undefined */
  resolveTfType(infraKind: string): string | undefined {
    for (const plugin of this.plugins.values()) {
      const mapping = plugin.resourceMappings.find(
        (m) => m.infraKind === infraKind,
      );
      if (mapping !== undefined) return mapping.tfType;
    }
    return undefined;
  }

  /** Get the resource mapping for a given TF type or InfraSync kind */
  resolveMapping(
    key: { tfType: string } | { infraKind: string },
  ): ResourceMapping | undefined {
    for (const plugin of this.plugins.values()) {
      if ("tfType" in key) {
        const mapping = plugin.resourceMappings.find(
          (m) => m.tfType === key.tfType,
        );
        if (mapping !== undefined) return mapping;
      } else {
        const mapping = plugin.resourceMappings.find(
          (m) => m.infraKind === key.infraKind,
        );
        if (mapping !== undefined) return mapping;
      }
    }
    return undefined;
  }

  /** Get all applicable safety rules for a given adapter */
  safetyRulesFor(adapterName: string): readonly SafetyRule[] {
    const plugin = this.plugins.get(adapterName);
    if (plugin !== undefined) return plugin.safetyRules;
    return [];
  }

  /** Get attribute mappers for a given adapter */
  attributeMappersFor(adapterName: string): readonly AttributeMapper[] {
    const plugin = this.plugins.get(adapterName);
    if (plugin !== undefined) return plugin.attributeMappers;
    return [];
  }

  /** Map an attribute path between TF and InfraSync representations */
  mapAttributePath(
    adapterName: string,
    path: string,
    direction: MigrationDirection,
  ): string {
    const mappers = this.attributeMappersFor(adapterName);
    for (const mapper of mappers) {
      if (direction === "tf-to-infrasync" && path === mapper.tfPath) {
        return mapper.infraPath;
      }
      if (direction === "infrasync-to-tf" && path === mapper.infraPath) {
        return mapper.tfPath;
      }
    }
    return path;
  }
}
