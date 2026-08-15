/**
 * Bundle entry for the REAL pi-blackhole brief compiler (pinned
 * 49ab560156fd53b6da1b568d5ade10287b89026c), used by the content-level
 * differential suite. `@earendil-works/pi-ai` imports are type-only, so no
 * runtime stub is needed.
 */
export { normalize, type NormalizedBlock } from './core/normalize.ts'
export { compileBrief, buildBriefSections, stringifyBrief } from './core/brief.ts'
export type { BriefLine, TranscriptEntry } from './core/brief.ts'