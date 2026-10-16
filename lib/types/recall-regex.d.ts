/** Bounded, conservative regular-expression support for recall queries. */
/** Extract natural-language terms for the BM25-like fallback. */
export declare function recallQueryTerms(query: string): string[];
/**
 * Parse wrapped or punctuation-bearing raw regexes. Unsafe/invalid patterns
 * return undefined and are handled as ordinary token queries by callers.
 */
export declare function recallRegexFromQuery(query: string): RegExp | undefined;
