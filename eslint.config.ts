import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import type { Rule } from "eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import eslintPluginZod from "eslint-plugin-zod";
import tseslint from "typescript-eslint";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));
// ─── Custom rules ────────────────────────────────────────────────────────────

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

/**
 * Bans redundant variable re-assignments where a new identifier is just an alias
 * for an existing one (e.g. `const foo = bar;`). Forces using the original directly.
 *
 * Variables prefixed with `_` are excluded (discard bindings).
 */
const noPointlessReassignments: Rule.RuleModule = {
  meta: {
    type: "problem",
    messages: {
      pointlessReassignment:
        "Pointless reassignment. {{ name }} is just an alias for {{ value }}. Use the original directly instead.",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        // Only flag const bindings — let bindings may be reassigned later
        if (
          node.parent.type !== "VariableDeclaration" ||
          node.parent.kind !== "const"
        ) {
          return;
        }
        if (node.id.type !== "Identifier" || node.init?.type !== "Identifier") {
          return;
        }
        if (node.id.name.startsWith("_")) {
          return;
        }
        context.report({
          node,
          messageId: "pointlessReassignment",
          data: {
            name: node.id.name,
            value: node.init.name,
          },
        });
      },
    };
  },
};

/**
 * Bans all eslint-disable comments (inline, block, and next-line variants).
 * Forces developers to fix the underlying issue rather than silencing the linter.
 */
const banEslintDisableRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Bans eslint-disable comments — fix the underlying issue",
    },
  },
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        for (const comment of comments) {
          const text = comment.value.trimStart();
          if (
            text.startsWith("eslint-disable") ||
            text.startsWith("eslint-enable")
          ) {
            context.report({
              loc: comment.loc ?? { line: 1, column: 0 },
              message:
                "eslint-disable comments are forbidden — fix the underlying issue instead",
            });
          }
        }
      },
    };
  },
};

// ─── Shared custom plugin ────────────────────────────────────────────────────

const customPlugin = {
  rules: {
    testFileNaming: testFileNamingRule,
    banEslintDisable: banEslintDisableRule,
    noPointlessReassignments,
  },
};

// ─── Config ──────────────────────────────────────────────────────────────────

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/__tests__/fixtures/**/golden/**",
      "**/tsdown.config.ts",
    ],
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
      custom: customPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "custom/banEslintDisable": "error",
      "custom/noPointlessReassignments": "error",
      "no-restricted-syntax": [
        "error",
        {
          message:
            "Dynamic imports are forbidden — use static imports instead.",
          selector: "ImportExpression",
        },
        {
          message:
            "Inline type imports via import() are forbidden — use a static import instead.",
          selector: "TSImportType",
        },
      ],
      "prettier/prettier": "error",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    plugins: { custom: customPlugin },
    rules: {
      "custom/testFileNaming": "error",
      // node:test describe/it return Promises that the test runner handles
      "@typescript-eslint/no-floating-promises": "off",
      // Mock adapter methods are async to satisfy the ResourcePort interface
      // but don't await anything internally
      "@typescript-eslint/require-await": "off",
      // Underscore-prefixed params in mocks/stubs that satisfy interface signatures
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      // Test mocks require type coercion to satisfy SDK interfaces
      "@typescript-eslint/consistent-type-assertions": "off",
      // node:test mock.calls[x] returns unknown — narrowing checks are valid
      // even when ESLint thinks the types don't overlap
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  eslintPluginZod.configs.recommended,
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
