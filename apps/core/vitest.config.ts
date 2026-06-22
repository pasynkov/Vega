import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // E2E scenarios boot the full Nest app and share a single
    // <repo-root>/output/db/shopping.sqlite file (the domain DataSource
    // resolves its path from the .git anchor, outside the per-test tmp
    // root). Running e2e files in parallel workers races on that file.
    // Disable file-level parallelism so the whole suite executes
    // sequentially in a single worker.
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        keepClassNames: true,
      },
      module: { type: "es6" },
    }),
  ],
});
