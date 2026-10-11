# OM（Observational Memory）架构调研报告

> 状态：调研完成，OM 联动仍为 TODO。本报告不表示当前 `dsh-blackhole` 已实现 OM。
>
> 一句话结论：OM 是“分支本地、追加式、带来源证据的主动记忆账本”；VCC 负责压缩会话结构，OM 负责保存长期语义事实，`recall` 负责从压缩后的记忆回到原始证据。当前项目已具备 VCC 风格压缩和 transcript/file recall，但缺少 OM ledger、三个后台 worker、OM projection，以及 OM ID 的双向召回，因此尚不等价于完整的 `pi-blackhole`。

## 1. 调研范围

本报告固定以下对照版本，避免把不同时间点的实现混为一谈：

| 对象 | 对照版本 | 用途 |
|---|---|---|
| 当前项目 | `dsh-blackhole 0.2.0` 当前工作区 | 判断已有能力和缺口 |
| `pi-blackhole` | tag `v0.4.6`，commit `49ab560156fd53b6da1b568d5ade10287b89026c` | 判断用户要求的黑洞集成效果 |
| 独立 OM | `elpapi42/pi-observational-memory` `master`，commit `37986b6faa1e39eb5aa1d03a4ca6379ecaf3148d` | 判断 V3 概念和最新生命周期 |
| DSH session | `@deepseek-ai/dsh-session 0.1.0-rc.6` | 判断 ledger 如何持久化 |

版本差异需要特别注意：`pi-blackhole v0.4.6` 的主动压缩仍从 `agent_end` 触发，并另有 `turn_end` 中途压缩；独立 OM 当前版已经改用 Pi 0.81.0 的 `agent_settled`。二者的数据模型和 ledger 原理一致，但生命周期不能逐行照抄。

## 2. 先回答核心问题

| 问题 | 结论 |
|---|---|
| OM 的作用是什么？ | 在会话进行过程中主动提取事实和长期结论，避免这些信息在多轮 compaction 中被“摘要的摘要”逐步磨损。 |
| OM 是向量数据库或语义搜索吗？ | 不是。V3 的核心是当前 branch 上的 append-only ledger、确定性 fold 和精确 ID provenance。 |
| OM 和 VCC 是一回事吗？ | 不是。VCC 压缩 transcript 的结构与近期工作；OM 保存跨压缩仍应成立的事实。两者互补。 |
| OM 和 recall 是一回事吗？ | 不是。OM 生产、维护记忆；recall 消费记忆 ID 或 transcript 索引，恢复原始上下文。 |
| 当前插件能达到 `pi-blackhole` 的 recall 效果吗？ | transcript、文件和 `#N` 部分已接近；12 位 OM ID、OM 到 source、`#N` 到 related memory 尚未实现。 |
| 技术上能补齐吗？ | 能，但必须先解决 DSH plugin event 的持久化契约，或实现具备 fork/原子性语义的 sidecar ledger。 |

## 3. OM 解决的问题

普通 compaction 容易形成递归有损链：

~~~text
原始对话
  -> 第一次摘要
  -> 摘要 + 新消息的第二次摘要
  -> 摘要的摘要 + 新消息的第三次摘要
~~~

决定的原因、用户纠正、完成状态、硬约束和精确标识符会越来越短，最后只剩模糊结论。OM 改变了信息路径：

1. 原始事件仍保留在 append-only session log。
2. Observer 在后台把重要事件提炼为 observation，并记录原始 entry ID。
3. Reflector 从 observations 中提炼较稳定的 reflection，并记录支撑 observation ID。
4. Dropper 只从“活跃投影”中移除过期或已被 reflection 安全覆盖的 observation，不删除历史证据。
5. Compaction 只 fold ledger 并渲染当前投影，不在关键路径重新总结全会话。
6. Agent 对某条压缩记忆没有把握时，用 memory ID 精确回到原始证据。

这使长期记忆不再完全依赖上一轮摘要文本。

## 4. 总体架构

~~~mermaid
flowchart LR
  subgraph source["Branch-local session"]
    events["Raw source entries"]
    ledger[("Append-only OM ledger")]
  end

  subgraph workers["Background memory preparation"]
    turn["turn_end<br/>token gates"]
    observer["Observer / LLM"]
    reflector["Reflector / LLM"]
    dropper["Dropper / LLM"]
  end

  subgraph compact["Single compaction seam"]
    trigger["Compaction trigger<br/>agent_end in blackhole 0.4.6<br/>agent_settled in current OM"]
    vcc["VCC compile"]
    fold["Deterministic ledger fold"]
    render["OM projection render"]
    join["One replacement summary"]
  end

  subgraph recovery["Evidence recovery"]
    recall["recall"]
    sourceView["Original entries and files"]
  end

  events --> turn --> observer --> ledger
  ledger --> reflector --> ledger
  ledger --> dropper --> ledger
  events --> vcc --> join
  trigger --> vcc
  trigger --> fold
  ledger --> fold --> render --> join
  recall --> ledger
  ledger -- provenance --> events
  recall --> events --> sourceView
~~~

图中的关键性质是：LLM 工作发生在后台 worker；真正的 compaction 路径是确定性的。这样即使 memory worker 暂时失败，压缩操作本身也不应被一个额外模型调用拖慢。

## 5. 数据模型

### 5.1 Observation

~~~ts
type Observation = {
  id: string
  content: string
  timestamp: string
  relevance: "low" | "medium" | "high" | "critical"
  sourceEntryIds: string[]
  tokenCount: number
}
~~~

- `content` 是单行事实，不是任意一段总结。
- `sourceEntryIds` 是 provenance，必须来自 worker 实际看到的 source entries。
- `relevance` 是保留阻力，不是永久 pin；`critical` 在有充分 reflection 覆盖、已被新事实取代或明显冗余时仍可能离开活跃池。
- `id` 为 `sha256(content).slice(0, 12)`，即 48-bit 十六进制内容 ID。实现必须处理碰撞，不能把它当数据库唯一键盲目信任。

### 5.2 Reflection

~~~ts
type Reflection = {
  id: string
  content: string
  supportingObservationIds: string[]
  tokenCount: number
}
~~~

Reflection 是跨 compaction 仍有价值的稳定结论，例如：

- 用户偏好和明确纠正；
- 项目技术栈、架构决定和理由；
- 硬约束、长期目标和不可重复的完成结果；
- 持续存在的 blocker 或风险。

`supportingObservationIds` 同时承担证据链和 dropper 安全判断。错误地扩大 support 集合，会让 dropper 误以为原 observation 已被完整保存。

### 5.3 Ledger entries

~~~ts
type OmLedgerEvent =
  | {
      type: "om.observations.recorded"
      data: { observations: Observation[]; coversUpToId: string }
    }
  | {
      type: "om.reflections.recorded"
      data: { reflections: Reflection[]; coversUpToId: string }
    }
  | {
      type: "om.observations.dropped"
      data: { observationIds: string[]; coversUpToId: string }
    }
~~~

`coversUpToId` 只是 worker 的进度水位，不是来源关系。来源关系只存在于 `sourceEntryIds` 和 `supportingObservationIds`。

### 5.4 Folded projection

Compaction entry 中的 `om.folded` 只是 agent 当时看见的投影：

~~~ts
type MemoryDetails = {
  type: "om.folded"
  version: 1
  fullFold: boolean
  observations: Observation[]
  reflections: Reflection[]
}
~~~

Ledger 才是 source of truth。投影可落后于 ledger，因为最新一次 compaction 后，后台 worker 仍可能继续追加 memory events。

## 6. 三个后台 worker

| Worker | 输入 | 输出 | 关键校验 |
|---|---|---|---|
| Observer | 尚未覆盖的原始 source entries、已有 observations/reflections | 非空 observation batch | 过滤模型幻觉的 source ID；单行内容；去重；空结果不写 ledger batch |
| Reflector | 活跃 observations、已有 reflections、覆盖提示 | 新 reflection batch | 每个 supporting ID 必须来自允许的 observation 集合；重复 content hash 不再写入 |
| Dropper | 活跃 observations、reflection 覆盖、池压力 | observation ID tombstones | 只能选择存在的 active ID；综合年龄、相关度、覆盖、替代和冗余；可少删或不删 |

### 6.1 Observer

Observer 根据 `observeAfterTokens` 判断是否 due，按 oldest-first 读取未覆盖 source entries。模型必须通过 `record_observations` 工具提交结构化记录。

实现不会信任模型给出的 ID：它把 `sourceEntryIds` 与本次 chunk 的 allow-list 交叉验证；完全无有效来源的 observation 被拒绝。没有值得记录的内容时不写空 ledger entry，因此不会伪造 durable coverage。调度器可以记录一次 empty cursor，避免在下一个事件立即重复调用，但 ledger 水位本身没有前移。

### 6.2 Reflector

Reflector 的目标不是“把每条 observation 改写一遍”，而是减少未来 compaction 仍需携带的短期事件数量。它只保存更稳定的结论，并通过 `record_reflections` 提交。

`pi-blackhole v0.4.6` 对 supporting IDs 采用严格校验：只要 proposal 引用了 allow-list 外 ID，该 reflection 就不应写入。这样至少保证 provenance 图的结构真实；它不能保证模型对证据语义的解释一定正确。

### 6.3 Dropper

Dropper 在同轮 reflector 成功产生 reflection、且 active observation pool 超过目标时运行。删除动作是 tombstone：

~~~text
active projection:  observation 存在 -> drop event -> observation 不再活跃
ledger history:      observation 始终存在 -> 仍可用 memory ID recall
~~~

Fold 时采用 first-valid-record-wins，并累计所有 drop IDs。未知、旧版或无效 ledger records 被忽略。Dropper 因此不能篡改旧 observation，只能改变其 active 状态。

### 6.4 运行时保护

完整实现还包含以下工程保护，不应在 DSH 移植时省略：

- consolidation single-flight，避免同一 session 并发跑多套 worker；
- 每阶段独立 cursor 和 due gate；
- worker model、fallback model、session model 的有序回退；
- 模型失败 cooldown 和短期 retry gate；
- fork/session 切换后重新校验 cursor 是否仍位于当前 branch；
- worker 失败不阻塞 compaction；
- manual mode 下仍需可恢复的 pending state。

## 7. Ledger、projection 与 compaction

### 7.1 Fold 规则

从 branch root 到指定边界顺序扫描：

1. observation/reflection 以第一个合法同 ID 记录为准；
2. drop 作为永久 tombstone 累积；
3. `activeObservations = observations - droppedIds`；
4. 非 OM custom events、旧 V2 结构和无效 payload 不参与 fold；
5. 原始 observation 和 source entries 不因 projection 裁剪而删除。

### 7.2 Visible、full 与 drift

- Visible memory：最近一次 compaction 实际注入给 agent 的 projection。
- Full memory：当前 branch tip 上完整 fold 的 ledger truth。
- Drift：两者差异，表示 compaction 后新增或维护过但尚未重新注入的内容。

正常 projection 可以只把 observation 折到当前 cut，而 reflection/drop maintenance 延续最近一次 full-fold 边界；当 observation token pool 达到上限时才做 full fold。输出超过预算时，按 relevance tier 优先、再结合 recency 选择 observation；未入选内容仍留在 ledger。

### 7.3 为什么 compaction 是 model-free

Compaction 时只执行：

~~~text
load branch entries
  -> validate and fold ledger
  -> select projection under token budget
  -> render deterministic Markdown
  -> append to compaction replacement
~~~

独立 OM 当前版在 projection 为空时不返回 extension compaction，而让 Pi 原生 summarizer 保住旧上下文。`pi-blackhole v0.4.6` 不存在“只有空 OM summary”的同一失败模式，因为它先生成 VCC summary，再追加 OM 内容。

## 8. OM 如何与 VCC 联动

`pi-blackhole v0.4.6` 没有注册两个互相竞争的 compaction engine。二者在同一个 `session_before_compact` hook 汇合：

~~~ts
const vccSummary = compile({ messages, previousSummary, fileOps })
const projection = buildCompactionProjection(branchEntries, firstKeptEntryId, config)
const omSummary = renderSummary(projection.reflections, projection.observations)

return {
  compaction: {
    summary: vccSummary + "\n\n" + omSummary,
    details: { ...vccDetails, "om.folded": projection.details },
    firstKeptEntryId,
    tokensBefore,
  },
}
~~~

VCC 先从上一轮 summary 移除旧的 `## Reflections`、`## Observations` 和 recall footer，再合并自己的结构化 section，最后附加当前 ledger 投影。这一步避免 OM 文本在“摘要合并摘要”时无限重复。

两者的职责边界：

| 维度 | VCC | OM |
|---|---|---|
| 主要输入 | 被压缩的 transcript、工具调用、文件操作、前一 checkpoint | 当前 branch 的 memory ledger |
| 主要输出 | Session Goal、Files、Commits、Outstanding Context、简短 transcript | Reflections、Observations、memory IDs |
| 是否调用模型 | 否 | worker 调用；compaction render 不调用 |
| 精确恢复锚点 | `#N` / durable seq | 12 位 memory ID -> provenance graph |
| 擅长 | 近期执行轨迹和代码操作 | 长期事实、决定、偏好和约束 |

## 9. Recall 的真实边界

### 9.1 独立 OM 的 recall

独立 `pi-observational-memory` 的 `recall` 很窄：它接受一个精确的 12 位 memory ID，返回 observation/reflection 及其原始 evidence。它不是全文搜索器，也不是 transcript browser。

### 9.2 `pi-blackhole v0.4.6` 的统一 recall

Blackhole 把两类能力合并为一个工具：

| 查询 | 行为 |
|---|---|
| `abcdef123456` | OM ID -> observation/reflection -> supporting observations -> source entries |
| `#N` | 展开原始 transcript entry，并附加 related observations/reflections |
| `#N:path` | 钻取该 entry 的文件操作内容 |
| `#N:path:full` | 展开完整文件内容，受总输出上限保护 |
| `#N:path:offset[:limit]` | 文件内容分页 |
| 文本或 regex | transcript/file 搜索，并为命中 entry 附加 related memory |
| `mode:file` / `mode:touched` | 文件内容搜索或 touched-files 聚合 |
| `scope:all` | 搜索完整 session，而不只当前 lineage |

OM recall 是双向的：

~~~text
memory ID -> ledger record -> supporting observations -> source entry IDs -> raw context

raw entry / #N -> observation.sourceEntryIds
               -> reflection.supportingObservationIds
               -> Related observations / Related reflections
~~~

正向结果还区分 `active` / `dropped`，报告缺失 source、非 source entry、缺失 supporting observation，以及 48-bit ID collision。即使 observation 已被 dropper 从活跃记忆移除，只要 ledger 历史仍在，它依旧可 recall。

### 9.3 当前 DSH 插件

当前项目已实现：

- durable `event.seq` 驱动的 transcript recall；
- `#N`、文件 drill-down、分页、regex、`mode:file`、`mode:touched`；
- `/blackhole-recall` 与可选 dsh-tools registry；
- 50 KB 级输出边界和危险 regex 降级。

当前项目尚未实现：

- observation/reflection/drop ledger；
- 12 位 OM ID 查找；
- OM ID -> source entries；
- `#N` / 搜索命中 -> related observations/reflections；
- active/dropped、missing provenance 和 collision diagnostics。

源码明确把精确小写 12 位十六进制查询保留给 OM，并返回 `OM_RECALL_TODO`；测试也固定断言这一路径不得误落到普通 transcript 搜索。因此当前状态是“Blackhole recall 的 transcript/file 子集”，不是完整等价。

## 10. DSH 落地的首要阻塞

### 10.1 类型扩展不等于可持久化

`@deepseek-ai/dsh-session` 支持 declaration merge 扩展 `SessionEventMap`，但 rc.6 的持久化 vocabulary 是生成时固定的 `KNOWN_SESSION_EVENT_TYPES`。源码注释还明确写出：out-of-repo plugin events 的 registration surface 尚未提供。

同时，`SessionEvent` 支持 `ignorable?: true`，但当前 `Session.append()` 对非 surface event 的签名没有 metadata options：

~~~ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent<T>
~~~

结果是：插件可以在 TypeScript 层声明 `om/*` 并在当前进程 append，但不能通过正式 API 给该非 surface event 标记 `ignorable`；旧/静态 reader 遇到未知且非 ignorable event 会拒绝恢复 session。直接照搬 Pi custom entries 会产生“当前运行正常，重启后日志不可读”的风险。

### 10.2 推荐的宿主契约

优先在 DSH core 提供以下任一能力：

1. 注册 plugin event type，并把它纳入 persistence catalog；或
2. 提供已知的通用 `plugin/data` envelope，由 core 自动写 `ignorable: true`；或
3. 允许非 surface `Session.append(type, data, { ignorable: true })`，并让 persistence reader 正确跳过未知 informational events。

建议的通用 envelope：

~~~ts
type PluginDataEvent = {
  namespace: "dsh-blackhole.om"
  version: 1
  kind:
    | "observations-recorded"
    | "reflections-recorded"
    | "observations-dropped"
    | "projection-recorded"
  payload: JsonValue
}
~~~

OM events 对 DSH 的基础 conversation reconstruction 可以是 ignorable：旧 reader 跳过它们只会失去增强记忆，不应破坏原始 transcript。新插件仍必须对 namespace、version、kind 和 payload 做运行时校验，不能只依赖 declaration merge。

### 10.3 Compaction seam 还缺少什么

DSH 当前唯一自定义入口是 `BasicCompactionEngine.summarize()`。它能返回 summary/provider/model，但没有 Pi `session_before_compact` 的 arbitrary `details` 槽；`SummarizationInput` 只提供 shadowed messages，没有直接提供 `shadowedSeqs` 或 projection details。

现有代码可以像 `resolveRegionSeqs()` 一样用 message ID 映射 durable seq，但完整 OM 仍需要可靠记录“本次实际注入了哪份 projection”。推荐由宿主扩展 summary metadata，或在同一 compaction transaction 追加 `projection-recorded` plugin event，并关联 `compactionId`/shadowed seq boundary。

### 10.4 Sidecar 备选方案

如果短期不能改 DSH core，可把 OM ledger 存为逐 session JSONL sidecar。此方案只有在同时满足以下条件时才能接近等价：

- append 使用原子写入和 fsync/flush 语义；
- fork 时复制或引用正确的父 session prefix；
- session 删除、迁移和跨主机部署同步处理 sidecar；
- ledger event 与 source `event.seq` 的提交顺序可恢复；
- compaction projection 与 remote state 不会产生跨文件撕裂。

因此 sidecar 可作为实验路径，但不是首选 source of truth。

## 11. 对 remote Responses compaction 的影响

当前项目还有 provider-native opaque replay。只把 OM Markdown 附加到 DSH 可读 checkpoint，并不能自动证明普通 Responses 轮通过 `responsesCompactionReplay.prepareInput()` 时也能看到同一份 OM。

实现时必须分别验证：

1. local VCC summary 包含 OM projection；
2. native LLM fallback summary 包含 OM projection；
3. remote server summary 的 DSH checkpoint 包含 OM projection；
4. provider adapter 走 opaque replacement history 时，OM 仍以明确输入项进入下一轮；
5. route/model/endpoint 切换或 remote fallback 后不会重放旧 OM projection；
6. 重复 remote compaction 不会累积旧 OM sections。

在这组测试通过前，不应宣称 remote 分支与 `pi-blackhole` OM 等价。

## 12. 推荐实现路线

| 阶段 | 工作项 | 完成标准 |
|---|---|---|
| P0 | DSH plugin event persistence 契约 | 重启、加载和旧 reader 跳过测试通过；不会生成不可恢复日志 |
| P1 | Ledger kernel | discriminated union、运行时 schema、hash ID、fold、tombstone、projection 单测通过 |
| P2 | Observer | token gate、chunk、source seq allow-list、空结果与失败 cursor 行为通过 |
| P3 | Reflector + Dropper | support ID 校验、coverage、pool target、critical resistance、tombstone 测试通过 |
| P4 | Compaction 联动 | local/LLM/remote 三条分支都只注入一次当前 projection；compaction 本身不调用 OM model |
| P5 | Recall 联动 | 12 位 ID 正向 recall 与 `#N` 反向 related-memory 都通过 |
| P6 | 稳定性 | fork、重启、并发 turn、worker 失败、缺失 source、ID collision、输出上限测试通过 |

DSH 数据模型建议直接使用 durable seq，而不是伪造 Pi entry ID：

~~~ts
type DshObservation = {
  id: MemoryId
  content: string
  timestamp: string
  relevance: Relevance
  sourceEventSeqs: readonly number[]
  tokenCount: number
}

type DshLedgerBatch = {
  observations: readonly DshObservation[]
  coversUpToSeq: number
}
~~~

这样 provenance、progress 和现有 `#N` recall 都落在同一套 durable identity 上。类型层应使用 discriminated union；从 session log、worker tool call 和 sidecar 读入的数据都必须经过运行时 schema 校验。

## 13. 等价性验收矩阵

只有以下能力全部满足，才可以说达到 `pi-blackhole` 的 OM recall 效果：

| 能力 | 当前状态 | 目标 |
|---|---|---|
| transcript/text/regex recall | 已有 | 保持 |
| `#N` 与文件 drill-down | 已有 | 保持 |
| 12 位 OM ID 路由 | 仅识别并返回 TODO | 查询 ledger |
| observation -> source | 缺失 | 返回原始 DSH events/messages |
| reflection -> observations -> source | 缺失 | 完整 evidence chain |
| dropped observation recall | 缺失 | 返回并标注 dropped |
| missing/non-source diagnostics | 缺失 | 明确 partial result |
| ID collision | 缺失 | 返回 mixed/collision，而非任选一个 |
| `#N` -> related observations | 缺失 | 反向关联 |
| `#N` -> related reflections | 缺失 | 经 observation support 间接关联 |
| branch/fork locality | 尚无 OM 可验证 | 当前 branch 默认、显式 all 才跨可用范围 |
| restart durability | 尚无 OM 可验证 | ledger 与 provenance 重启后完整 |
| remote opaque replay | 尚无 OM 可验证 | OM visibility 与可读 checkpoint 一致 |

## 14. 风险与设计约束

1. Memory poisoning：source ID 存在不代表 observation 语义正确。Prompt 和审核规则要区分用户陈述、模型推断与工具结果。
2. 隐私与保留：drop 是 active-memory tombstone，不是物理删除。需要明确 purge/cleanup 策略，避免敏感事实永久留在 ledger。
3. 竞争条件：worker 读取 branch 后，session 可能 fork、切换或继续追加。提交前要验证 session identity 和 coverage boundary。
4. Token 成本：compaction 是零模型调用，但 Observer/Reflector/Dropper 会产生后台模型成本，应支持独立模型、预算、通知和 cooldown。
5. 48-bit collision：概率低但非零；索引必须保留多匹配并在 recall 中报告 collision。
6. 重复注入：前一 summary 的 OM sections 必须剥离或用结构化 projection 取代，不能递归合并旧文本。
7. Remote 分叉：可读 summary 与 provider opaque state 是两份状态，必须有一条明确的 OM 注入契约。

## 15. Evidence -> Finding -> Path

### Evidence

| ID | 不可变观察 | 来源与复现 |
|---|---|---|
| E-001 | `pi-blackhole v0.4.6` 在同一 before-compact hook 中先 `compile()`，再 `buildCompactionProjection()` / `renderSummary()`，最后拼接一个 summary。 | [`before-compact.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/hooks/before-compact.ts#L561-L659)；`curl.exe -sL https://raw.githubusercontent.com/k0valik/pi-blackhole/v0.4.6/src/hooks/before-compact.ts` |
| E-002 | V3 ledger 有 observation、reflection、drop 三种 records；fold 为 first-valid-wins，drop 为 tombstone。 | [`types.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/om/ledger/types.ts#L31-L68)、[`fold.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/om/ledger/fold.ts#L53-L124) |
| E-003 | Observer/Reflector 会校验模型提供的 provenance IDs；memory ID 来自内容 SHA-256 的前 12 个 hex。 | [`observer/agent.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/om/agents/observer/agent.ts#L93-L190)、[`reflector/agent.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/om/agents/reflector/agent.ts#L75-L147)、[`ids.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/om/ids.ts) |
| E-004 | Blackhole recall 既支持 memory ID -> source，也会为 transcript 命中追加 related observations/reflections。 | [`ledger/recall.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/om/ledger/recall.ts#L194-L294)、[`reverse-recall.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/om/reverse-recall.ts#L28-L114)、[`tools/recall.ts`](https://github.com/k0valik/pi-blackhole/blob/49ab560156fd53b6da1b568d5ade10287b89026c/src/tools/recall.ts#L254-L440) |
| E-005 | 当前项目把 12 位小写 hex 明确保留为 OM TODO，README 和测试均声明没有 ledger/OM ID lookup。 | `rg -n "OM_RECALL_TODO|isOmMemoryId" src/recall.ts tests/recall.mjs`；见 `src/recall.ts:89`、`src/recall.ts:497`、`tests/recall.mjs:415`、`README.zh-CN.md:83` |
| E-006 | DSH rc.6 的 `SessionEventMap` 可类型合并，但 known event catalog 静态生成；非 surface `append()` 无法设置 `ignorable`。 | `rg -n "SessionEventMap|ignorable|append<T|KNOWN_SESSION_EVENT_TYPES" node_modules/@deepseek-ai/dsh-session/lib/types node_modules/@deepseek-ai/dsh-session/README.md` |
| E-007 | 独立 OM 当前版使用 `agent_settled` 触发主动 compaction，非空 V3 projection 才 model-free render；空 projection 交给原生 summarizer。 | [`how-it-works.md`](https://github.com/elpapi42/pi-observational-memory/blob/37986b6faa1e39eb5aa1d03a4ca6379ecaf3148d/docs/how-it-works.md)、[`concepts.md`](https://github.com/elpapi42/pi-observational-memory/blob/37986b6faa1e39eb5aa1d03a4ca6379ecaf3148d/docs/concepts.md) |

### Findings

| ID | 结论 | Evidence | 置信度 |
|---|---|---|---|
| F-001 | OM 是主动维护的 provenance ledger，不是 VCC 的别名，也不是向量检索。 | E-001、E-002、E-003 | 高 |
| F-002 | 完整 Blackhole recall 是双向联动：memory -> source 和 source -> related memory。 | E-004 | 高 |
| F-003 | 当前 DSH 插件只有 transcript/file recall 子集，不能宣称 OM 或 `pi-blackhole` recall 等价。 | E-005 | 高 |
| F-004 | 直接 declaration-merge 三个 `om/*` event 会留下持久化兼容风险，必须先提供宿主注册/ignorable 契约或可靠 sidecar。 | E-006 | 高 |
| F-005 | OM 可接到当前唯一 `summarize()` seam，但 local、native LLM 和 remote opaque replay 必须作为三条不同路径验收。 | E-001、E-005、E-006 | 中高 |

### Path P-001：从原始 DSH event 到可验证长期记忆

| 步骤 | 调用/数据路径 | Evidence/Finding |
|---|---|---|
| 1 | DSH source event 以 durable seq 进入当前 session branch。 | E-005 |
| 2 | Observer 读取 due range，校验 source seq allow-list，append observation batch。 | E-003、F-001 |
| 3 | Reflector 读取 active observations，校验 support IDs，append reflection batch。 | E-003、F-001 |
| 4 | Dropper 在池压力下 append tombstone，不删除历史 record。 | E-002、F-001 |
| 5 | Compaction seam 同时生成 VCC summary 和确定性 OM projection，只返回一个 replacement。 | E-001、F-005 |
| 6 | Agent 用 memory ID 正向恢复 source，或从 `#N` 反向查看 related memory。 | E-004、F-002 |
| 7 | DSH restart/fork 后从持久 ledger 重放同一结果。该步依赖 P0 宿主契约，当前尚未满足。 | E-006、F-004 |

## 16. 最终判断

OM 的价值不在“多生成一段总结”，而在把长期事实从递归摘要链中独立出来，并给每条压缩事实保留可追溯证据。它与 VCC 的最佳组合是：

~~~text
VCC = 工作轨迹的确定性压缩
OM  = 长期语义事实的主动账本
recall = 从两类压缩锚点回到原始 session 证据
~~~

当前项目已经打好了 VCC、durable seq 和 transcript/file recall 的基础，但 OM 联动仍应维持 TODO。下一步不是先写 Observer prompt，而是先完成 P0 的 session persistence contract；否则会得到一个当前进程看似可用、重启和 fork 后不可证明正确的“半个 OM”。
