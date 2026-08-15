/**
 * ESM host build for dsh-blackhole.
 *
 * The host half is plain ESM for Node, externalizing the @deepseek-ai/dsh-*
 * profile packages (the profile's node_modules provides them at load time).
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})
