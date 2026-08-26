import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    next: 'src/next.ts',
    'adapters/memory': 'src/adapters/memory.ts',
    'adapters/postgres': 'src/adapters/postgres.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // pg is a peer dependency; never bundle the host app's driver.
  external: ['pg'],
})
