/**
 * ESM host build for dsh-blackhole.
 *
 * The host half is plain ESM for Node, externalizing the @deepseek-ai/dsh-*
 * profile packages (the profile's node_modules provides them at load time).
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/index.ts', 'src/commands-plugin.ts', 'src/tools-plugin.ts'],
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})

// The package exports `types` entries under lib/types/*.d.ts; esbuild cannot
// emit declarations, so run tsc's declaration-only pass after bundling.
const tsc = spawn(process.execPath, [
  join('node_modules', 'typescript', 'bin', 'tsc'),
  '-p', 'tsconfig.json',
  '--emitDeclarationOnly',
], { stdio: 'inherit' })
tsc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`declaration emit failed (exit ${code})`)
    process.exitCode = code ?? 1
  }
})
