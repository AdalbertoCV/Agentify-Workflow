import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    // Each file drives git, Postgres tools and PowerShell; too many at once starve the machine.
    maxWorkers: 3,
    hookTimeout: 60000
  }
})
