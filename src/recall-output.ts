/** Shared output bound for recall responses. */

const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : undefined

export const MAX_RECALL_OUTPUT_BYTES = 50 * 1024

export const recallUtf8ByteLength = (text: string): number => utf8Encoder?.encode(text).byteLength ?? text.length

export const clipRecallUtf8 = (text: string, maxBytes: number): string => {
  if (!Number.isFinite(maxBytes)) return text
  // Every UTF-16 code unit occupies at least one UTF-8 byte, so a longer
  // string cannot fit and need not be encoded in full before clipping.
  if (text.length <= maxBytes && recallUtf8ByteLength(text) <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = recallUtf8ByteLength(character)
    if (bytes + size > maxBytes) break
    bytes += size
    end += character.length
  }
  return text.slice(0, end)
}

/** Cap serialized recall output without splitting a UTF-8 code point. */
export function capRecallOutput(
  text: string,
  note = 'recall response truncated at 50KB; narrow the query or drill into a specific file.',
): string {
  if (recallUtf8ByteLength(text) <= MAX_RECALL_OUTPUT_BYTES) return text
  const suffix = `\n\n... (${note})`
  const clipped = clipRecallUtf8(text, Math.max(0, MAX_RECALL_OUTPUT_BYTES - recallUtf8ByteLength(suffix)))
  return `${clipped}${suffix}`
}
