import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
  },
  resolve: {
    // Allow TypeScript path resolution with .js extensions (Node ESM)
    conditions: ['import', 'node'],
  },
})
