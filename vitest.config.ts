import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  resolve: { alias: [
    { find: "@tesseract/core/testing/storage-conformance", replacement: path("./packages/core/src/testing/storage-conformance.ts") },
    { find: "@tesseract/core/testing", replacement: path("./packages/core/src/testing/index.ts") },
    { find: "@tesseract/core", replacement: path("./packages/core/src/index.ts") },
    { find: "@tesseract/storage-sqlite", replacement: path("./packages/storage-sqlite/src/index.ts") },
    { find: "@tesseract/openai", replacement: path("./packages/openai/src/index.ts") },
  ] },
  test: { include: ["packages/**/*.test.ts", "tests/integration/**/*.test.ts"], testTimeout: 15000 }
});

