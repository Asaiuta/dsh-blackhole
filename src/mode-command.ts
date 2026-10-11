/**
 * Optional DSH human-command adapter for runtime compaction-mode switching.
 *
 * `/blackhole-mode` flips the routing engine's runtime state — the fallback
 * chain and the remote Responses gate — and persists the switch as a small
 * JSON file in the plugin's own state dir, so it survives DSH restarts.
 * `/blackhole-mode reset` clears the override and returns to the config
 * defaults. The durable default still lives in the profile config
 * (`fallbackMode` / `endpoints`); the override file only carries the deltas
 * the user applied at runtime, and plugins never write the host's profile
 * YAML.
 *
 * All human-facing strings are Simplified Chinese to match the desktop UI;
 * mode tokens (`instant` / `llm` / `remote` …) stay as literal command
 * syntax. Model-facing strings elsewhere (tool descriptions, checkpoint
 * content) remain English.
 *
 * @module dsh-blackhole/mode-command
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompactionFallbackMode } from './config.ts'

/** Runtime mutability seam over the routing engine's switchable state. */
export interface BlackholeModeController {
  /** Current fallback chain mode. */
  getFallbackMode(): CompactionFallbackMode
  /** Fallback chain mode resolved from the plugin config (no override). */
  getFallbackModeDefault(): CompactionFallbackMode
  setFallbackMode(mode: CompactionFallbackMode): void
  /** Whether remote Responses compaction attempts are currently enabled. */
  isRemoteEnabled(): boolean
  /** Remote gate resolved from the plugin config (no override). */
  isRemoteEnabledDefault(): boolean
  setRemoteEnabled(enabled: boolean): void
  /** Drop the persisted override and restore the config defaults. */
  resetRuntimeMode(): void
  /** One-line summary of the configured remote endpoints. */
  describeEndpoints(): string
}

export type ModeCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export interface ModeCommandInvocation {
  readonly rawInput: string
}

export interface ModeCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: ModeCommandInvocation) => ModeCommandResult | Promise<ModeCommandResult>
}

/** Structural shape of the optional dsh-commands service for this command. */
export interface ModeCommandRegistry {
  register: (definition: ModeCommandDefinition) => (() => void) | void
}

export const MODE_COMMAND_NAME = 'blackhole-mode'

const FALLBACK_MODES: readonly CompactionFallbackMode[] = ['instant', 'instant-then-llm', 'llm']

const MODE_DESCRIPTIONS: Readonly<Record<CompactionFallbackMode, string>> = {
  instant: '本地确定性 VCC 编译器（零模型调用，(seq N) 回读指针）',
  'instant-then-llm': '先本地编译，仅当编译器也失败时改用原生 LLM 摘要',
  llm: '原生单次 LLM 摘要（官方 dsh-compaction-basic 行为）',
}

const USAGE = '用法：[instant | instant-then-llm | llm | remote [on | off] | reset]'

export type ModeCommandAction =
  | { readonly action: 'status' }
  | { readonly action: 'mode'; readonly mode: CompactionFallbackMode }
  | { readonly action: 'remote'; readonly enabled?: boolean }
  | { readonly action: 'reset' }
  | { readonly action: 'invalid'; readonly message: string }

/** Parse `/blackhole-mode`'s free-form argument. */
export function parseModeCommandInput(rawInput: string): ModeCommandAction {
  const input = rawInput.trim().toLowerCase()
  if (input.length === 0) return { action: 'status' }
  if ((FALLBACK_MODES as readonly string[]).includes(input)) {
    return { action: 'mode', mode: input as CompactionFallbackMode }
  }
  if (input === 'reset') return { action: 'reset' }
  if (input === 'remote' || input.startsWith('remote ')) {
    const argument = input.slice('remote'.length).trim()
    if (argument.length === 0) return { action: 'remote' }
    if (argument === 'on') return { action: 'remote', enabled: true }
    if (argument === 'off') return { action: 'remote', enabled: false }
    return {
      action: 'invalid',
      message: `"remote ${argument}" 不是合法取值；请用 "remote on" 或 "remote off"`,
    }
  }
  return {
    action: 'invalid',
    message: `未知模式 ${JSON.stringify(rawInput.trim())}；${USAGE}`,
  }
}

// ── sticky runtime override (persisted beside the remote-history state) ────

/** The persisted runtime switch deltas. */
export interface RuntimeModeOverride {
  fallbackMode?: CompactionFallbackMode
  remoteEnabled?: boolean
  savedAt?: string
}

/** File name of the persisted override inside the plugin state dir. */
export const RUNTIME_MODE_FILE = 'runtime-mode.json'

/** Absolute path of the persisted override inside `dir`. */
export function runtimeModeFilePath(dir: string): string {
  return join(dir, RUNTIME_MODE_FILE)
}

/**
 * Read the persisted override; a missing or unreadable file, or a file with
 * no valid fields (corrupt, wrong types), yields `undefined` so a broken
 * artifact can never wedge the engine.
 */
export function loadRuntimeModeOverride(dir: string | undefined): RuntimeModeOverride | undefined {
  if (dir === undefined || dir.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(runtimeModeFilePath(dir), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const override: RuntimeModeOverride = {}
  const mode = record.fallbackMode
  if (typeof mode === 'string' && (FALLBACK_MODES as readonly string[]).includes(mode)) {
    override.fallbackMode = mode as CompactionFallbackMode
  }
  if (typeof record.remoteEnabled === 'boolean') override.remoteEnabled = record.remoteEnabled
  if (typeof record.savedAt === 'string') override.savedAt = record.savedAt
  return override.fallbackMode === undefined && override.remoteEnabled === undefined
    ? undefined
    : override
}

/** Persist the override best-effort; `false` means the caller should warn. */
export function saveRuntimeModeOverride(dir: string | undefined, override: RuntimeModeOverride): boolean {
  if (dir === undefined || dir.length === 0) return false
  try {
    // The state tree does not exist until the first remote compaction or the
    // first runtime switch — create it instead of failing the very first
    // `/blackhole-mode` write with ENOENT.
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      runtimeModeFilePath(dir),
      `${JSON.stringify({ savedAt: new Date().toISOString(), ...override }, null, 2)}\n`,
    )
    return true
  } catch {
    return false
  }
}

/** Remove the persisted override; `false` means the caller should warn. */
export function clearRuntimeModeOverride(dir: string | undefined): boolean {
  if (dir === undefined || dir.length === 0) return false
  try {
    rmSync(runtimeModeFilePath(dir), { force: true })
    return true
  } catch {
    return false
  }
}

function statusText(controller: BlackholeModeController): string {
  const mode = controller.getFallbackMode()
  const remote = controller.isRemoteEnabled() ? '已启用' : '已禁用'
  const modeOverride = mode !== controller.getFallbackModeDefault()
    ? `（运行时覆盖；配置默认：${controller.getFallbackModeDefault()}）`
    : ''
  const remoteOverride = controller.isRemoteEnabled() !== controller.isRemoteEnabledDefault()
    ? `（运行时覆盖；配置默认：${controller.isRemoteEnabledDefault() ? '已启用' : '已禁用'}）`
    : ''
  return [
    `回退链：${mode} — ${MODE_DESCRIPTIONS[mode]}${modeOverride}`,
    `远端 Responses 压缩：${remote}${remoteOverride}（${controller.describeEndpoints()}）`,
    `切换对本 DSH 主目录持久生效；/blackhole-mode reset 恢复配置默认。${USAGE}`,
  ].join('\n')
}

/** Build the optional user-facing command definition. */
export function createModeCommand(controller: BlackholeModeController): ModeCommandDefinition {
  return {
    name: MODE_COMMAND_NAME,
    description: '查看或切换 dsh-blackhole 的压缩管线（运行时生效）。',
    input: { hint: '[instant | instant-then-llm | llm | remote [on | off] | reset]' },
    handler: (invocation) => {
      const parsed = parseModeCommandInput(invocation.rawInput)
      switch (parsed.action) {
        case 'status':
          return { kind: 'success', text: statusText(controller) }
        case 'mode': {
          controller.setFallbackMode(parsed.mode)
          return {
            kind: 'success',
            text: `回退链已切换为 ${parsed.mode} — ${MODE_DESCRIPTIONS[parsed.mode]}；覆盖跨 DSH 重启保留（/blackhole-mode reset 清除）。`,
          }
        }
        case 'remote': {
          if (parsed.enabled === undefined) {
            return {
              kind: 'success',
              text: `远端 Responses 压缩当前${controller.isRemoteEnabled() ? '已启用' : '已禁用'}（${controller.describeEndpoints()}）。`,
            }
          }
          controller.setRemoteEnabled(parsed.enabled)
          return {
            kind: 'success',
            text: parsed.enabled
              ? `远端 Responses 压缩已重新启用（${controller.describeEndpoints()}）；匹配的目标先走远端，失败后落到${controller.getFallbackMode()}回退。`
              : `远端 Responses 压缩已禁用；所有目标改用${controller.getFallbackMode()}回退，直到重新启用。切换跨 DSH 重启保留；本地检查点落盘时会清除已持久化的远端替换历史。`,
          }
        }
        case 'reset': {
          controller.resetRuntimeMode()
          return {
            kind: 'success',
            text: `运行时覆盖已清除；回到配置默认（回退链：${controller.getFallbackMode()}，远端 Responses 压缩${controller.isRemoteEnabled() ? '已启用' : '已禁用'}）。`,
          }
        }
        default:
          return { kind: 'error', text: parsed.message }
      }
    },
  }
}

/** Register the command if a DSH command service is present. */
export function registerModeCommand(
  registry: ModeCommandRegistry,
  controller: BlackholeModeController,
): (() => void) | void {
  return registry.register(createModeCommand(controller))
}
