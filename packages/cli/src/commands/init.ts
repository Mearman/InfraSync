/**
 * `infrasync init` — scaffold a new InfraSync project.
 *
 * Generates:
 * - package.json with @infrasync/core + selected provider
 * - tsconfig.json extending the project base
 * - infra.config.ts with a working skeleton
 * - .tool-versions for mise/asdf Node version management
 *
 * Usage:
 *   infrasync init                          # interactive prompts
 *   infrasync init --name my-infra          # specify project name
 *   infrasync init --provider cloudflare    # skip provider prompt
 *   infrasync init --outdir ./my-project    # output directory (default: cwd)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ─── Provider registry ──────────────────────────────────────────────────────

interface ProviderTemplate {
  readonly packageName: string;
  readonly importPath: string;
  readonly configFields: string;
  readonly exampleResource: string;
}

const PROVIDERS: Readonly<Record<string, ProviderTemplate>> = {
  cloudflare: {
    packageName: "@infrasync/cloudflare",
    importPath: "@infrasync/cloudflare",
    configFields: `{
      apiToken: { $secret: { env: "CF_API_TOKEN" } },
      accountId: { $secret: { env: "CF_ACCOUNT_ID" } },
    }`,
    exampleResource: `    cf.DnsRecord("example", {
      domain: "example.com",
      type: "A",
      value: "1.2.3.4",
      ttl: 300,
      proxied: false,
    })`,
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// ─── Template generation ────────────────────────────────────────────────────

function generatePackageJson(
  projectName: string,
  provider: ProviderTemplate,
): string {
  return (
    JSON.stringify(
      {
        name: projectName,
        version: "0.1.0",
        type: "module",
        scripts: {
          plan: "infrasync plan --config infra.config.ts",
          apply: "infrasync apply --config infra.config.ts",
          drift: "infrasync drift --config infra.config.ts",
        },
        dependencies: {
          "@infrasync/core": "workspace:*",
          [provider.packageName]: "workspace:*",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function generateTsConfig(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: "dist",
          rootDir: ".",
        },
        include: ["infra.config.ts"],
      },
      null,
      2,
    ) + "\n"
  );
}

function generateConfig(
  providerKey: string,
  template: ProviderTemplate,
): string {
  const providerName = providerKey;
  return `import { defineInfra } from "@infrasync/core/compiler";
import { ${providerName} } from "${template.importPath}";

export default defineInfra("my-infra", (infra) => {
  const ${providerName} = infra.use(
    ${providerName}("prod", ${template.configFields}),
  );

  infra.resource(${template.exampleResource});
});
`;
}

function generateToolVersions(): string {
  return "node 25\n";
}

// ─── Interactive prompts ─────────────────────────────────────────────────────

async function prompt(
  question: string,
  default_value: string,
): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${question} (${default_value}) `);
  rl.close();
  return answer.trim() || default_value;
}

async function promptChoice(
  question: string,
  choices: readonly string[],
): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const menu = choices.map((c, i) => `  ${String(i + 1)}. ${c}`).join("\n");
  const answer = await rl.question(`${question}\n${menu}\n> `);
  rl.close();
  const index = Number.parseInt(answer.trim(), 10) - 1;
  if (index >= 0 && index < choices.length) {
    const choice = choices[index];
    if (choice !== undefined) return choice;
  }
  throw new Error(
    `Invalid choice "${answer.trim()}". Expected 1-${String(choices.length)}.`,
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runInitCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      provider: { type: "string" },
      outdir: { type: "string" },
    },
    strict: false,
  });

  // Resolve project name
  const rawName = values.name;
  const projectName =
    (typeof rawName === "string" ? rawName : undefined) ??
    (await prompt("Project name", "my-infra"));

  // Resolve provider
  let providerKey =
    typeof values.provider === "string" ? values.provider : undefined;
  if (providerKey !== undefined) {
    if (!(providerKey in PROVIDERS)) {
      throw new Error(
        `Unknown provider "${providerKey}". Available: ${PROVIDER_NAMES.join(", ")}`,
      );
    }
  } else {
    providerKey = await promptChoice("Select a provider", PROVIDER_NAMES);
  }

  const template = PROVIDERS[providerKey];
  if (template === undefined) {
    throw new Error(`Provider template missing for "${providerKey}"`);
  }

  // Resolve output directory
  const rawOutdir = values.outdir;
  const outdir = typeof rawOutdir === "string" ? rawOutdir : process.cwd();
  const outPath = resolve(outdir);

  // Generate files
  await mkdir(outPath, { recursive: true });

  const files: readonly { readonly path: string; readonly content: string }[] =
    [
      {
        path: "package.json",
        content: generatePackageJson(projectName, template),
      },
      { path: "tsconfig.json", content: generateTsConfig() },
      {
        path: "infra.config.ts",
        content: generateConfig(providerKey, template),
      },
      { path: ".tool-versions", content: generateToolVersions() },
    ];

  for (const file of files) {
    await writeFile(join(outPath, file.path), file.content, "utf-8");
    console.log(`  Created ${file.path}`);
  }

  console.log(
    `\nScaffolded "${projectName}" with ${providerKey} provider in ${outPath}`,
  );
  console.log("\nNext steps:");
  console.log("  1. pnpm install");
  console.log("  2. Set environment variables (see infra.config.ts)");
  console.log("  3. pnpm plan   # preview changes");
  console.log("  4. pnpm apply  # apply changes");
}
