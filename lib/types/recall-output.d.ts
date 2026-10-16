/** Shared output bound for recall responses. */
export declare const MAX_RECALL_OUTPUT_BYTES: number;
export declare const recallUtf8ByteLength: (text: string) => number;
export declare const clipRecallUtf8: (text: string, maxBytes: number) => string;
/** Cap serialized recall output without splitting a UTF-8 code point. */
export declare function capRecallOutput(text: string, note?: string): string;
