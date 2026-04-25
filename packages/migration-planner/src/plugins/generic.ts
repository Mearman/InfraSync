/**
 * Generic migration plugin — default safety rules for any provider.
 *
 * Applied when no provider-specific plugin matches. Provides conservative
 * generic heuristics for attribute safety classification.
 */
import type { MigrationPlugin } from "../schemas.js";

export const genericPlugin: MigrationPlugin = {
  name: "generic",
  adapterName: "_generic",
  resourceMappings: [],
  safetyRules: [
    {
      path: "\\.id$",
      pathIsRegex: true,
      actions: ["update"],
      direction: "both",
      severity: "destructive",
      description:
        "Identifier changes are destructive — resource must be recreated",
    },
    {
      path: "\\.name$",
      pathIsRegex: true,
      actions: ["update"],
      direction: "both",
      severity: "destructive",
      description: "Name changes are destructive — resource identity changes",
    },
    {
      path: "^spec\\.",
      pathIsRegex: true,
      actions: ["create"],
      direction: "both",
      severity: "safe",
      description: "Creating attributes is safe",
    },
  ],
  attributeMappers: [],
};
