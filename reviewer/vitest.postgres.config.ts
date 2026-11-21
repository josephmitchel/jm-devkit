import { defineConfig } from 'vitest/config';

// The suites that need a real Postgres, kept out of `npm test`, which needs no database. Run with
// `REVIEWER_TEST_DATABASES_URL=<server> npm run test:postgres`.
export default defineConfig({
  test: {
    include: ['src/**/*.postgres.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
