# dsh-blackhole

[English](README.md) | **简体中文**

[`k0valik/pi-blackhole`](https://github.com/k0valik/pi-blackhole) 的 **DeepSeek Harness(DSH)移植版** — 移植了 pi-blackhole 的 brief 编译器(VCC 会话压缩编译器),并封装进一个双管线压缩引擎。

是官方 `@deepseek-ai/dsh-compaction-basic` 后端的即插即用替代品,在唯一的 `summarize()` 钩子内部做路由:

- **OpenAI(或任何配置了 Responses endpoint 的 provider)** — 官方远程路径:通过 Responses API 的 `compaction_trigger` 把摘要委托给**模型服务器**(与 Codex 远程压缩同一协议),每次会话持久化不透明的替换历史;
- **远程失败**(无 endpoint、缺 key、超时、协议错误)— 默认由**确定性 VCC 风格本地编译器**编译该区域(零模型调用,`(seq N)` 指针近似无损地指回持久会话日志),也可通过 `fallbackMode: "llm"` 使用原生一次性 LLM 摘要器;
- **其他所有 provider** — 直接走本地编译器,零网络。

远程压缩分支移植自
[`algal/pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)
(MIT)。本地编译器是 **pi-blackhole `brief.ts` 编译器的移植**(VCC 会话压缩编译器,MIT;规则谱系:lllyasviel/VCC → dsh-compaction-instant)——差分测试套件将内容级等价性钉死在真实 pi-blackhole 源码上(见下文 *Equivalence*)。

## 为什么

| | pi | DSH(本插件) |
|---|---|---|
| 远程压缩 v2 | 经 algal/kky42/lll9p 扩展 | 路由引擎的 **remote 分支** |
| 零成本本地压缩 | pi-vcc / pi-blackhole(算法式) | **本地编译器分支**(`fallbackMode: "instant"`) |
| 压缩接缝 | 扩展事件钩子 | `CompactionEngine.summarize()` — 官方唯一自定义钩子 |
| 回退链 | — | instant →(可选)原生 LLM → 失败 |
| 不透明窗口持久化 | pi 会话 JSONL `compaction.details.remoteCompaction` | `$DSH_HOME/plugins/dsh-blackhole/state` 下的逐会话 JSON 状态 |

## 工作原理

1. DSH 决定压缩(压力 / 溢出 / `/compact`)并以重放的会话区域调用引擎的 `summarize()` 钩子。
2. 解析路由的 provider/model(先持久请求头,再 agent options),与配置的 `endpoints` 匹配。
3. **远程分支**(endpoint 匹配):区域转换为 Responses 输入项(text、reasoning、tool calls/results),追加 `compaction_trigger`,压缩响应从 `{baseUrl}/responses` 流式返回。助手撰写的摘要成为可读 checkpoint;不透明的 `compaction` 项加上保留的 user 消息尾部(Codex 风格 20K token 预算)按会话持久化。同一 provider/model 的后续远程压缩会重放该不透明窗口,只追加新的尾部表面。
4. **回退**:任何远程失败都会记录警告,并把区域交给本地编译器(`instant`,默认)或原生 LLM 摘要器(`llm`)。`instant-then-llm` 先试编译器,仅当编译器自身失败才用 LLM。
5. **本地编译器分支**(无 endpoint 匹配,或回退):对区域做确定性零模型遍历,**只保留原始 token**——每个工具调用变成一行 `* bash "ls" (seq 2 -> result 3)`,工具结果从不占用条目(通过指针一次 recall 即得),推理被省略,长文本以 `...(truncated from seq N)` 截断,噪声 XML 被剥离,token 上限优先丢弃最老行并给出显式 `[N entries elided: seqs a-b]` 说明。`(seq N)` 指针解析到**真实持久会话日志**(每条压平消息按 id 匹配存储事件),因此挂在本引擎旁的 recall 工具能还原精确原始内容。

引擎继承官方 `BasicCompactionEngine`,所有压力 / 保留 / 策略旋钮、token 计费定价、上下文溢出恢复都与上游完全一致。

## 安装

需要 DSH `0.1.0-rc.6`(web 或 headless profile)。

```bash
# 安装到服务你会话的 profile
dsh plugin --profile web add dsh-blackhole
# 或从本地 tarball:
npm pack dsh-blackhole && dsh plugin --profile web add ./dsh-blackhole-0.2.0.tgz
```

Bundle 补丁:

- 禁用官方 `compaction-basic` 行(web-app bundle 已禁用 — 幂等),
- 重新启用 `command-compact`(`/compact` 命令,web-app bundle 禁用了它;与后端无关),
- 在本引擎自己的行下插入。

最终只挂载一个 `compaction` 服务;双管线在引擎内部。

## 配置

在 profile 的设置中(或 `~/.dsh/settings.yaml` 的插件 key 下):

```yaml
dsh-blackhole:
  # 继承的 BasicCompactionEngine 旋钮(全部可选,默认值与
  # @deepseek-ai/dsh-compaction-basic 相同):
  thresholdRatio: 0.75
  retainRatio: 0.25
  auto: true

  # Responses 辅助旋钮:
  endpoints:
    # 直连 OpenAI Responses
    - provider: openai
      baseUrl: https://api.openai.com/v1
      apiKeyEnv: OPENAI_API_KEY
    # 任何转发 Responses API 的 OpenAI 兼容网关
    - provider: '*'
      baseUrl: https://my-gateway.example.com/v1
      apiKeyEnv: MY_GATEWAY_KEY
    # 官方 Codex 后端(需要 beta-feature 头)
    - provider: openai-codex
      baseUrl: https://chatgpt.com/backend-api
      apiKeyEnv: CODEX_TOKEN
      headers:
        OpenAI-Beta: responses=experimental
        x-codex-beta-features: remote_compaction_v2
  timeoutMs: 120000      # 2 分钟后中止远程尝试
  fallbackMode: instant  # instant | instant-then-llm | llm
  retainedMessageTokenBudget: 20000
  persistRemoteHistory: true
  stateDir: ~/.dsh/plugins/dsh-blackhole/state

  # 本地编译器旋钮(全部可选):
  compileMaxTokens: 8192     # 下限;在大区域按 checkpointScale 放大
  checkpointScale: 0.1       # 上限 = max(compileMaxTokens, 影子区域 x scale)
  checkpointCap: 65536       # 硬顶
  textTokens: 512            # 每条 assistant text/reasoning block
  userTextTokens: 1024       # 每条 user text block
  toolCallTokens: 128        # 每条工具单行
  includeReasoning: false
  stripNoiseXml: true
  noisePatterns: []          # 空 = 内置 VCC 模式
  toolArgTools: []           # 空 = 内置白名单
  hideTools: []              # 例如 [TodoWrite, ToolSearch]
```

Endpoint 匹配:`provider` 匹配最近一次请求运行的 DSH provider 路由(精确,或 `*` 任意);`model` 匹配精确 id 或 `*` glob。鉴权使用 `apiKeyEnv`(环境变量名)或 `apiKey`(内联 — 切勿提交真实 key)。

`fallbackMode` 语义(仅适用于远程失败):

| 模式 | 远程成功 | 远程失败 |
|---|---|---|
| `instant`(默认) | 服务器摘要 | 本地编译器(零模型调用) |
| `instant-then-llm` | 服务器摘要 | 本地编译器;仅当编译器本身失败才用 LLM |
| `llm` | 服务器摘要 | 原生一次性 LLM 摘要器 |

遗留的 `fallbackToLlm` 布尔值仍映射:`false` 强制 `instant`;`true` 与默认行为一致。**无匹配 endpoint** 的目标总是走本地编译器(或 `llm` 模式下的原生 LLM)。

## 行为说明

- **图片**:DSH 把图片字节存在 attachment store 中,远程压缩调用无法解析;图片块以显式 "image content omitted" 文本访问代替静默丢弃。本地编译器将其渲染为 `[image] (seq N)` 标签。
- **Checkpoint 框架**:引擎返回纯文本;继承的后端用标准 `<compacted-summary>` checkpoint 框架包裹。
- **带 agent presets 的部署**:presets 挂载自己的压缩域。如果 preset 也压缩,要么在某一侧禁用 `auto`,要么删掉 preset 的压缩行 — 两个引擎不得压缩同一会话。
- **普通轮的 opaque 重放仍归 adapter 所有**:DSH 不可变的 `llm/stream` 请求没有消息重写钩子。因此本包提供可选的 `responsesCompactionReplay` 服务。Responses adapter 应在构建 HTTP payload **之前**调用 `prepareInput({ sessionId, provider, model, trailingMessages, endpoint })`;它返回 `[自有 opaque 替换历史, ...trailingMessages]`(含正在发送的请求的最后一个未完成 user/tool 轮),若没有自有 artifact 则返回所提供 DSH 消息的可移植转换。`replayHistory(...)` 仍可用于压缩侧变体,它刻意只保留已完成的尾部轮。外来 provider/model 状态、遗留 artifact、endpoint 不匹配与回退压缩都会被拒绝或移除,而不是重放。Responses 压缩路径在下一次压缩时自动使用已完成轮契约。

### Adapter 接线契约(`responsesCompactionReplay`)

接缝是 adapter 内序列化普通 Responses 请求时的一次方法调用。`tests/protocol-smoke.mjs` 把整个矩阵钉为可执行断言;adapter 需要实现的形状如下:

```ts
// 在 Responses adapter 内部:
const replay = ctx.get('responsesCompactionReplay') as
  import('dsh-blackhole').ResponsesCompactionReplay | undefined

// 在为 NON-compaction 轮构建 HTTP payload 之前立即调用:
const input = replay === undefined
  ? dshMessagesToResponseItems(trailing)
  : await replay.prepareInput({
      sessionId,            // agent/session id(opaque 窗口以它为 key)
      provider,             // 持久路由:例如 'openai'
      model,                // 持久模型:例如 'gpt-5'
      trailingMessages: trailing, // 本轮要发送的 DSH Messages
      endpoint,             // 可选;已知时传入 base URL
    })
// builder.send({ model, input, stream: true, store: false, ... })
```

契约语义(全部由 `RemoteCompactionStateStore` 强制):

- **自有 artifact**(同一 provider/model/endpoint,带版本 `details`):返回 `[opaque 替换项, ...`trailingMessages` 的输入项]`,保留最后一个未完成 user/tool 轮(`includePending`),以免丢失正在发送的请求。
- **无状态 / 外来路由 / 遗留 artifact / endpoint 不匹配**:返回普通 DSH→Responses 转换(故障关闭 — 绝不返回陈旧 opaque 窗口)。`replayHistory()` 在恰好这些情况下返回 `undefined`。
- **压缩轮**:不要以压缩意图调用 `prepareInput()` — `RoutingCompactionEngine` 在摘要时已在内部重放已完成轮窗口。该服务只服务于普通对话轮。
- **回退压缩**会使存储窗口失效(`state.remove`),因此后续同路由轮从 DSH 消息开始,不会跳过新的本地 checkpoint。
- **纯文本区域**的压缩率低于工具密集区域(工具结果在编译视图中零 token);编译器无法缩小的区域会故障关闭地拒绝,与上游 instant 引擎的 shrink 保证完全一致。

## 开发

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit(针对 rc.6 包)
pnpm run build       # esbuild → lib/index.js
node tests/smoke-load.mjs      # loader 组合挂载引擎
node tests/protocol-smoke.mjs  # 转换/SSE/回环(本地 fake endpoint)
node tests/hybrid-smoke.mjs    # 编译器单元 + 路由(remote/instant/llm/compat)
node tests/equivalence/build-algal.mjs && node tests/equivalence/differential.mjs
                               # 与真实上游 bundle 的协议等价
node tests/equivalence/build-blackhole.mjs && node tests/equivalence/differential-brief.mjs
                               # 与真实 pi-blackhole brief 编译器的内容级差分
                               # (BRIEF-DIFF.md: 11/12 向量对齐)
node tests/instant-blackhole-align.mjs
                               # 钉齐 brief 规则的回归套件
node tests/equivalence/differential-real-session.mjs
                               # 在真实 pi 会话记录上的内容差分
                               # (直播转录,非合成向量)
node tests/equivalence/entity-fidelity.mjs
                               # 实体级保留审计(路径/符号/错误)
DSH_EVAL_KEY=... DSH_EVAL_BASE=... node tests/equivalence/eval-fidelity-llm.mjs
                               # LLM A/B:完整 vs brief 上下文的回答准确性
                               # (见 FIDELITY.md;key/base/model/session 走环境变量)
```

## 与上游移植的等价性

`tests/equivalence/` 在固定 commit 快照上游源码(`algal/SOURCE.json`),并 stub pi 依赖后打包(只替换计算辅助函数;协议代码原样运行)。随后差分测试向两个实现喂相同向量:请求体、替换历史(保留、20K 截断、图片豁免、空消息过滤)、SSE 解析(成功 + 每条错误路径)、消息转换(pi↔DSH 语义投影)、身份头,以及一次完整的本地 endpoint 回环。**15/15 向量通过。**

剩余差异属于平台适配,而非协议漂移:

- **资格检测**:上游从 pi-ai 注册表自动检测直连 OpenAI / Codex 模型(host 必须是 `api.openai.com`);本移植匹配声明的 `endpoints`(provider + model glob),因此也能指向你自己的网关。上游的 host 门禁恰会拒绝本插件面向的部署。
- **Checkpoint 文本来源**:上游并行运行本地摘要并把远程 artifact 存进 `details.remoteCompaction`(pi 有该槽位);DSH 的 `summarize()` 只返回一个文本,因此本移植把服务器侧摘要文本作为 checkpoint,并按 `fallbackMode` 回退。至多一次 LLM 调用 — 默认零次。
- **图片**:pi 携带图片字节(→ `input_image`);DSH 只有 attachment id,因此图片访问变成显式占位文本。
- **暴露的旋钮**:`retainedMessageTokenBudget`(上游固定 20K)、`timeoutMs`、`sendIdentityHeaders`、`installationId` 是额外选项;默认值精确复现上游行为。

## 许可

MIT。部分衍生自
[algal/pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction)
(MIT)与
[`dsh-compaction-instant`](https://github.com/KitDoesIt/dsh-compaction-instant)
的编译器规则(MIT,VCC 会话压缩编译器移植)— 见 LICENSE。