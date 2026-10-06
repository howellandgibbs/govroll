import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    // Container startup + migrations take 10-20s. Per-test DB work is cheap
    // but sequential fetch-mock replays can add up — give each test 30s.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One fork, files run serially. Running in parallel forks would
    // require per-worker databases which isn't worth the complexity for
    // an 11-route surface. `fileParallelism: false` forces maxWorkers=1
    // and makes files run one-by-one — `pool: 'forks'` is the ambient
    // default in v4 but kept explicit here.
    pool: "forks",
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Query modules guard themselves with `import "server-only"`, a
      // package Next.js resolves internally. Point it at Next's own
      // server-side no-op so those modules load under vitest.
      "server-only": path.resolve(
        __dirname,
        "./node_modules/next/dist/compiled/server-only/empty.js",
      ),
    },
  },
});
