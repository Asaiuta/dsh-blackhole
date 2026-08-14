import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
await build({
  entryPoints: [fileURLToPath(new URL('algal/remote-compaction.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('algal-bundle.mjs', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  alias: {
    '@earendil-works/pi-coding-agent': fileURLToPath(new URL('./stubs/pi-coding-agent.mjs', import.meta.url)),
    '@earendil-works/pi-ai': fileURLToPath(new URL('./stubs/pi-ai.mjs', import.meta.url)),
    '@earendil-works/pi-ai/compat': fileURLToPath(new URL('./stubs/pi-ai-compat.mjs', import.meta.url)),
  },
  logLevel: 'info',
})
console.log('algal bundle built')
