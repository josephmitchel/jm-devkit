import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `workspaces/` holds full checkouts of the repos under review — 41 test files today.
    // Without this they are collected as if they were ours, and they cannot pass here:
    // they resolve `@/…` against the reviewed repo and expect its database.
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
    // `*.postgres.test.ts` needs a real Postgres and runs only through vitest.postgres.config.ts.
    exclude: ['node_modules/**', 'workspaces/**', 'drizzle/**', '**/*.postgres.test.ts'],
  },
});
