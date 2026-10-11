// src/session-access.ts
import { deriveEventMessage } from "@deepseek-ai/dsh-session";

// src/recall-output.ts
var utf8Encoder = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
var MAX_RECALL_OUTPUT_BYTES = 50 * 1024;
var recallUtf8ByteLength = (text) => utf8Encoder?.encode(text).byteLength ?? text.length;
var clipRecallUtf8 = (text, maxBytes) => {
  if (!Number.isFinite(maxBytes)) return text;
  if (text.length <= maxBytes && recallUtf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = recallUtf8ByteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
};
function capRecallOutput(text, note = "recall response truncated at 50KB; narrow the query or drill into a specific file.") {
  if (recallUtf8ByteLength(text) <= MAX_RECALL_OUTPUT_BYTES) return text;
  const suffix = `

... (${note})`;
  const clipped = clipRecallUtf8(text, Math.max(0, MAX_RECALL_OUTPUT_BYTES - recallUtf8ByteLength(suffix)));
  return `${clipped}${suffix}`;
}

// src/recall-regex.ts
var MAX_PATTERN_CHARS = 256;
var MAX_QUANTIFIERS = 2;
var MAX_QUANTIFIER_WIDTH = 32;
var isQuantifierStart = (character) => character === "*" || character === "+" || character === "?" || character === "{";
var hasUnsafeStructure = (pattern) => {
  if (/\\(?:[1-9][0-9]*|k<[^>]+>)/u.test(pattern)) return true;
  if (pattern.includes("(?")) return true;
  const groups = [];
  let inClass = false;
  let previousWasAtom = false;
  let previousWasQuantifier = false;
  let lastAtomGroup;
  let hasAlternation = false;
  let quantifierCount = 0;
  let unboundedQuantifierCount = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      previousWasAtom = true;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
      continue;
    }
    if (character === "[") {
      inClass = true;
      previousWasAtom = true;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (character === "(") {
      if (pattern[index + 1] === "?") return true;
      groups.push({ hasQuantifier: false, hasAlternation: false });
      previousWasAtom = false;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (character === ")") {
      const frame = groups.pop();
      if (frame === void 0) return true;
      const parent = groups.at(-1);
      if (parent !== void 0) {
        parent.hasQuantifier ||= frame.hasQuantifier;
        parent.hasAlternation ||= frame.hasAlternation;
      }
      previousWasAtom = true;
      previousWasQuantifier = false;
      lastAtomGroup = frame;
      continue;
    }
    if (character === "|") {
      hasAlternation = true;
      const frame = groups.at(-1);
      if (frame !== void 0) frame.hasAlternation = true;
      previousWasAtom = false;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (character === "^" || character === "$") {
      previousWasAtom = false;
      previousWasQuantifier = false;
      lastAtomGroup = void 0;
      continue;
    }
    if (isQuantifierStart(character)) {
      if (character === "?" && previousWasQuantifier) continue;
      let consumed = 1;
      let unbounded = character === "*" || character === "+";
      if (character === "{") {
        const range = pattern.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/u);
        if (range === null) {
          previousWasAtom = true;
          previousWasQuantifier = false;
          lastAtomGroup = void 0;
          continue;
        }
        const minimum = Number(range[1]);
        const upper = range[2];
        const hasComma = range[0].includes(",");
        const maximum = !hasComma ? minimum : upper === "" ? void 0 : Number(upper);
        if (minimum > MAX_QUANTIFIER_WIDTH || maximum === void 0 || maximum > MAX_QUANTIFIER_WIDTH || maximum - minimum > MAX_QUANTIFIER_WIDTH) return true;
        consumed = range[0].length;
        unbounded = false;
      }
      if (!previousWasAtom || previousWasQuantifier) return true;
      if (lastAtomGroup !== void 0 && (lastAtomGroup.hasQuantifier || lastAtomGroup.hasAlternation)) return true;
      quantifierCount += 1;
      if (unbounded) unboundedQuantifierCount += 1;
      const frame = groups.at(-1);
      if (frame !== void 0) frame.hasQuantifier = true;
      previousWasQuantifier = true;
      previousWasAtom = true;
      index += consumed - 1;
      continue;
    }
    previousWasAtom = true;
    previousWasQuantifier = false;
    lastAtomGroup = void 0;
  }
  if (inClass || groups.length > 0) return true;
  if (hasAlternation && unboundedQuantifierCount > 0) return true;
  if (unboundedQuantifierCount > 1 && quantifierCount > 1) return true;
  if (quantifierCount > MAX_QUANTIFIERS) return true;
  return false;
};
var termsFromQuery = (query) => query.replace(/^\/(.*)\/[a-z]*$/i, "$1").match(/[\p{L}\p{N}_-]+/gu) ?? [];
function recallQueryTerms(query) {
  return termsFromQuery(query);
}
function recallRegexFromQuery(query) {
  const wrapped = query.match(/^\/(.+)\/([a-z]*)$/i);
  const pattern = wrapped?.[1] ?? query;
  if (wrapped === null && !/[|*+?{}()[\]\\^$.]/u.test(query)) return void 0;
  if (pattern.length > MAX_PATTERN_CHARS || hasUnsafeStructure(pattern)) return void 0;
  const rawFlags = wrapped?.[2].toLocaleLowerCase() ?? "";
  const flags = rawFlags.length === 0 ? "i" : rawFlags.includes("i") ? rawFlags : `${rawFlags}i`;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return void 0;
  }
}

// src/recall-files.ts
var PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target"];
var MUTATION_TOOL_NAMES = /* @__PURE__ */ new Set([
  "write",
  "edit",
  "multiedit",
  "write_file",
  "edit_file",
  "apply_patch",
  "patch",
  "writefile",
  "editfile",
  "applypatch",
  "create_file",
  "createfile",
  "replace_file",
  "replacefile",
  "str_replace",
  "strreplace",
  "insert_file",
  "overwrite_file",
  "update_file",
  "updatefile",
  "diff",
  "applydiff"
]);
var isRecallFileMutationTool = (name2) => {
  if (typeof name2 !== "string") return false;
  const normalized = name2.trim().toLocaleLowerCase();
  if (MUTATION_TOOL_NAMES.has(normalized)) return true;
  return /(?:^|[/.:_-])(?:write|edit|patch|replace|create|update)(?:$|[/.:_-])/u.test(normalized) || /(?:write|edit|patch|replace|create|update)(?:_?file)?$/u.test(normalized);
};
var asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
var parseArguments = (value) => {
  const record = asRecord(value);
  if (record !== void 0) return record;
  if (typeof value !== "string") return void 0;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return void 0;
  }
};
var normalizePath = (value) => value.trim().replaceAll("\\", "/");
var pathFromArguments = (args) => {
  for (const key of PATH_KEYS) {
    if (typeof args[key] === "string" && args[key].trim().length > 0) {
      return normalizePath(args[key]);
    }
  }
  return void 0;
};
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isContentBearing = (args) => {
  if (typeof args.content === "string") return true;
  if (Array.isArray(args.edits) && args.edits.length > 0 && args.edits.every(isObject)) return true;
  if (typeof args.oldText === "string" && args.edits === void 0) return true;
  if (typeof args.newText === "string" && args.edits === void 0) return true;
  return false;
};
var formatContent = (args) => {
  const sections = [];
  if (typeof args.content === "string") sections.push(args.content);
  if (Array.isArray(args.edits)) {
    if (args.edits.length > 0) {
      sections.push(args.edits.map((edit, index) => {
        const record = isObject(edit) ? edit : {};
        const oldText = typeof record.oldText === "string" ? record.oldText : "";
        const newText = typeof record.newText === "string" ? record.newText : "";
        return `--- edit ${index + 1} ---
${oldText}
--- becomes ---
${newText}`;
      }).join("\n\n"));
    }
  } else {
    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText = typeof args.newText === "string" ? args.newText : "";
    if (oldText || newText) sections.push(`--- old ---
${oldText}
--- new ---
${newText}`);
  }
  return sections.join("\n\n") || "(empty file content)";
};
function extractRecallFileOperations(message) {
  const operations = [];
  for (const block of message.content ?? []) {
    if (block.type !== "tool-call") continue;
    if (!isRecallFileMutationTool(block.name)) continue;
    const args = parseArguments(block.arguments);
    if (args === void 0 || !isContentBearing(args)) continue;
    const path = pathFromArguments(args);
    if (path === void 0) continue;
    operations.push({
      path,
      tool: typeof block.name === "string" && block.name.length > 0 ? block.name : "unknown",
      content: formatContent(args)
    });
  }
  return operations;
}
var utf8Encoder2 = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
var byteLength = (text) => utf8Encoder2?.encode(text).byteLength ?? text.length;
var clipUtf8 = (text, maxBytes) => {
  if (!Number.isFinite(maxBytes)) return text;
  if (text.length <= maxBytes && byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
};
var clipForSearch = (text, maxBytes = 10240) => {
  if (byteLength(text) <= maxBytes) return text;
  return clipUtf8(text, maxBytes);
};
var PREVIEW_LINES = 30;
var MAX_FILE_PAGE_LINES = 1e3;
var FILE_RESPONSE_RESERVE_BYTES = 2 * 1024;
var linesByteLength = (lines) => lines.reduce(
  (total, line, index) => total + byteLength(line) + (index === 0 ? 0 : 1),
  0
);
var capLines = (lines, maxBytes) => {
  const totalBytes = linesByteLength(lines);
  const parts = [];
  let usedBytes = 0;
  let completeLines = 0;
  let truncatedInsideLine = false;
  for (const line of lines) {
    const separatorBytes = parts.length === 0 ? 0 : 1;
    const requiredBytes = separatorBytes + byteLength(line);
    if (usedBytes + requiredBytes <= maxBytes) {
      parts.push(line);
      usedBytes += requiredBytes;
      completeLines += 1;
      continue;
    }
    if (parts.length === 0) {
      const clipped = clipUtf8(line, Math.max(0, maxBytes));
      parts.push(clipped);
      usedBytes = byteLength(clipped);
      truncatedInsideLine = byteLength(clipped) < byteLength(line);
    }
    break;
  }
  const text = parts.join("\n");
  return {
    text,
    omittedBytes: Math.max(0, totalBytes - byteLength(text)),
    completeLines,
    truncatedInsideLine
  };
};
function recallFileSearchText(operations) {
  return operations.map((operation) => clipForSearch(operation.content)).join("\n");
}
var snippetFor = (text, query, regex) => {
  if (regex !== void 0) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    regex.lastIndex = 0;
    if (match !== null) {
      const start2 = Math.max(0, match.index - 60);
      const end2 = Math.min(text.length, match.index + Math.max(1, match[0].length) + 60);
      return `${start2 > 0 ? "..." : ""}${text.slice(start2, end2)}${end2 < text.length ? "..." : ""}`;
    }
  }
  const terms = recallQueryTerms(query);
  const lowered = text.toLocaleLowerCase();
  const term = terms.find((candidate) => lowered.includes(candidate.toLocaleLowerCase()));
  if (term === void 0) return void 0;
  const index = lowered.indexOf(term.toLocaleLowerCase());
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + term.length + 60);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
};
function findRecallFileMatches(operations, query) {
  const regex = recallRegexFromQuery(query);
  const terms = recallQueryTerms(query).map((term) => term.toLocaleLowerCase());
  return operations.flatMap((operation) => {
    const searchable = clipForSearch(operation.content);
    const matched = regex !== void 0 ? (regex.lastIndex = 0, regex.test(searchable)) : terms.some((term) => searchable.toLocaleLowerCase().includes(term));
    if (!matched) return [];
    const matchingLines = searchable.split("\n").filter((line) => {
      if (regex !== void 0) {
        regex.lastIndex = 0;
        return regex.test(line);
      }
      const lowered = line.toLocaleLowerCase();
      return terms.some((term) => lowered.includes(term));
    });
    return [{
      path: operation.path,
      tool: operation.tool,
      lineCount: matchingLines.length,
      snippet: snippetFor(searchable, query, regex)
    }];
  });
}
var pathMatches = (path, pattern) => path.toLocaleLowerCase().includes(pattern.toLocaleLowerCase());
var MAX_OPERATION_LIST_ENTRIES = 100;
var listOperations = (seq, operations) => {
  const visible = operations.slice(0, MAX_OPERATION_LIST_ENTRIES);
  const lines = visible.map((operation) => `  [#${seq}:${operation.path}] ${operation.tool}(${operation.path})`);
  const omitted = operations.length - visible.length;
  if (omitted > 0) lines.push(`  ... ${omitted} more operations omitted; use a more specific path.`);
  return lines.join("\n");
};
var formatOperation = (operation, seq, options) => {
  const body = operation.content;
  const allLines = body.split("\n");
  const totalLines = allLines.length;
  const previewLimit = PREVIEW_LINES;
  const header = `File: ${operation.path}
Tool: ${operation.tool}`;
  const bodyBudget = Math.max(
    0,
    MAX_RECALL_OUTPUT_BYTES - byteLength(header) - FILE_RESPONSE_RESERVE_BYTES
  );
  if (options.full) {
    const capped2 = capLines(allLines, bodyBudget);
    if (capped2.omittedBytes > 0) {
      const continuation = capped2.truncatedInsideLine ? " The 50KB cap falls inside a line; line-based paging cannot continue within that line." : ` Use #${seq}:${operation.path}:${capped2.completeLines}:${previewLimit} to continue with paged lines.`;
      return `${header}

${capped2.text}

... (${capped2.omittedBytes} more bytes \u2014 file exceeds 50KB display limit.${continuation})`;
    }
    return `${header}

${body}`;
  }
  if (options.offset !== void 0) {
    const start = Math.max(0, options.offset);
    const maxLines = Math.min(
      MAX_FILE_PAGE_LINES,
      Math.max(1, options.limit ?? previewLimit)
    );
    const end = Math.min(start + maxLines, totalLines);
    const visible = allLines.slice(start, end);
    if (visible.length === 0) return `Offset ${start} is beyond file length ${totalLines}. Use #${seq}:${operation.path} for the first ${previewLimit} lines.`;
    const capped2 = capLines(visible, bodyBudget);
    const displayedLines = capped2.truncatedInsideLine ? 1 : capped2.completeLines;
    const displayedEnd = start + Math.max(1, displayedLines);
    let output = `${header}
Lines ${start + 1}-${displayedEnd} (of ${totalLines}):

${capped2.text}`;
    if (capped2.omittedBytes > 0) {
      output += capped2.truncatedInsideLine ? `

... (${capped2.omittedBytes} more bytes in this line range \u2014 the 50KB cap falls inside a line, so line-based paging cannot continue within that line.)` : `

... (${capped2.omittedBytes} more bytes in this line range.)`;
    }
    const nextOffset = capped2.omittedBytes > 0 ? start + capped2.completeLines : end;
    if (!capped2.truncatedInsideLine && nextOffset < totalLines) {
      output += `

--- Use #${seq}:${operation.path}:${nextOffset} or #${seq}:${operation.path}:${nextOffset}:${maxLines} for next ${maxLines} lines, #${seq}:${operation.path}:full for complete ---`;
    } else if (capped2.omittedBytes === 0 && start > 0) {
      output += "\n\n(End of file)";
    }
    return output;
  }
  const previewEnd = Math.min(previewLimit, totalLines);
  const capped = capLines(allLines.slice(0, previewEnd), bodyBudget);
  let note = "";
  if (capped.omittedBytes > 0) {
    note = capped.truncatedInsideLine ? `

... (${capped.omittedBytes} more bytes in the preview \u2014 the 50KB cap falls inside a line, so line-based paging cannot continue within that line.)` : `

... (${capped.omittedBytes} more bytes in the preview \u2014 use #${seq}:${operation.path}:${capped.completeLines}:${previewLimit} to continue.)`;
  } else if (totalLines > previewEnd) {
    note = `

...(${totalLines - previewEnd} more lines \u2014 use #${seq}:${operation.path}:full for complete content, or #${seq}:${operation.path}:${previewEnd} for next ${previewLimit} lines)`;
  }
  return `${header}

${capped.text}${note}`;
};
function parseRecallDrillDown(query) {
  const match = query.match(/^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/iu);
  if (!match) return void 0;
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq < 0) return void 0;
  const pathPattern = match[2];
  const suffix = match[3];
  if (suffix?.toLocaleLowerCase() === "full") return { seq, pathPattern, full: true };
  if (suffix !== void 0) {
    const parts = suffix.split(":").map(Number);
    const offset = parts[0];
    const limit = parts[1];
    if (!Number.isSafeInteger(offset) || offset < 0) return void 0;
    if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1)) return void 0;
    return { seq, pathPattern, full: false, offset, ...limit === void 0 ? {} : { limit } };
  }
  return { seq, pathPattern, full: false };
}
function renderRecallFileDrillDown(seq, operations, drillDown) {
  let rendered;
  if (drillDown.pathPattern.toLocaleLowerCase() === "file") {
    if (operations.length === 0) rendered = `No file content found in entry #${seq}.`;
    else if (operations.length > 1) rendered = `Entry #${seq} has ${operations.length} file operations:
${listOperations(seq, operations)}

Use #${seq}:path to drill into a specific file.`;
    else rendered = formatOperation(operations[0], seq, drillDown);
  } else {
    const matched = operations.filter((operation) => pathMatches(operation.path, drillDown.pathPattern));
    if (matched.length === 0) rendered = `No file content found in entry #${seq} for "${drillDown.pathPattern}".`;
    else if (matched.length > 1) {
      const uniquePaths = new Set(matched.map((operation) => operation.path.toLocaleLowerCase()));
      if (uniquePaths.size === 1) {
        const combined = {
          path: matched[0].path,
          tool: `${matched.map((operation) => operation.tool).join(", ")} (${matched.length} operations)`,
          content: matched.map((operation, index) => `--- operation ${index + 1} ---
${operation.content}`).join("\n\n")
        };
        rendered = formatOperation(combined, seq, drillDown);
      } else {
        rendered = `Entry #${seq} has ${matched.length} file operations matching "${drillDown.pathPattern}":
${listOperations(seq, matched)}

Use #${seq}:<more-specific-path> to drill into a specific file.`;
      }
    } else rendered = formatOperation(matched[0], seq, drillDown);
  }
  const note = rendered.includes("cannot continue within that line") ? "file drill-down response truncated at 50KB; the cap falls inside a line, so line-based paging cannot continue within that line." : "file drill-down response truncated at 50KB; narrow the path or line range.";
  return capRecallOutput(rendered, note);
}

// src/recall.ts
var isOmMemoryId = (query) => /^[a-f0-9]{12}$/u.test((query ?? "").trim());
var OM_RECALL_TODO = "OM \u56DE\u8BFB\u5728 dsh-blackhole \u4E2D\u6682\u672A\u5B9E\u73B0\uFF1A12 \u4F4D observation/reflection ID \u5C1A\u672A\u5EFA\u7ACB\u7D22\u5F15\u3002\u8BF7\u4F7F\u7528 #N\u3001#N:path\uFF0C\u6216\u4EE5\u6587\u672C/\u6B63\u5219\u67E5\u8BE2\u8F6C\u5F55\u5185\u5BB9\u3002";
var PAGE_SIZE = 5;
var DEFAULT_RECENT = 25;
var USER_TEXT_PREVIEW_CHARS = 300;
var TOOL_RESULT_PREVIEW_CHARS = 200;
var TOOL_ARGS_PREVIEW_CHARS = 300;
var SEARCH_BLOCK_CHARS = 10240;
var MAX_RESULT_ENTRIES = 100;
var MAX_EXPANSION_ENTRIES = 50;
var MAX_FILE_MATCH_NOTES = 100;
var PATH_KEYS2 = ["path", "file_path", "filePath", "file", "filename", "target"];
var FILE_CONTENT_KEYS = [
  "content",
  "contents",
  "edits",
  "oldText",
  "old_text",
  "newText",
  "new_text",
  "patch",
  "diff",
  "body",
  "source"
];
var asRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
var asText = (value) => typeof value === "string" ? value : "";
var sliceChars = (text, maxChars) => {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, maxChars);
  const trailingCodeUnit = text.charCodeAt(end - 1);
  if (trailingCodeUnit >= 55296 && trailingCodeUnit <= 56319) end -= 1;
  return text.slice(0, end);
};
var clipChars = (text, maxChars) => text.length <= maxChars ? text : `${sliceChars(text, maxChars)}\u2026`;
var flattenBlocks = (blocks, maxChars = Number.POSITIVE_INFINITY) => {
  const parts = [];
  let remaining = maxChars;
  for (const block of blocks ?? []) {
    if (remaining <= 0) break;
    const separatorChars = parts.length === 0 ? 0 : 1;
    const available = Math.max(0, remaining - separatorChars);
    let text = "";
    if (block.type === "text" || block.type === "reasoning") text = asText(block.text);
    else if (block.type === "tool-result") text = flattenBlocks(block.content, available);
    else if (block.type === "image") text = "[image]";
    else if (block.type === "document") text = "[document]";
    if (!text) continue;
    const visible = sliceChars(text, available);
    if (!visible) break;
    parts.push(visible);
    remaining -= separatorChars + visible.length;
    if (visible.length < text.length) break;
  }
  return parts.join("\n");
};
var parseArgs = (value) => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  if (typeof value !== "string") return void 0;
  try {
    return asRecord2(JSON.parse(value));
  } catch {
    return void 0;
  }
};
var filePathFromBlock = (block) => {
  if (block.type !== "tool-call") return void 0;
  const args = parseArgs(block.arguments);
  if (args === void 0) return void 0;
  for (const key of PATH_KEYS2) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key].replaceAll("\\", "/");
  }
  return void 0;
};
var searchArguments = (args, rendered, toolName) => {
  const mutationTool = isRecallFileMutationTool(toolName);
  if (args === void 0) {
    return mutationTool ? "[file arguments omitted; invalid tool-call JSON]" : rendered;
  }
  const projected = { ...args };
  let redacted = false;
  if (mutationTool) {
    for (const key of FILE_CONTENT_KEYS) {
      if (projected[key] === void 0) continue;
      projected[key] = "[file content indexed separately]";
      redacted = true;
    }
  }
  if (!redacted && mutationTool) {
    const visibleKeys = new Set(PATH_KEYS2);
    const conservative = { ...projected };
    for (const [key, value] of Object.entries(conservative)) {
      if (visibleKeys.has(key)) continue;
      if (typeof value === "string" || Array.isArray(value) || typeof value === "object") {
        conservative[key] = "[file content indexed separately]";
        redacted = true;
      }
    }
    if (redacted) return JSON.stringify(conservative);
  }
  return redacted ? JSON.stringify(projected) : rendered;
};
var displayArguments = (args, rendered, path, seq, toolName) => {
  const indexed = searchArguments(args, rendered, toolName);
  const redaction = "[file content indexed separately]";
  const visible = path === void 0 ? indexed.replaceAll(redaction, "[file content omitted; no file path]") : indexed.replaceAll(redaction, `[file content omitted; use #${seq}:${path}]`);
  return clipChars(visible, TOOL_ARGS_PREVIEW_CHARS);
};
var renderExpandedMessage = (message, seq) => {
  const role = message.role === "assistant" ? "assistant" : "user";
  const lines = [];
  let remainingBytes = MAX_RECALL_OUTPUT_BYTES;
  const pushLine = (line) => {
    const separatorBytes = lines.length === 0 ? 0 : recallUtf8ByteLength("\n");
    const available = Math.max(0, remainingBytes - separatorBytes);
    const visible = clipRecallUtf8(line, available);
    if (!visible) return false;
    lines.push(visible);
    remainingBytes -= separatorBytes + recallUtf8ByteLength(visible);
    return visible.length === line.length;
  };
  pushLine(`[${role}]`);
  for (const block of message.content ?? []) {
    if (remainingBytes <= 0) break;
    if (block.type === "text" || block.type === "reasoning") {
      const text = asText(block.text).trim();
      if (text && !pushLine(text)) break;
      continue;
    }
    if (block.type === "tool-call") {
      const name2 = typeof block.name === "string" ? block.name : "unknown";
      const args = parseArgs(block.arguments);
      const path = filePathFromBlock(block);
      const argumentText = args === void 0 ? asText(block.arguments) : JSON.stringify(args);
      const visibleArguments = displayArguments(args, argumentText, path, seq, name2);
      if (!pushLine(`* ${name2}${visibleArguments ? ` ${visibleArguments}` : ""}`)) break;
      continue;
    }
    if (block.type === "tool-result") {
      const resultText = flattenBlocks(block.content, remainingBytes) || "(empty)";
      if (!pushLine(`[tool-result${block.isError ? " error" : ""}] ${resultText}`)) break;
      continue;
    }
    if ((block.type === "image" || block.type === "document") && !pushLine(`[${block.type}]`)) break;
  }
  pushLine(`(seq ${seq})`);
  return lines.join("\n");
};
var renderMessage = (message, seq) => {
  const role = message.role === "assistant" ? "assistant" : "user";
  const lines = [`[${role}]`];
  const searchLines = [`[${role}]`];
  const files = [];
  const toolCallIds = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" || block.type === "reasoning") {
      const text2 = asText(block.text).trim();
      if (text2) {
        lines.push(clipChars(text2, USER_TEXT_PREVIEW_CHARS));
        searchLines.push(clipChars(text2, SEARCH_BLOCK_CHARS));
      }
      continue;
    }
    if (block.type === "tool-call") {
      const name2 = typeof block.name === "string" ? block.name : "unknown";
      const args = parseArgs(block.arguments);
      const path = filePathFromBlock(block);
      if (path !== void 0) files.push(path);
      if (typeof block.id === "string") toolCallIds.push(block.id);
      const argumentText = args === void 0 ? asText(block.arguments) : JSON.stringify(args);
      const indexedArguments = searchArguments(args, argumentText, name2);
      const visibleArguments = displayArguments(args, argumentText, path, seq, name2);
      lines.push(`* ${name2}${visibleArguments ? ` ${visibleArguments}` : ""}`);
      searchLines.push(`* ${name2}${indexedArguments ? ` ${clipChars(indexedArguments, SEARCH_BLOCK_CHARS)}` : ""}`);
      continue;
    }
    if (block.type === "tool-result") {
      const toolCallId = typeof block.toolCallId === "string" ? block.toolCallId : "";
      if (toolCallId) toolCallIds.push(toolCallId);
      const resultText = flattenBlocks(block.content, SEARCH_BLOCK_CHARS) || "(empty)";
      const resultPrefix = `[tool-result${block.isError ? " error" : ""}] `;
      lines.push(`${resultPrefix}${clipChars(resultText, TOOL_RESULT_PREVIEW_CHARS)}`);
      searchLines.push(`${resultPrefix}${clipChars(resultText, SEARCH_BLOCK_CHARS)}`);
      continue;
    }
    if (block.type === "image" || block.type === "document") {
      lines.push(`[${block.type}]`);
      searchLines.push(`[${block.type}]`);
    }
  }
  lines.push(`(seq ${seq})`);
  searchLines.push(`(seq ${seq})`);
  const text = lines.join("\n");
  const fileOperations = extractRecallFileOperations(message);
  return {
    text,
    getExpandedText: () => renderExpandedMessage(message, seq),
    files: [.../* @__PURE__ */ new Set([...files, ...fileOperations.map((operation) => operation.path)])],
    fileOperations,
    searchText: `${searchLines.join("\n")}
${recallFileSearchText(fileOperations)}`.trim(),
    toolCallIds: [...new Set(toolCallIds)]
  };
};
function indexRecallSession(session) {
  return session.events.flatMap((event) => {
    if (!Number.isSafeInteger(event.seq)) return [];
    const message = session.deriveEventMessage(event);
    if (message === null) return [];
    const rendered = renderMessage(message, event.seq);
    let expandedText;
    const entry = {
      seq: event.seq,
      id: typeof message.id === "string" ? message.id : `seq-${event.seq}`,
      message,
      text: rendered.text,
      get expandedText() {
        expandedText ??= rendered.getExpandedText();
        return expandedText;
      },
      files: rendered.files,
      fileOperations: rendered.fileOperations,
      searchText: rendered.searchText,
      toolCallIds: rendered.toolCallIds
    };
    Object.defineProperty(entry, "expandedText", { enumerable: false });
    return [entry];
  });
}
var normalizeQuery = (query) => (query ?? "").trim();
var parseEntryReference = (query) => {
  const match = query.match(/^#(\d+)$/u);
  if (match === null) return void 0;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : void 0;
};
var termsOf = (query) => recallQueryTerms(query).map((term) => term.toLocaleLowerCase());
function rankRecallEntries(entries, query, mode = "hybrid") {
  const normalized = normalizeQuery(query);
  if (!normalized) return [...entries];
  const regex = recallRegexFromQuery(normalized);
  const corpusOf = (entry) => mode === "file" ? recallFileSearchText(entry.fileOperations) : entry.searchText;
  if (regex !== void 0) return entries.filter((entry) => {
    regex.lastIndex = 0;
    return regex.test(corpusOf(entry));
  });
  const terms = [...new Set(termsOf(normalized))];
  if (terms.length === 0) return [];
  const documentFrequency = /* @__PURE__ */ new Map();
  const tokenSets = entries.map((entry) => new Set(termsOf(corpusOf(entry))));
  for (const tokenSet of tokenSets) for (const term of terms) if (tokenSet.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const averageLength = entries.length === 0 ? 1 : entries.reduce((sum, entry) => sum + termsOf(corpusOf(entry)).length, 0) / entries.length;
  const scored = entries.map((entry, index) => {
    const corpus = corpusOf(entry);
    const tokens = termsOf(corpus);
    const counts = /* @__PURE__ */ new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const score = terms.reduce((total, term) => {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) return total;
      const idf = Math.log(1 + (entries.length - (documentFrequency.get(term) ?? 0) + 0.5) / ((documentFrequency.get(term) ?? 0) + 0.5));
      const lengthNorm = 1 + 0.75 * (tokens.length / Math.max(1, averageLength) - 1);
      return total + idf * (frequency * 2.2 / (frequency + 1.2 * lengthNorm));
    }, 0) + (corpus.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()) ? 1 : 0);
    return { entry, score, index };
  });
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.entry);
}
var touchedFilesOf = (entries) => {
  const files = /* @__PURE__ */ new Map();
  for (const entry of entries) for (const operation of entry.fileOperations) {
    const refs = files.get(operation.path) ?? [];
    const existing = refs.find((ref) => ref.seq === entry.seq);
    if (existing === void 0) refs.push({ seq: entry.seq, tools: /* @__PURE__ */ new Set([operation.tool]) });
    else existing.tools.add(operation.tool);
    files.set(operation.path, refs);
  }
  return [...files.entries()].map(([path, refs]) => ({
    path,
    refs: refs.map((ref) => ({ seq: ref.seq, tools: [...ref.tools] }))
  }));
};
var formatTouched = (entries, params) => {
  const files = touchedFilesOf(entries);
  if (files.length === 0) return { text: "No touched files found.", total: 0, page: 1, totalPages: 1, entrySeqs: [] };
  const requestedLimit = params.limit;
  const pageSize = typeof requestedLimit === "number" && Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(MAX_RESULT_ENTRIES, requestedLimit) : PAGE_SIZE;
  const explicitOffset = typeof params.offset === "number" && Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : void 0;
  const requestedPage = params.page;
  const page = explicitOffset === void 0 ? typeof requestedPage === "number" && Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1 : Math.floor(explicitOffset / pageSize) + 1;
  const offset = explicitOffset ?? (page - 1) * pageSize;
  const totalPages = Math.max(1, Math.ceil(files.length / pageSize));
  const visible = files.slice(offset, offset + pageSize);
  const lines = visible.map((file) => {
    const refs = file.refs.map((ref) => `#${ref.seq} (${ref.tools.join(", ")})`).join(", ");
    return `- ${file.path} \u2014 ${refs}`;
  });
  const nextPage = offset + pageSize < files.length ? `
--- Use page:${page + 1} limit:${pageSize} or offset:${offset + pageSize} limit:${pageSize} for more files ---` : "";
  const entrySeqs = [...new Set(visible.flatMap((file) => file.refs.map((ref) => ref.seq)))];
  return {
    text: `Page ${page}/${totalPages} (${files.length} total files)

${lines.join("\n") || "No touched files on this page."}${nextPage}`,
    total: files.length,
    page,
    totalPages,
    entrySeqs
  };
};
function recallSession(session, params = {}) {
  const mode = params.mode ?? "hybrid";
  const query = normalizeQuery(params.query);
  if (isOmMemoryId(query)) {
    return { text: OM_RECALL_TODO, entries: [], total: 0, page: 1, totalPages: 1 };
  }
  const allEntries = indexRecallSession(session);
  const allowedSeqs = params.scope === "all" || session.lineageSeqs === void 0 ? void 0 : new Set(session.lineageSeqs);
  const scoped = allowedSeqs === void 0 ? allEntries : allEntries.filter((entry) => allowedSeqs.has(entry.seq));
  if (mode === "touched") {
    const touched = formatTouched(scoped, params);
    const entrySeqs = new Set(touched.entrySeqs);
    const entries = scoped.filter((entry) => entrySeqs.has(entry.seq)).slice(0, MAX_RESULT_ENTRIES);
    return {
      text: capRecallOutput(touched.text),
      entries,
      total: touched.total,
      page: touched.page,
      totalPages: touched.totalPages
    };
  }
  const entryReference = parseEntryReference(query);
  if (entryReference !== void 0) {
    const entry = scoped.find((candidate) => candidate.seq === entryReference);
    if (entry === void 0) {
      return { text: `Cannot expand indices outside the selected scope: ${entryReference}. Use scope:'all' to reach other branches.`, entries: [], total: 0, page: 1, totalPages: 1 };
    }
    return {
      text: capRecallOutput(`#${entry.seq}
${entry.expandedText}`),
      entries: [entry],
      total: 1,
      page: 1,
      totalPages: 1
    };
  }
  const drillDown = parseRecallDrillDown(query);
  if (drillDown === void 0 && /^#\d+:/u.test(query)) {
    return {
      text: "Invalid recall drill-down syntax. Use #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit.",
      entries: [],
      total: 0,
      page: 1,
      totalPages: 1
    };
  }
  if (drillDown !== void 0) {
    const entry = scoped.find((candidate) => candidate.seq === drillDown.seq);
    if (entry === void 0) {
      return { text: `Cannot expand indices outside the selected scope: ${drillDown.seq}. Use scope:'all' to reach other branches.`, entries: [], total: 0, page: 1, totalPages: 1 };
    }
    return {
      text: renderRecallFileDrillDown(entry.seq, entry.fileOperations, drillDown),
      entries: [entry],
      total: 1,
      page: 1,
      totalPages: 1
    };
  }
  const candidates = mode === "file" ? scoped.filter((entry) => entry.fileOperations.length > 0) : scoped;
  const ranked = query ? rankRecallEntries(candidates, query, mode) : candidates.slice(-DEFAULT_RECENT);
  const uniqueExpansionTargets = [...new Set(params.expand ?? [])];
  const expansionTargets = uniqueExpansionTargets.slice(0, MAX_EXPANSION_ENTRIES);
  const entriesBySeq = new Map(scoped.map((entry) => [entry.seq, entry]));
  const expanded = expansionTargets.flatMap((seq) => {
    const entry = entriesBySeq.get(seq);
    return entry === void 0 ? [] : [entry];
  });
  const merged = [...new Map([...ranked, ...expanded].map((entry) => [entry.seq, entry])).values()];
  const explicitOffset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : void 0;
  const explicitLimit = Number.isFinite(params.limit) ? Math.min(MAX_RESULT_ENTRIES, Math.max(1, Math.floor(params.limit))) : void 0;
  const pageSize = explicitLimit ?? PAGE_SIZE;
  const requestedPage = params.page;
  const page = explicitOffset === void 0 ? typeof requestedPage === "number" && Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1 : Math.floor(explicitOffset / pageSize) + 1;
  const offset = explicitOffset ?? (page - 1) * pageSize;
  const totalPages = Math.max(1, Math.ceil(merged.length / pageSize));
  const pagedEntries = merged.slice(offset, offset + pageSize);
  const allPageEntries = [...new Map([...expanded, ...pagedEntries].map((entry) => [entry.seq, entry])).values()];
  const pageEntries = allPageEntries.slice(0, MAX_RESULT_ENTRIES);
  const expandedSeqs = new Set(expanded.map((entry) => entry.seq));
  const expansionNotice = uniqueExpansionTargets.length > MAX_EXPANSION_ENTRIES ? `
--- Only the first ${MAX_EXPANSION_ENTRIES} explicit expansions are shown; narrow expand for the rest. ---` : "";
  const resultNotice = allPageEntries.length > MAX_RESULT_ENTRIES ? `
--- ${allPageEntries.length - MAX_RESULT_ENTRIES} page entries omitted by the ${MAX_RESULT_ENTRIES}-entry response bound; use paging or narrower expand. ---` : "";
  const header = query ? `${merged.length} matches${params.scope === "all" ? " (scope: all)" : ""}` : `Recent session entries${params.scope === "all" ? " (scope: all)" : ""}`;
  const nextPage = offset + pageSize < merged.length ? `
--- Use offset:${offset + pageSize} limit:${pageSize} for more results ---` : "";
  const decorated = pageEntries.map((entry) => {
    if (query && entry.fileOperations.length > 0) {
      Object.defineProperty(entry, "fileMatches", {
        configurable: true,
        enumerable: true,
        value: findRecallFileMatches(entry.fileOperations, query),
        writable: false
      });
    }
    return entry;
  });
  const fileNotes = (entry) => {
    if (entry.fileMatches === void 0 || entry.fileMatches.length === 0) return "";
    const visibleMatches = entry.fileMatches.slice(0, MAX_FILE_MATCH_NOTES);
    const omitted = entry.fileMatches.length - visibleMatches.length;
    return `
[file matches]
${visibleMatches.map((match) => `- ${match.path} (${match.tool}, ${match.lineCount} matching lines)${match.snippet === void 0 ? "" : `
  ${match.snippet}`}`).join("\n")}${omitted > 0 ? `
- ... ${omitted} more file matches omitted; narrow the query.` : ""}`;
  };
  const text = capRecallOutput(`${header}

${decorated.map((entry) => `#${entry.seq}
${expandedSeqs.has(entry.seq) ? entry.expandedText : entry.text}${fileNotes(entry)}`).join("\n\n") || "No matching session entries."}${nextPage}${expansionNotice}${resultNotice}`);
  return { text, entries: decorated, total: merged.length, page, totalPages };
}

// src/recall-command.ts
var COMMAND_FLAGS = /(?:^|\s)(page:\d+|scope:(?:all|lineage)|mode:(?:hybrid|file|touched)|offset:\d+|limit:\d+)(?=\s|$)/giu;
function parseRecallCommandInput(rawInput) {
  const raw = rawInput.trim();
  const flags = [...raw.matchAll(COMMAND_FLAGS)].map((match) => match[1].toLocaleLowerCase());
  const query = raw.replace(COMMAND_FLAGS, " ").replace(/\s{2,}/gu, " ").trim();
  const find = (prefix) => flags.find((flag) => flag.startsWith(`${prefix}:`))?.slice(prefix.length + 1);
  const pageRaw = find("page");
  const offsetRaw = find("offset");
  const limitRaw = find("limit");
  const positiveInteger = (value) => {
    if (value === void 0) return void 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : void 0;
  };
  const nonNegativeInteger = (value) => {
    if (value === void 0) return void 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : void 0;
  };
  const page = positiveInteger(pageRaw);
  const offset = nonNegativeInteger(offsetRaw);
  const limit = positiveInteger(limitRaw);
  const scopeRaw = find("scope");
  const modeRaw = find("mode");
  return {
    ...query.length > 0 ? { query } : {},
    ...page === void 0 ? {} : { page },
    ...offset === void 0 ? {} : { offset },
    ...limit === void 0 ? {} : { limit },
    ...scopeRaw === "all" || scopeRaw === "lineage" ? { scope: scopeRaw } : {},
    ...modeRaw === "hybrid" || modeRaw === "file" || modeRaw === "touched" ? { mode: modeRaw } : {}
  };
}
var hasRecallSession = (value) => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return Array.isArray(candidate.events) && typeof candidate.deriveEventMessage === "function";
};
var RECALL_COMMAND_NAME = "blackhole-recall";
function createRecallCommand() {
  return {
    name: RECALL_COMMAND_NAME,
    description: "\u68C0\u7D22\u4F1A\u8BDD\u5386\u53F2\uFF0C\u56DE\u8BFB\u88AB\u538B\u7F29\u7684\u4E0A\u4E0B\u6587\u4E0E\u66F4\u65E9\u7684\u6587\u4EF6\u64CD\u4F5C\u3002",
    input: { hint: "<query> [page:N] [offset:N] [limit:N] [scope:all] [mode:file|touched]" },
    handler: async (invocation) => {
      const session = invocation.agent?.session;
      if (!hasRecallSession(session)) {
        return { kind: "error", text: "\u5F53\u524D\u6CA1\u6709\u53EF\u7528\u4E8E\u56DE\u8BFB\u7684\u4F1A\u8BDD\u3002" };
      }
      const params = parseRecallCommandInput(invocation.rawInput);
      if (isOmMemoryId(params.query)) return { kind: "success", text: OM_RECALL_TODO };
      return { kind: "success", text: recallSession(session, params).text };
    }
  };
}

// src/mode-command.ts
var MODE_COMMAND_NAME = "blackhole-mode";
var FALLBACK_MODES = ["instant", "instant-then-llm", "llm"];
var MODE_DESCRIPTIONS = {
  instant: "\u672C\u5730\u786E\u5B9A\u6027 VCC \u7F16\u8BD1\u5668\uFF08\u96F6\u6A21\u578B\u8C03\u7528\uFF0C(seq N) \u56DE\u8BFB\u6307\u9488\uFF09",
  "instant-then-llm": "\u5148\u672C\u5730\u7F16\u8BD1\uFF0C\u4EC5\u5F53\u7F16\u8BD1\u5668\u4E5F\u5931\u8D25\u65F6\u6539\u7528\u539F\u751F LLM \u6458\u8981",
  llm: "\u539F\u751F\u5355\u6B21 LLM \u6458\u8981\uFF08\u5B98\u65B9 dsh-compaction-basic \u884C\u4E3A\uFF09"
};
var USAGE = "\u7528\u6CD5\uFF1A[instant | instant-then-llm | llm | remote [on | off] | reset]";
function parseModeCommandInput(rawInput) {
  const input = rawInput.trim().toLowerCase();
  if (input.length === 0) return { action: "status" };
  if (FALLBACK_MODES.includes(input)) {
    return { action: "mode", mode: input };
  }
  if (input === "reset") return { action: "reset" };
  if (input === "remote" || input.startsWith("remote ")) {
    const argument = input.slice("remote".length).trim();
    if (argument.length === 0) return { action: "remote" };
    if (argument === "on") return { action: "remote", enabled: true };
    if (argument === "off") return { action: "remote", enabled: false };
    return {
      action: "invalid",
      message: `"remote ${argument}" \u4E0D\u662F\u5408\u6CD5\u53D6\u503C\uFF1B\u8BF7\u7528 "remote on" \u6216 "remote off"`
    };
  }
  return {
    action: "invalid",
    message: `\u672A\u77E5\u6A21\u5F0F ${JSON.stringify(rawInput.trim())}\uFF1B${USAGE}`
  };
}
function statusText(controller) {
  const mode = controller.getFallbackMode();
  const remote = controller.isRemoteEnabled() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528";
  const modeOverride = mode !== controller.getFallbackModeDefault() ? `\uFF08\u8FD0\u884C\u65F6\u8986\u76D6\uFF1B\u914D\u7F6E\u9ED8\u8BA4\uFF1A${controller.getFallbackModeDefault()}\uFF09` : "";
  const remoteOverride = controller.isRemoteEnabled() !== controller.isRemoteEnabledDefault() ? `\uFF08\u8FD0\u884C\u65F6\u8986\u76D6\uFF1B\u914D\u7F6E\u9ED8\u8BA4\uFF1A${controller.isRemoteEnabledDefault() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528"}\uFF09` : "";
  return [
    `\u56DE\u9000\u94FE\uFF1A${mode} \u2014 ${MODE_DESCRIPTIONS[mode]}${modeOverride}`,
    `\u8FDC\u7AEF Responses \u538B\u7F29\uFF1A${remote}${remoteOverride}\uFF08${controller.describeEndpoints()}\uFF09`,
    `\u5207\u6362\u5BF9\u672C DSH \u4E3B\u76EE\u5F55\u6301\u4E45\u751F\u6548\uFF1B/blackhole-mode reset \u6062\u590D\u914D\u7F6E\u9ED8\u8BA4\u3002${USAGE}`
  ].join("\n");
}
function createModeCommand(controller) {
  return {
    name: MODE_COMMAND_NAME,
    description: "\u67E5\u770B\u6216\u5207\u6362 dsh-blackhole \u7684\u538B\u7F29\u7BA1\u7EBF\uFF08\u8FD0\u884C\u65F6\u751F\u6548\uFF09\u3002",
    input: { hint: "[instant | instant-then-llm | llm | remote [on | off] | reset]" },
    handler: (invocation) => {
      const parsed = parseModeCommandInput(invocation.rawInput);
      switch (parsed.action) {
        case "status":
          return { kind: "success", text: statusText(controller) };
        case "mode": {
          controller.setFallbackMode(parsed.mode);
          return {
            kind: "success",
            text: `\u56DE\u9000\u94FE\u5DF2\u5207\u6362\u4E3A ${parsed.mode} \u2014 ${MODE_DESCRIPTIONS[parsed.mode]}\uFF1B\u8986\u76D6\u8DE8 DSH \u91CD\u542F\u4FDD\u7559\uFF08/blackhole-mode reset \u6E05\u9664\uFF09\u3002`
          };
        }
        case "remote": {
          if (parsed.enabled === void 0) {
            return {
              kind: "success",
              text: `\u8FDC\u7AEF Responses \u538B\u7F29\u5F53\u524D${controller.isRemoteEnabled() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528"}\uFF08${controller.describeEndpoints()}\uFF09\u3002`
            };
          }
          controller.setRemoteEnabled(parsed.enabled);
          return {
            kind: "success",
            text: parsed.enabled ? `\u8FDC\u7AEF Responses \u538B\u7F29\u5DF2\u91CD\u65B0\u542F\u7528\uFF08${controller.describeEndpoints()}\uFF09\uFF1B\u5339\u914D\u7684\u76EE\u6807\u5148\u8D70\u8FDC\u7AEF\uFF0C\u5931\u8D25\u540E\u843D\u5230${controller.getFallbackMode()}\u56DE\u9000\u3002` : `\u8FDC\u7AEF Responses \u538B\u7F29\u5DF2\u7981\u7528\uFF1B\u6240\u6709\u76EE\u6807\u6539\u7528${controller.getFallbackMode()}\u56DE\u9000\uFF0C\u76F4\u5230\u91CD\u65B0\u542F\u7528\u3002\u5207\u6362\u8DE8 DSH \u91CD\u542F\u4FDD\u7559\uFF1B\u672C\u5730\u68C0\u67E5\u70B9\u843D\u76D8\u65F6\u4F1A\u6E05\u9664\u5DF2\u6301\u4E45\u5316\u7684\u8FDC\u7AEF\u66FF\u6362\u5386\u53F2\u3002`
          };
        }
        case "reset": {
          controller.resetRuntimeMode();
          return {
            kind: "success",
            text: `\u8FD0\u884C\u65F6\u8986\u76D6\u5DF2\u6E05\u9664\uFF1B\u56DE\u5230\u914D\u7F6E\u9ED8\u8BA4\uFF08\u56DE\u9000\u94FE\uFF1A${controller.getFallbackMode()}\uFF0C\u8FDC\u7AEF Responses \u538B\u7F29${controller.isRemoteEnabled() ? "\u5DF2\u542F\u7528" : "\u5DF2\u7981\u7528"}\uFF09\u3002`
          };
        }
        default:
          return { kind: "error", text: parsed.message };
      }
    }
  };
}

// src/commands-plugin.ts
var name = "blackhole-commands";
var inject = ["commands", "compaction"];
function apply(ctx) {
  const host = ctx;
  const engine = host.compaction;
  host.effect(function* () {
    yield host.commands.register(createModeCommand(engine.modeController));
    yield host.commands.register(createRecallCommand());
  }, "dsh-blackhole commands");
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=commands-plugin.js.map
