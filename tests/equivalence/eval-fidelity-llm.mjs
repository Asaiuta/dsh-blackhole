// LLM A/B fidelity probe: same factual questions answered with (A) the full
// message window vs (B) the instant compaction brief. Measures how much
// answer-relevant information compaction actually costs.
//
// Run: node tests/equivalence/eval-fidelity-llm.mjs [q1,q2,q3,q4,q5]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { compileInstantRegion, joinInstantEntries, DEFAULT_INSTANT_OPTIONS } from '../../lib/index.js'

// Credentials/base/model/session come from the environment; nothing
// machine-local is hardcoded in this file.
//   DSH_EVAL_KEY      API key (required)
//   DSH_EVAL_BASE     OpenAI-compatible base URL (required)
//   DSH_EVAL_MODEL    model id (default deepseek-v4-flash-free)
//   DSH_EVAL_SESSION  path to a pi session .jsonl (default: latest session
//                     under ~/.pi/agent/sessions/<cwd-slug>)
import { readdirSync } from 'node:fs'

const KEY = process.env.DSH_EVAL_KEY
const BASE = process.env.DSH_EVAL_BASE
const MODEL = process.env.DSH_EVAL_MODEL ?? 'deepseek-v4-flash-free'
if (!KEY || !BASE) {
  console.error('set DSH_EVAL_KEY and DSH_EVAL_BASE (OpenAI-compatible endpoint)')
  process.exit(2)
}

// Session discovery: the pi session dir for the current working directory
// (i.e. the --slug-- folder under ~/.pi/agent/sessions). Point DSH_EVAL_SESSION
// at any pi session .jsonl to evaluate a different transcript.
const sessionsRoot = join(homedir(), '.pi', 'agent', 'sessions')
const cwdSlugDir = readdirSync(sessionsRoot, { withFileTypes: true })
  .find((d) => d.isDirectory() && d.name.includes(basename(process.cwd())))?.name
if (!cwdSlugDir && !process.env.DSH_EVAL_SESSION) {
  console.error('no session dir matching cwd; set DSH_EVAL_SESSION to a pi session .jsonl')
  process.exit(2)
}

const file = process.env.DSH_EVAL_SESSION
  ?? join(sessionsRoot, cwdSlugDir ?? '', readdirSync(join(sessionsRoot, cwdSlugDir ?? '.')).filter((f) => f.endsWith('.jsonl')).sort().at(-1) ?? '')

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

// compact the FULL session once (this is the B context)
let callSeq = 0
const dsh = []
for (const m of messages) {
  if (m.role === 'user') {
    const blocks = m.content.filter((p) => p.type === 'text').map((p) => ({ type: 'text', text: p.text }))
    if (!blocks.length) blocks.push({ type: 'text', text: '' })
    dsh.push({ id: 'u' + dsh.length, role: 'user', source: { kind: 'user' }, content: blocks })
  } else if (m.role === 'assistant') {
    const blocks = m.content.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text }
      if (p.type === 'thinking') return { type: 'reasoning', text: p.thinking }
      if (p.type === 'toolCall') {
        callSeq++
        return { type: 'tool-call', id: p.id ?? 'c' + callSeq, name: p.name, arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}) }
      }
      return null
    }).filter(Boolean)
    if (blocks.length) dsh.push({ id: 'a' + dsh.length, role: 'assistant', source: { kind: 'model', provider: 'o', model: 'g' }, content: blocks })
  } else if (m.role === 'toolResult') {
    const tb = (m.content ?? []).filter((p) => p.type === 'text').map((p) => ({ type: 'text', text: p.text }))
    dsh.push({ id: 'r' + dsh.length, role: 'user', source: { kind: 'tool', callId: m.toolCallId }, content: [{ type: 'tool-result', toolCallId: m.toolCallId, isError: m.isError === true, content: tb }] })
  }
}
const compiled = compileInstantRegion(dsh.map((m, i) => ({ seq: i, message: m })), DEFAULT_INSTANT_OPTIONS, 100000)
const BRIEF = joinInstantEntries(compiled.entries)

// ── questions ──
const questions = [
  {
    q: '本机安装的 pi-blackhole 插件的版本号是什么?只回答版本号。',
    answer: 'v0.4.5',
    note: 'assistant 文本',
    loc: messages.findIndex((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('pi-blackhole v0.4.5')),
    win: 6,
  },
  {
    q: '会话中出现的第一个 ENOENT 错误试图访问的完整路径是什么?只回答路径。',
    answer: 'D:\\tmp\\dsh-instant\\package\\src\\index.js',
    note: '工具错误首行',
    loc: messages.findIndex((m) => m.role === 'toolResult' && m.isError === true && JSON.stringify(m.content).includes('ENOENT')),
    win: 6,
  },
  {
    q: '本仓库 instant 编译器的默认配置中 textTokens 的默认值是多少?只回答数字。',
    answer: '512',
    note: 'assistant 文本',
    loc: messages.findIndex((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('textTokens')),
    win: 6,
  },
  {
    q: "dsh-compaction-basic 的 frameSummary() 用哪一对标签包裹摘要内容?只回答标签名。",
    answer: '<compacted-summary>',
    note: 'assistant 文本',
    loc: messages.findIndex((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('<compacted-summary>')),
    win: 6,
  },
  {
    q: 'dsh-compaction-instant 0.1.3 解压后的 package/src 目录下有哪些文件?按出现的顺序列出文件名,逗号分隔。',
    answer: 'command.js, compiler.js, index.js, recall.js, region.js, search.js, tool.js',
    note: '仅存在于工具结果(目录列表)',
    loc: messages.findIndex((m) => m.role === 'toolResult' && JSON.stringify(m.content).includes('dsh-compaction-instant-0.1.3.tgz')),
    win: 12,
  },
]

// ── context builders ──
const msgToText = (m) => {
  if (m.role === 'user') return 'USER: ' + (m.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  if (m.role === 'assistant') {
    const parts = []
    for (const p of m.content ?? []) {
      if (p.type === 'text') parts.push('ASSISTANT: ' + p.text)
      else if (p.type === 'thinking') parts.push('THINKING: ' + p.thinking)
      else if (p.type === 'toolCall') parts.push('TOOL_CALL ' + p.name + ' ' + JSON.stringify(p.arguments ?? {}))
    }
    return parts.join('\n')
  }
  if (m.role === 'toolResult') {
    const t = (m.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
    return 'TOOL_RESULT' + (m.isError ? '(ERROR)' : '') + ': ' + t
  }
  return ''
}

const fullContext = (q) => {
  const [a, b] = [Math.max(0, q.loc - q.win), q.loc + q.win]
  return messages.slice(a, b + 1).map(msgToText).join('\n\n')
}

// ── API call with throttle + retry (free model rate-limits hard) ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const call = async (system, context, question) => {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: context + '\n\n---\n\n问题:' + question },
    ],
    max_tokens: 3000,
    temperature: 0.2,
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const j = await res.json()
        const msg = j.choices?.[0]?.message ?? {}
        return msg.content ?? msg.reasoning_content ?? '(empty)'
      }
      const txt = await res.text()
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 5) return `ERROR: ${res.status} ${txt.slice(0, 120)}`
        console.log(`    (rate-limited ${res.status}, retry ${attempt}/5 after 25s)`)
        await sleep(25000)
        continue
      }
      return `ERROR: ${res.status} ${txt.slice(0, 200)}`
    } catch (e) {
      if (attempt >= 5) return 'ERROR: ' + e.message.slice(0, 150)
      await sleep(20000)
    }
  }
}

const SYSTEM_A = '你是事实提取器。只根据提供的会话内容回答,不允许编造。答案要精确。'
const SYSTEM_B = '你是事实提取器。内容是一份压缩摘要(compaction brief)。只根据摘要中确实存在的信息回答;如果摘要里没有,明确说"摘要中无此信息"。不允许编造或推测。'

// ── run ──
const runList = process.argv[2] ? process.argv[2].split(',').map(Number) : [1, 2, 3, 4, 5]
const OUT = 'tests/equivalence/.eval-out.json'
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : questions.map(() => ({}))
for (const qi of runList) {
  const q = questions[qi - 1]
  const ctxA = fullContext(q)
  console.log(`Q${qi} [${q.note}] loc=${q.loc} fullCtx=${ctxA.length} chars`)
  const a = await call(SYSTEM_A, ctxA, q.q)
  console.log('  A(full) :', a.replace(/\n/g, ' ').slice(0, 200))
  await sleep(8000)
  const b = await call(SYSTEM_B, BRIEF, q.q)
  console.log('  B(brief):', b.replace(/\n/g, ' ').slice(0, 200))
  results[qi - 1] = { question: q.q, expected: q.answer, note: q.note, full: a, brief: b }
  await sleep(8000)
  console.log('')
}
writeFileSync(OUT, JSON.stringify(results, null, 2))
console.log('saved →', OUT)