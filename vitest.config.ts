import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Both test files share one Postgres and each resets it between tests.
    // Running files in parallel would have them destroy each other's fixtures.
    fileParallelism: false,
    setupFiles: ['./tests/setup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
