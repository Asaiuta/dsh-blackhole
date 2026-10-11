// Fixture sessions for the checkpoint-quality eval (tests/eval-quality.mjs).
//
// Fixtures are plain data shaped like the compiler's `CompilerNode` view:
// `{ seq, message }` with DSH message vocabulary (role 'user'/'assistant'/'tool',
// tool results as first-class tool-role messages).  The eval compiles them with
// the REAL `compileInstantRegion` and measures quality — nothing here mocks the
// compiler.
//
// Entity tiers:
//   verbatim — the string must appear in the compiled checkpoint text;
//   pointed  — the entity's event seq must be referenced by the checkpoint
//              (a `(seq N)` pointer, a `-> result M` ref, a truncation marker,
//              or inside an elision span), i.e. recoverable via `#N` recall.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  compressBash,
  DEFAULT_TOOL_KEY_FIELDS,
  parseToolArguments,
  pickToolKeyArg,
  sanitize,
  stripSelfTalkPrefix,
  truncateTextTokens,
} from '../lib/index.js'

/** Auto-numbered node builders; seqs are assigned in call order starting at 1. */
export function createNodeBuilder() {
  let next = 0
  const user = (text, extra = {}) => ({
    seq: ++next,
    message: { id: `u${next}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra },
  })
  const userImage = (mediaType) => ({
    seq: ++next,
    message: { id: `u${next}`, role: 'user', content: [{ type: 'image', mediaType }], source: { kind: 'user' } },
  })
  const checkpoint = (text) => ({
    seq: ++next,
    message: {
      id: `c${next}`, role: 'user', content: [{ type: 'text', text }],
      source: { kind: 'compact-checkpoint', compactionId: 'seed-0' },
    },
  })
  const assistant = (...blocks) => ({
    seq: ++next,
    message: {
      id: `a${next}`, role: 'assistant', content: blocks,
      source: { kind: 'model', provider: 'eval', model: 'fixture' },
    },
  })
  const text = (body) => ({ type: 'text', text: body })
  const reasoning = (body) => ({ type: 'reasoning', text: body })
  const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
  const toolMsg = (callId, body, isError = false) => ({
    seq: ++next,
    message: {
      id: `t${next}`, role: 'tool', toolCallId: callId, isError,
      content: [{ type: 'text', text: body }], source: { kind: 'tool', callId },
    },
  })
  return { state: () => next, user, userImage, checkpoint, assistant, text, reasoning, call, toolMsg }
}

/** seq of the tool-role message answering `callId` (for `pointed` entities). */
export function resultSeqOf(nodes, callId) {
  const node = nodes.find((n) => n.message.role === 'tool' && n.message.toolCallId === callId)
  if (node === undefined) throw new Error(`fixture bug: no tool result for call ${callId}`)
  return node.seq
}

// ── fixture 1: a realistic coding turn ──────────────────────────────────────
// Exercises every compiler branch at once: a previous checkpoint, noise XML,
// a skill block, self-talk stripping, repeated tool calls (adjacent merge),
// a failed bash run (`[tool_error]`), long assistant text (truncation marker),
// an image, a reasoning-only turn, and tool results reachable via pointers.

export function buildCodingSession() {
  const b = createNodeBuilder()
  const nodes = [
    b.checkpoint('Earlier work on the auth module is summarized in the active context.'),
    b.user(
      '<system-reminder>session focus: auth refactor</system-reminder>\n' +
      '<skill name="refactoring">Keep helpers pure and preserve call sites.</skill>\n' +
      'Please refactor src/auth/login.ts to split the session token logic out of the login handler.',
    ),
    b.assistant(
      b.text(
        'Hmm, wait — first I will read the login handler, then split the session token ' +
        'logic into a helper that src/auth/session.ts can import. ' +
        'The login handler currently mixes request parsing, token issuance, and cookie handling in one body. '.repeat(40) +
        'The helper boundary should sit between parsing and issuance.',
      ),
    ),
    b.assistant(b.call('call-1', 'read', { path: 'src/auth/login.ts' })),
    b.toolMsg('call-1', 'export function login(req) {\n  const token = issueToken(req.user)\n' + 'x'.repeat(3000)),
    b.assistant(b.call('call-2', 'read', { path: 'src/auth/login.ts' })),
    b.toolMsg('call-2', 'export function login(req) {\n  const token = issueToken(req.user)\n' + 'x'.repeat(3000)),
    b.user('<ide_selection>const token = getSession()</ide_selection>'),
    b.assistant(b.call('call-3', 'edit', { path: 'src/auth/session.ts', old: 'export function issueToken', new: 'export function issueSessionToken' })),
    b.toolMsg('call-3', 'The file src/auth/session.ts has been updated.'),
    b.assistant(b.text('The helper compiles. Running the suite.'), b.call('call-4', 'bash', { command: 'npm test' })),
    b.toolMsg('call-4', 'AssertionError: expected 3 to be 4\n    at assertEqual (runner.js:12:5)\n    at test/login.test.js:3:1', true),
    b.assistant(
      b.text('The token helper needs the expiry constant plumbed through.'),
      b.call('call-5', 'edit', { path: 'src/auth/session.ts', old: 'export function issueSessionToken', new: 'export function issueSessionToken(ttl)' }),
    ),
    b.toolMsg('call-5', 'The file src/auth/session.ts has been updated.'),
    b.assistant(b.call('call-6', 'bash', { command: 'npm test' })),
    b.toolMsg('call-6', 'suite passed\n' + 'y'.repeat(2500)),
    b.assistant(b.call('call-7', 'bash', { command: 'npm run lint && npm test -- --coverage' })),
    b.toolMsg('call-7', 'lint clean, coverage 94%.'),
    b.assistant(
      b.text(
        'The refactor is complete. The login handler now delegates token issuance to the ' +
        'session helper, and the full suite passes with coverage at 94%. ' +
        'Set JWT_EXPIRY = 3600 in the production profile before rollout.',
      ),
    ),
    b.userImage('image/png'),
    b.assistant(b.reasoning('double check the expiry default and the coverage gates before declaring done.')),
  ]
  const entities = [
    { tier: 'verbatim', label: 'read file path (user text + tool arg)', needle: 'src/auth/login.ts' },
    { tier: 'verbatim', label: 'edited file path (tool arg)', needle: 'src/auth/session.ts' },
    { tier: 'verbatim', label: 'plan head after self-talk strip', needle: 'first I will read the login handler' },
    { tier: 'verbatim', label: 'plan TAIL survives dual-window truncation', needle: 'The helper boundary should sit between parsing and issuance.' },
    { tier: 'verbatim', label: 'failed run signature ([tool_error] body)', needle: 'expected 3 to be 4' },
    { tier: 'verbatim', label: 'conclusion constant (final assistant text)', needle: 'JWT_EXPIRY = 3600' },
    { tier: 'verbatim', label: 'collapsed skill label', needle: '[skill: refactoring]' },
    { tier: 'verbatim', label: 'compressed bash command', needle: 'npm test' },
    { tier: 'pointed', label: 'merged repeat keeps both call seqs', seq: nodes[5].seq },
    { tier: 'pointed', label: 'failed run result via -> result', seq: resultSeqOf(nodes, 'call-4') },
    { tier: 'pointed', label: 'passing run result via -> result', seq: resultSeqOf(nodes, 'call-6') },
    { tier: 'pointed', label: 'noise-only user message note', seq: nodes[7].seq },
    { tier: 'pointed', label: 'image label pointer', seq: nodes[19].seq },
    { tier: 'pointed', label: 'truncation marker on long plan', seq: nodes[2].seq },
  ]
  return {
    name: 'coding-session',
    description: 'one realistic coding turn: checkpoint, noise, skill, repeats, error, conclusion, media',
    nodes,
    entities,
    // Structured counters the fixture deterministically produces.
    expectations: { toolCalls: 7, toolResults: 7, toolErrors: 1, checkpoints: 1, images: 1, reasoningElided: 1, noiseElided: 1 },
  }
}

// ── fixture 2: a long session under a tight cap ─────────────────────────────
// 30 user→assistant→tools turns (plus one 10-call turn to trip toolsPerTurn),
// compiled with a token cap far below the shadow size: the cap must drop the
// oldest tool rows first, keep the newest content, and mark the loss.

export function buildLongSession() {
  const b = createNodeBuilder()
  const nodes = []
  for (let turn = 1; turn <= 30; turn++) {
    nodes.push(b.user(`Continue with feature ${turn}.`))
    const blocks = [b.text(`Turn ${turn}: edited src/feature/file${turn}.ts and verified the behavior.`)]
    blocks.push(b.call(`r${turn}`, 'read', { path: `src/feature/file${turn}.ts` }))
    blocks.push(b.call(`e${turn}`, 'edit', { path: `src/feature/file${turn}.ts` }))
    if (turn === 30) {
      for (let run = 1; run <= 10; run++) blocks.push(b.call(`b30-${run}`, 'bash', { command: `npm test -- --filter suite${run}` }))
    }
    nodes.push(b.assistant(...blocks))
    nodes.push(b.toolMsg(`r${turn}`, `export const feature${turn} = ${turn}\n` + 'z'.repeat(1200)))
    nodes.push(b.toolMsg(`e${turn}`, `The file src/feature/file${turn}.ts has been updated.`))
    if (turn === 30) {
      for (let run = 1; run <= 10; run++) nodes.push(b.toolMsg(`b30-${run}`, `suite${run} passed`))
    }
  }
  const entities = [
    { tier: 'verbatim', label: 'newest tool arg survives the cap', needle: 'file30.ts' },
    { tier: 'verbatim', label: 'newest turn text survives the cap', needle: 'Turn 30: edited' },
  ]
  return {
    name: 'long-session-cap',
    description: '30 turns with a 10-call final turn, compiled under a 1200-token cap',
    nodes,
    entities,
    capTokens: 1200,
  }
}

// ── fixture 3: a REAL recorded session ──────────────────────────────────────
// Loads an actual pi session transcript (the same `~/.pi/agent/sessions`
// source the equivalence harnesses use), converts it with the proven
// pi→DSH projection, and extracts entities from the TAIL of the transcript —
// the content the checkpoint must keep by design (newest assistant texts,
// rendered key arguments of the last tool calls).  Returns `null` when no
// transcript is available so the eval can skip gracefully on machines
// without one.  `DSH_EVAL_SESSION` pins a specific .jsonl (recommended for
// stable baseline numbers — the default picks the OLDEST archive file).

const ENTITY_RE = /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.[A-Za-z0-9_@.-]+/g
const URL_RE = /https?:\/\/[^\s)"']+/g

function collectEntities(text) {
  const found = new Set()
  for (const m of text.matchAll(ENTITY_RE)) if (m[0].length > 5) found.add(m[0])
  for (const m of text.matchAll(URL_RE)) found.add(m[0])
  return found
}

function discoverRealSessionFile() {
  if (process.env.DSH_EVAL_SESSION !== undefined) {
    return existsSync(process.env.DSH_EVAL_SESSION) ? process.env.DSH_EVAL_SESSION : null
  }
  const sessionsRoot = join(homedir(), '.pi', 'agent', 'sessions')
  if (!existsSync(sessionsRoot)) return null
  const slugDir = readdirSync(sessionsRoot, { withFileTypes: true })
    .find((d) => d.isDirectory() && d.name.includes(basename(process.cwd())))?.name
  if (slugDir === undefined) return null
  const files = readdirSync(join(sessionsRoot, slugDir)).filter((f) => f.endsWith('.jsonl')).sort()
  return files.length > 0 ? join(sessionsRoot, slugDir, files[0]) : null
}

export function loadPiMessages(file) {
  const messages = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line)
      if (d.type !== 'message') continue
      const m = d.message
      if (!m || typeof m.role !== 'string') continue
      if (m.role === 'assistant' && (!Array.isArray(m.content) || m.content.length === 0)) continue
      messages.push(m)
    } catch {}
  }
  return messages
}

/** The battle-tested pi→DSH projection from the equivalence harnesses (legacy tool-result shape). */
function toDshMessages(piMessages) {
  let callSeq = 0
  const out = []
  for (const m of piMessages) {
    if (m.role === 'user') {
      const blocks = []
      for (const part of m.content) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text })
        else if (part.type === 'image') blocks.push({ type: 'image', mediaType: part.mimeType })
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      out.push({ id: `u${out.length}`, role: 'user', source: { kind: 'user' }, content: blocks })
    } else if (m.role === 'assistant') {
      const blocks = m.content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        if (part.type === 'thinking') return { type: 'reasoning', text: part.thinking }
        if (part.type === 'toolCall') {
          callSeq += 1
          const args = typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {})
          return { type: 'tool-call', id: part.id ?? `call_${callSeq}`, name: part.name, arguments: args }
        }
        return null
      }).filter(Boolean)
      if (blocks.length > 0) {
        out.push({ id: `a${out.length}`, role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'real-session' }, content: blocks })
      }
    } else if (m.role === 'toolResult') {
      const textBlocks = []
      for (const part of m.content ?? []) {
        if (part.type === 'text') textBlocks.push({ type: 'text', text: part.text })
      }
      out.push({
        id: `r${out.length}`, role: 'user', source: { kind: 'tool', callId: m.toolCallId }, content: [
          { type: 'tool-result', toolCallId: m.toolCallId, isError: m.isError === true, content: textBlocks },
        ],
      })
    }
  }
  return out
}

/** Exactly how the compiler renders a call's one-liner base (what a verbatim entity may assert against). */
function renderedCallBase(callRow) {
  if (callRow.name === 'bash' || callRow.name === 'Bash') {
    const parsed = parseToolArguments(callRow.arguments)
    const raw = parsed !== null && typeof parsed.command === 'string' ? parsed.command : ''
    const compressed = compressBash(raw, 120)
    return compressed.endsWith('...') ? null : compressed
  }
  const arg = pickToolKeyArg(callRow.name, parseToolArguments(callRow.arguments), DEFAULT_TOOL_KEY_FIELDS)
  if (arg === undefined) return null
  const clean = arg.replace(/[\r\n\t]+/g, ' ').trim()
  return clean.length > 0 && clean.length <= 100 ? clean : null
}

export function buildRealSession() {
  let file
  try {
    file = discoverRealSessionFile()
  } catch {
    return null
  }
  if (file === null) return null
  const messages = loadPiMessages(file)
  if (messages.length < 10) return null
  const dsh = toDshMessages(messages)
  // 1-based seqs so the pointer-integrity invariant matches the synthetic fixtures.
  const nodes = dsh.map((message, index) => ({ seq: index + 1, message }))

  // verbatim entities: from EXACTLY what the compiler renders out of the
  // newest assistant texts — same transform chain (sanitize → self-talk
  // strip → 512-token truncation), so the extraction window can never
  // diverge from the truncation cut.  (A whitespace-word window misjudges
  // CJK text: tokenize counts each CJK character, so a "156-word" Chinese
  // paragraph blows well past 512 tokens.)
  const verbatim = new Set()
  const assistants = messages.filter((m) => m.role === 'assistant')
  for (const m of assistants.slice(-5)) {
    const texts = (m.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
    const rendered = truncateTextTokens(stripSelfTalkPrefix(sanitize(texts)), 512).text
    for (const entity of collectEntities(rendered)) verbatim.add(entity)
  }
  const calls = []
  const resultSeqByCallId = new Map()
  dsh.forEach((message, index) => {
    if (message.role === 'user' && message.content[0]?.type === 'tool-result') {
      resultSeqByCallId.set(message.content[0].toolCallId, index + 1)
    }
  })
  dsh.forEach((message, index) => {
    if (message.role !== 'assistant') return
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.push({ seq: index + 1, id: block.id, name: block.name, arguments: block.arguments })
    }
  })
  const bases = calls.map((callRow) => renderedCallBase(callRow))
  for (const base of bases.slice(-5)) {
    if (base !== null) verbatim.add(base)
  }
  // pointed entities: the last calls whose rendered base differs from BOTH
  // neighbours — adjacent identical rows merge and lose their `-> result`
  // pointer, so only standalone rows make safe pointer assertions.
  const entities = []
  for (let i = calls.length - 1; i >= 0 && entities.length < 3; i--) {
    const base = bases[i]
    const prev = i > 0 ? bases[i - 1] : undefined
    const next = i < bases.length - 1 ? bases[i + 1] : undefined
    if (base === null || base === prev || base === next) continue
    const resultSeq = resultSeqByCallId.get(calls[i].id)
    if (resultSeq === undefined) continue
    entities.push({ tier: 'pointed', label: `result of real call ${calls[i].name} (call seq ${calls[i].seq})`, seq: resultSeq })
  }
  for (const needle of verbatim) entities.push({ tier: 'verbatim', label: 'real tail entity', needle })
  return {
    name: 'real-session',
    description: `real recorded pi session: ${messages.length} messages`,
    sourceFile: file,
    nodes,
    entities,
  }
}
