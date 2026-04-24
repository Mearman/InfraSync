import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import type { Rule } from "eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import tseslint from "typescript-eslint";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Test file naming rule.
 * Requires test files to match: foo.{type}.test.ts
 * Example: bar.unit.test.ts
 */
const testFileNamingRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Test files must be named foo.{type}.test.ts (for example, foo.unit.test.ts)",
    },
  },
  create(context) {
    const filename = context.filename;

    if (!filename.endsWith(".test.ts") && !filename.endsWith(".test.tsx")) {
      return {};
    }

    const segments = filename.split("/");
    const basename = segments.at(-1);
    if (basename === undefined) {
      return {};
    }

    const testTypePattern = /^.+\.[a-z]+\.test\.tsx?$/i;

    if (!testTypePattern.test(basename)) {
      return {
        Program(node) {
          context.report({
            node,
            message: `Test file must follow the pattern foo.{type}.test.ts (for example, foo.unit.test.ts). Received: ${basename}`,
          });
        },
      };
    }

    return {};
  },
};

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          message:
            "Dynamic imports are forbidden — use static imports instead.",
          selector: 'CallExpression[callee.type="Import"]',
        },
      ],
      "prettier/prettier": "error",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    plugins: {
      custom: {
        rules: { testFileNaming: testFileNamingRule },
      },
    },
    rules: {
      "custom/testFileNaming": "error",
    },
  },
  eslintConfigPrettier,
  {
    files: ["**/*.json"],
    language: "json/json",
    plugins: { json },
    rules: {
      "json/no-duplicate-keys": "error",
    },
  },
  {
    files: ["**/*.md"],
    language: "markdown/gfm",
    plugins: { markdown },
    rules: {
      "markdown/no-html": "off",
    },
  },
);
