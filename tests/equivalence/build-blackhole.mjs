/**
 * Build the pi-blackhole brief-compiler bundle from the pinned upstream
 * source copied into tests/equivalence/blackhole-brief/.
 *
 * Run: node tests/equivalence/build-blackhole.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

await build({
  entryPoints: [fileURLToPath(new URL('blackhole-brief/entry.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('blackhole-brief-bundle.mjs', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  logLevel: 'info',
})
console.log('blackhole brief bundle built')