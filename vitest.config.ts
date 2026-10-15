import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  resolve: { alias: [
    { find: "@tesseract/plugins/logger", replacement: path("./packages/plugins/src/logger.ts") },
    { find: "@tesseract/plugins", replacement: path("./packages/plugins/src/index.ts") },
    { find: "@tesseract/core/testing/storage-conformance", replacement: path("./packages/core/src/testing/storage-conformance.ts") },
    { find: "@tesseract/core/testing", replacement: path("./packages/core/src/testing/index.ts") },
    { find: "@tesseract/core/tool", replacement: path("./packages/core/src/tools/tool.ts") },
    { find: "@tesseract/core", replacement: path("./packages/core/src/index.ts") },
    { find: "@tesseract/sqlite", replacement: path("./packages/sqlite/src/index.ts") },
    { find: "@tesseract/openai", replacement: path("./packages/openai/src/index.ts") },
  ] },
  test: { include: ["packages/*/test/**/*.test.ts", "tests/integration/**/*.test.ts"], testTimeout: 15000 }
});

