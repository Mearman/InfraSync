import { monorepoRelease } from "./src/release/index.js";

// monorepoRelease implements the full plugin lifecycle internally.
// semantic-release expects PluginSpec[], but our plugin is a
// validated object — cast through unknown to satisfy the type.
export default {
  branches: [{ name: "main", channel: "latest" }],
  plugins: [monorepoRelease],
};
