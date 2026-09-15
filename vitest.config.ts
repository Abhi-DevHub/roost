import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@roost/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@roost/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
    },
  },
});
