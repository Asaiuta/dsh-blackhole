/** Bounded, conservative regular-expression support for recall queries. */

const MAX_PATTERN_CHARS = 256
const MAX_QUANTIFIERS = 2
const MAX_QUANTIFIER_WIDTH = 32

interface GroupFrame {
  hasQuantifier: boolean
  hasAlternation: boolean
}

const isQuantifierStart = (character: string): boolean => character === '*' || character === '+' || character === '?' || character === '{'

/**
 * Conservative ReDoS guard. JavaScript's RegExp engine is synchronous, so a
 * single hostile pattern can block the whole DSH host. We accept ordinary
 * literals, character classes, anchors, and simple quantifiers, while
 * falling back to token search for ambiguous quantified groups/alternations.
 */
const hasUnsafeStructure = (pattern: string): boolean => {
  // Backreferences and lookarounds can create non-local backtracking paths.
  if (/\\(?:[1-9][0-9]*|k<[^>]+>)/u.test(pattern)) return true
  if (pattern.includes('(?')) return true

  const groups: GroupFrame[] = []
  let inClass = false
  let previousWasAtom = false
  let previousWasQuantifier = false
  let lastAtomGroup: GroupFrame | undefined
  let hasAlternation = false
  let quantifierCount = 0
  let unboundedQuantifierCount = 0

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      // Escaped code points are one atom. Backreferences were rejected above.
      index += 1
      previousWasAtom = true
      previousWasQuantifier = false
      lastAtomGroup = undefined
      continue
    }
    if (inClass) {
      if (character === ']') inClass = false
      continue
    }
    if (character === '[') {
      inClass = true
      previousWasAtom = true
      previousWasQuantifier = false
      lastAtomGroup = undefined
      continue
    }
    if (character === '(') {
      // Non-capturing, lookaround, and inline-flag groups are deliberately
      // outside the small safe subset. Capturing groups remain supported.
      if (pattern[index + 1] === '?') return true
      groups.push({ hasQuantifier: false, hasAlternation: false })
      previousWasAtom = false
      previousWasQuantifier = false
      lastAtomGroup = undefined
      continue
    }
    if (character === ')') {
      const frame = groups.pop()
      if (frame === undefined) return true
      const parent = groups.at(-1)
      if (parent !== undefined) {
        parent.hasQuantifier ||= frame.hasQuantifier
        parent.hasAlternation ||= frame.hasAlternation
      }
      previousWasAtom = true
      previousWasQuantifier = false
      lastAtomGroup = frame
      continue
    }
    if (character === '|') {
      hasAlternation = true
      const frame = groups.at(-1)
      if (frame !== undefined) frame.hasAlternation = true
      previousWasAtom = false
      previousWasQuantifier = false
      lastAtomGroup = undefined
      continue
    }
    if (character === '^' || character === '$') {
      previousWasAtom = false
      previousWasQuantifier = false
      lastAtomGroup = undefined
      continue
    }
    if (isQuantifierStart(character)) {
      // A `?` immediately after another quantifier is only its lazy suffix.
      if (character === '?' && previousWasQuantifier) continue
      let consumed = 1
      let unbounded = character === '*' || character === '+'
      if (character === '{') {
        const range = pattern.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/u)
        if (range === null) {
          // A literal `{` is an atom; RegExp construction below decides if it
          // is valid for the selected flags.
          previousWasAtom = true
          previousWasQuantifier = false
          lastAtomGroup = undefined
          continue
        }
        const minimum = Number(range[1])
        const upper = range[2]
        const hasComma = range[0].includes(',')
        const maximum = !hasComma ? minimum : upper === '' ? undefined : Number(upper)
        // Large/open ranges are needlessly expensive for an inspection query.
        if (
          minimum > MAX_QUANTIFIER_WIDTH ||
          maximum === undefined ||
          maximum > MAX_QUANTIFIER_WIDTH ||
          maximum - minimum > MAX_QUANTIFIER_WIDTH
        ) return true
        consumed = range[0].length
        unbounded = false
      }
      if (!previousWasAtom || previousWasQuantifier) return true
      if (lastAtomGroup !== undefined && (lastAtomGroup.hasQuantifier || lastAtomGroup.hasAlternation)) return true
      quantifierCount += 1
      if (unbounded) unboundedQuantifierCount += 1
      const frame = groups.at(-1)
      if (frame !== undefined) frame.hasQuantifier = true
      previousWasQuantifier = true
      previousWasAtom = true
      index += consumed - 1
      continue
    }

    // Ordinary literal/dot atoms.
    previousWasAtom = true
    previousWasQuantifier = false
    lastAtomGroup = undefined
  }

  if (inClass || groups.length > 0) return true
  // Alternation combined with an unbounded repetition is a common source of
  // catastrophic backtracking even when the repetition is not on a group.
  if (hasAlternation && unboundedQuantifierCount > 0) return true
  // Multiple unbounded repetitions (`a*a*a*`) are cheap to reject and have no
  // useful advantage for recall over the token fallback.
  if (unboundedQuantifierCount > 1 && quantifierCount > 1) return true
  // Long chains of optional/bounded atoms can also produce exponential
  // backtracking without a quantified group.
  if (quantifierCount > MAX_QUANTIFIERS) return true
  return false
}

const termsFromQuery = (query: string): string[] =>
  query.replace(/^\/(.*)\/[a-z]*$/i, '$1').match(/[\p{L}\p{N}_-]+/gu) ?? []

/** Extract natural-language terms for the BM25-like fallback. */
export function recallQueryTerms(query: string): string[] {
  return termsFromQuery(query)
}

/**
 * Parse wrapped or punctuation-bearing raw regexes. Unsafe/invalid patterns
 * return undefined and are handled as ordinary token queries by callers.
 */
export function recallRegexFromQuery(query: string): RegExp | undefined {
  const wrapped = query.match(/^\/(.+)\/([a-z]*)$/i)
  const pattern = wrapped?.[1] ?? query
  if (wrapped === null && !/[|*+?{}()[\]\\^$.]/u.test(query)) return undefined
  if (pattern.length > MAX_PATTERN_CHARS || hasUnsafeStructure(pattern)) return undefined
  const rawFlags = wrapped?.[2].toLocaleLowerCase() ?? ''
  const flags = rawFlags.length === 0 ? 'i' : rawFlags.includes('i') ? rawFlags : `${rawFlags}i`
  try {
    return new RegExp(pattern, flags)
  } catch {
    return undefined
  }
}
