#!/usr/bin/env node
// The CLI always runs from source via jiti — it's not part of the library bundle.
// The library bundle (dist/) is for programmatic SDK usage only.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
});

jiti.import("../src/index.js");
