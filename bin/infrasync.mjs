#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
});

jiti.import("../src/cli/index.js");
