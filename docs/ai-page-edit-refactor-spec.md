# AI 页面修改流程局部重构实施 Spec

状态：Proposed  
适用项目：`vue-yuan-drag-main`  
目标：保留现有 LangGraph 与三级意图识别，在不限制用户消息发送的前提下，将每个根任务的业务澄清限制为最多一次，并在预算耗尽后进行受确定性策略约束的自主执行。

## 1. 方案确认

当前方向合适，可以实施，但必须同时满足以下约束，否则不能上线：

1. 所有用户消息先持久化，再启动 AI 执行；执行失败不得删除消息。
2. 所有消息都进入现有 `rule -> context -> tool` 意图识别链。
3. 模型只输出意图和与未决任务的关系，不输出澄清预算或执行权限。
4. `relationToPending` 必须由确定性代码结合 pendingTask、revision 和消息证据校正。
5. 每个根任务最多进行一次业务澄清；技术错误不生成业务澄清，也不消耗预算。
6. 达到澄清上限后，各执行节点必须具备安全的自主 fallback，不能只是更换错误码。
7. `clarification_requested` 是本轮 Graph Run 的终态，但 pendingTask 仍处于 `awaiting_user`，不是业务任务完成。
8. `question/chat` 必须进入真实 QA 节点，不能继续使用固定拒绝话术。
9. `NO_EFFECTIVE_PAGE_CHANGE`、revision 冲突和用户取消属于正常业务终态，不显示为澄清错误。

## 2. 不在本次重构范围内

以下能力保留，不进行框架重写：

- LangGraph 作为编排框架；
- rule/context/tool 三级意图识别；
- `local_edit`、`large_edit`、`full_relayout` 三类编辑意图；
- 组件索引、RAG 检索和稳定组件 ID；
- Patch Schema、Patch Executor、页面数据修复与几何校验；
- draftPage 上执行、最终原子提交、revision 防覆盖和撤销历史；
- 当前 SSE 传输方式。

本阶段不引入 LangChain Agent，不引入 LangGraph Checkpointer。跨请求任务继续由会话中的 pendingTask 恢复，但服务端必须把客户端传入的 pendingTask 当作不可信输入重新校验。

由于服务端不保存任务状态，仅靠客户端回传对象无法证明“该 Root Task 已经使用过一次澄清”。因此 pendingTask 必须由服务端附带完整性令牌：客户端可以读取和保存任务内容，但不能修改澄清预算、任务范围或原始要求后继续执行。建议新增 `AI_PENDING_TASK_SECRET`；正式环境必须配置稳定密钥，本地开发未配置时可在进程启动时生成临时密钥，此时开发服务器重启后旧 pendingTask 自动失效。

完整性令牌使用 HMAC-SHA256，签名输入为 canonical JSON，至少覆盖：`schemaVersion/taskId/pageId/pageRevision/status/taskIntent/rootRequest/additionalInstructions/targetComponentIds/candidateComponentIds/clarification`。服务端解析时先做长度和结构限制，再使用 constant-time comparison 验证令牌；验证失败按无 pendingTask 处理并记录审计原因，不得尝试“修复”客户端内容。令牌只证明任务完整性，不代表删除、扩大布局范围或其他执行授权。

## 3. 核心术语

### 3.1 Graph Run

一条用户消息触发的一次 `/api/ai/edit-page` 请求和一次 LangGraph 调用。

### 3.2 Root Task

一次连续的页面修改目标。例如“加点图片”以及后续“随便”属于同一个 Root Task。

### 3.3 Pending Task

Root Task 因一次业务澄清暂时等待用户输入时保存的最小恢复状态。

### 3.4 Clarification Budget

每个 Root Task 的业务澄清预算，固定为一次。QA 问答、技术重试和错误说明不计入预算。

## 4. 必须保持的系统不变量

```text
INV-01 用户消息一旦提交，任何执行结果都不能删除该消息。
INV-02 不存在有效 pendingTask 时，relationToPending 永远等于 none。
INV-03 pendingTask revision 与当前页面不一致时，不得恢复旧任务。
INV-04 clarificationUsed 只能由服务端确定性状态转换从 0 变为 1。
INV-05 clarificationUsed = 1 时，任何节点都不得向用户生成第二个业务澄清。
INV-06 executionPolicy 只能由代码推导，模型输出不得覆盖。
INV-07 allowDelete = false 时，提供给模型的 Schema 中不得出现 removeComponent。
INV-08 技术错误不得转换为 ClarificationProposal。
INV-09 页面修改只能在最终 revision 校验通过后一次性提交。
INV-10 question/chat/cancel/no_change 不得产生页面 mutation。
INV-11 未通过完整性令牌校验的 pendingTask 不得恢复、不得携带澄清预算或授权。
INV-12 late proposal 请求用户确认时，本轮 draftPage 必须丢弃；下一轮从未变化的原页面重新执行。
```

## 5. 数据模型

### 5.1 路由结果

```ts
export type PageEditIntent =
  | 'local_edit'
  | 'large_edit'
  | 'full_relayout'
  | 'question'
  | 'chat'
  | 'cancel'
  | 'unresolved'

export type PendingRelation =
  | 'none'
  | 'answer'
  | 'supplement'
  | 'delegate'
  | 'replace'
  | 'cancel'
  | 'question'
  | 'chat'
  | 'unresolved'

export interface ModelRoutingDecision {
  intent: PageEditIntent
  relationToPending: PendingRelation
  reason: string
}

export interface NormalizedRoutingDecision extends ModelRoutingDecision {
  source: 'rule' | 'context' | 'tool'
}
```

不增加模型自报 `confidence` 字段。

### 5.2 Pending Task

Graph Run 内部先使用活动任务状态；它既能表达尚未澄清的新任务，也能表达从 pendingTask 恢复的任务：

```ts
export interface AIEditTaskState {
  taskId: string
  pageId: string
  pageRevision: number
  intent: 'local_edit' | 'large_edit' | 'full_relayout'
  rootRequest: string
  additionalInstructions: string[]
  targetComponentIds: string[]
  candidateComponentIds: string[]
  clarificationUsed: 0 | 1
  resumedFromPending: boolean
  delegatedToModel: boolean
}
```

`clarificationUsed = 0` 的活动任务只存在于本轮服务端状态中。只有 Broker 确定询问一次后，才序列化为下面的 `AIPendingTask`；因此任何合法 pendingTask 都天然表示预算已经使用。

使用 `AIPendingTask` 替代承担过多职责的 `AIPendingClarification`：

```ts
export interface AIPendingTask {
  schemaVersion: 2
  taskId: string
  pageId: string
  pageRevision: number
  status: 'awaiting_user'
  taskIntent: 'local_edit' | 'large_edit' | 'full_relayout'
  rootRequest: string
  additionalInstructions: string[]
  targetComponentIds: string[]
  candidateComponentIds: string[]
  clarification: {
    used: 1
    max: 1
    code: AIBusinessClarificationCode
    question: string
    source: AIClarificationSource
  }
  integrityToken: string
}
```

客户端传入 pendingTask 后，服务端必须：

- 固定 `max = 1`；
- 只要存在合法 `clarification` 就固定 `used = 1`，不信任客户端计数；
- 验证 pageId、pageRevision；
- 验证所有组件 ID 仍存在；
- 限制字符串和数组长度；
- 丢弃客户端传入的任何 executionPolicy、授权或 approved 字段。
- 验证 `integrityToken`；失败时清除 pending，并将当前消息作为一条全新的消息重新路由。

服务端创建 pendingTask 的固定顺序为：规范化字段 → 固定 `used/max/status` → canonicalize → 签名。恢复时不得先信任客户端字段再验证签名。为避免令牌被复制到另一页面，签名必须覆盖 pageId 和 pageRevision；页面 revision 变化后旧任务自然失效。

旧版 `AIPendingClarification` 没有服务端完整性令牌，不能在客户端直接升级为有效 `AIPendingTask`。版本迁移只保留历史消息和 memory，清除旧 pending/openQuestions，并在下一次用户发送消息时按新任务重新路由；不得把旧对象交给服务端“补签”。这会放弃升级前尚未完成的一次任务，但避免把可篡改旧状态提升为可信授权。

### 5.3 业务澄清候选

```ts
export type AIBusinessClarificationCode =
  | 'TARGET_AMBIGUOUS'
  | 'DELETION_AUTH_REQUIRED'
  | 'GEOMETRY_RELAYOUT_AUTH_REQUIRED'
  | 'CONFLICTING_REQUIREMENTS'
  | 'MISSING_EXECUTION_DATA'

export interface ClarificationProposal {
  source: 'router' | 'component_locator' | 'large_edit_planner' | 'patch_generator' | 'geometry_validator'
  code: AIBusinessClarificationCode
  question: string
  blocking: boolean
  hasSafeFallback: boolean
  affectedComponentCount: number
  fallback: AutonomousFallback
}

export type AutonomousFallback =
  | {
      kind: 'select_best_candidate'
      orderedCandidateIds: string[]
      evidence: Array<'stable_id' | 'exact_name' | 'exact_text' | 'unique_type' | 'rag' | 'lexical' | 'spatial_order'>
    }
  | {
      kind: 'use_model_defaults'
      allowedComponentIds: string[]
    }
  | {
      kind: 'use_conservative_plan'
      maxSteps: 2 | 3 | 4
      operationLimit: number
    }
  | {
      kind: 'limit_geometry_scope'
      allowedComponentIds: string[]
      maxAffectedComponents: 12
    }
  | {
      kind: 'return_no_change'
      message: string
    }
```

Fallback 是代码可执行的数据，不是给模型的自然语言建议。它不得开启删除权限、不得扩大目标集合、不得提高 operationLimit，也不得把多个歧义候选解释为“全部”。`select_best_candidate` 只选择 `orderedCandidateIds[0]`；数组为空时必须转为 `execution_failed`，不能随机选择。

第一版固定映射：

| Proposal code | 预算已使用后的 fallback |
|---|---|
| `TARGET_AMBIGUOUS` | 有确定性证据时 `select_best_candidate`；无证据时 `execution_failed` |
| `MISSING_EXECUTION_DATA` | 非破坏性视觉或新增请求使用 `use_model_defaults`；缺少构造合法组件的必填业务数据时 `return_no_change` |
| `CONFLICTING_REQUIREMENTS` | 保留现有数据和组件，执行可同时满足的安全子集；无安全子集时 `return_no_change` |
| `DELETION_AUTH_REQUIRED` | 强制 `allowDelete=false`，跳过删除；其他安全修改仍可继续 |
| `GEOMETRY_RELAYOUT_AUTH_REQUIRED` | 影响闭包不超过 12 时 `limit_geometry_scope`；超过 12 时 `return_no_change` |

截图场景的固定语义为：“加点图片”识别为 page scope 的非破坏性 `addComponent` 请求；第一次允许询问图片方向，“随便/你决定/都可以”等回复归一化为 `delegate`，随后 `use_model_defaults` 只允许新增图片及必要的安全放置，不得改写或删除现有候选图片。

删除业务澄清码 `ROUTING_UNCERTAIN`。路由超时、结构化输出无效等使用内部技术状态，不进入 Broker。

### 5.4 执行策略

```ts
export interface ExecutionPolicy {
  canClarify: boolean
  useModelDefaults: boolean
  allowDelete: boolean
  allowRegionalRelayout: boolean
  maxAffectedComponents: number
  operationLimit: number
}

export interface UserAuthorizationEvidence {
  rootUserMessage: string
  additionalUserMessages: string[]
}
```

`ExecutionPolicy` 禁止从模型响应或客户端请求中直接读取。`UserAuthorizationEvidence` 也不接受客户端提交的同名对象，只能由服务端从经过完整性校验的 `rootRequest` 和本轮原始用户消息重新构造。模型生成的 plan、route reason、summary、合成后的 effectiveRequest、fallback 描述均不得进入授权证据。

### 5.5 终态

```ts
export type PageEditGraphResult =
  | AIClarificationRequested
  | AIPageEditCompleted
  | AIAssistantReply
  | AITaskCancelled
  | AINoChange
  | AIExecutionFailed

export interface AIClarificationRequested {
  type: 'clarification_requested'
  runId: string
  question: string
  pendingTask: AIPendingTask
}

export interface AIAssistantReply {
  type: 'assistant_reply'
  runId: string
  message: string
  pendingTask: AIPendingTask | null
}

export interface AITaskCancelled {
  type: 'task_cancelled'
  runId: string
  message: string
}

export interface AINoChange {
  type: 'no_change'
  runId: string
  message: string
  retryable: boolean
}

export interface AIExecutionFailed {
  type: 'execution_failed'
  runId: string
  code: string
  message: string
  retryable: boolean
}
```

`revision_conflict` 主要发生在响应到达后、提交前，由前端检测并转换为本地正常终态；它不得删除用户消息或提交过期页面。

## 6. LangGraph 主图

完整跨轮图见 [ai-page-edit-implementation-flow.md](./ai-page-edit-implementation-flow.md)。单次 Graph Run 的节点和边定义如下：

```text
START
  -> ruleIntent
      resolved -> normalizeRoutingDecision
      unresolved -> contextIntent
  -> contextIntent
      resolved -> normalizeRoutingDecision
      technical_failure -> retry once -> toolIntent
  -> toolIntent
      resolved -> normalizeRoutingDecision
      technical_failure -> executionFailed
  -> normalizeRoutingDecision
  -> reduceTaskState
      question/chat -> answerQuestion -> END
      cancel -> cancelTask -> END
      edit -> preflightEdit
  -> preflightEdit
  -> clarificationBroker
      ask_once -> clarificationRequested -> END
      fallback/continue -> deriveExecutionPolicy
  -> deriveExecutionPolicy
  -> dispatchEdit
      local_edit -> localEditGraph
      large_edit -> largeEditGraph
      full_relayout -> fullRelayoutGraph
  -> inspectExecutionResult
      completed / no_change -> normalizeExecutionResult
      technical_failure -> executionFailed
      late_proposal -> clarificationBroker
          ask_once -> clarificationRequested -> END（丢弃本轮 draftPage）
          fallback -> applyLateFallback -> resumeExecution
  -> resumeExecution
      使用 executionCheckpoint 回到原子图的安全恢复点
      不得重新执行已经提交到当前 draftPage 的步骤
  -> normalizeExecutionResult
  -> END
```

`clarificationBroker` 是可重入节点：preflight proposal 和 late proposal 使用同一排序与预算规则。为防止回路无限执行，state 必须记录 `brokerPass` 和每个 proposal 的稳定 `proposalId`；同一 `proposalId` 在同一 Graph Run 内最多处理一次，late fallback 恢复后再次出现相同 proposal 时直接归一化为 `no_change`。

```ts
export interface ExecutionCheckpoint {
  branch: 'local_edit' | 'large_edit' | 'full_relayout'
  resumeNode: 'locate' | 'plan_step' | 'relayout_group' | 'generate_patch' | 'apply_patch' | 'finalize'
  stepIndex: number
  groupIndex: number
  modelAttempt: number
  repairAttempt: number
  noOpRetry: number
  geometryRepairAttempt: number
  needsRelocate: boolean
  previousPatch: AIPagePatch | null
  validationError: string | null
}
```

Checkpoint 只存在于本轮服务端 state，不序列化到客户端 pendingTask。若 Broker 决定本轮直接应用 fallback，则从 checkpoint 恢复并继续操作当前 draftPage；若 Broker 决定向用户询问，本轮立即结束并丢弃 draftPage。用户下一条消息触发新的 Graph Run，从客户端仍未变化的原页面、已签名 pendingTask 和合并后的用户指令重新执行，不能把未提交 draftPage 放进 pendingTask。

`clarification_requested` 结束本次 Graph Run，但保存的 pendingTask 状态为 `awaiting_user`。用户下一条消息创建新的 Graph Run，并重新经过完整三级意图识别。

## 7. 节点详细行为

### 7.1 ruleIntent

保留现有编辑意图规则。仅在存在 pendingTask 时增加整句快速规则：

```ts
const EXACT_CANCEL = /^(?:算了|取消|不用了|先不改了|保持现状)[。！!？?]*$/
const EXACT_CONFIRM = /^(?:是|可以|行|好的|继续|同意|没问题)[。！!]*$/
const EXACT_DELEGATE = /^(?:随便|随你|你决定|你看着办|都可以)[。！!]*$/
```

规则执行前必须 `trim()`。不允许使用取消词子串判断。以下内容不得被快速取消：

```text
算了，把按钮改成红色
不用了之前的图片，换成产品截图
取消动画但保留布局修改
```

未整句命中时交给 contextIntent。

### 7.2 contextIntent 与 toolIntent

两层均输出 `ModelRoutingDecision`，并接收：

- 当前原始消息；
- 最近对话；
- 页面概要；
- 已完成修改摘要；
- 经服务端校验的 pendingTask 或 null；
- pendingTask 的原始要求和上一轮问题。

无 pendingTask 时提示和 Schema 要求 `relationToPending = none`，但服务端仍必须再次强制校正。

contextIntent 结构无效或超时：技术重试一次；仍失败进入 toolIntent。toolIntent 仍失败：返回 `execution_failed`，不得生成澄清。

### 7.3 normalizeRoutingDecision

纯函数，不调用模型。按以下顺序执行：

1. pendingTask 不存在或 revision/ID 失效：清除 pending，relation 强制为 `none`。
2. 无 pending 时的 `answer/supplement/delegate/cancel/question/chat/unresolved` relation 强制为 `none`。
3. 整句取消规则优先于模型 cancel；非整句取消不得仅凭子串取消任务。
4. 当前消息包含明确新编辑动作且模型 intent 为 local/large/full 时，模型的 `cancel` 修正为 `replace`。
5. pending 存在且模型成功返回 `unresolved`，如果消息不是明确 question/chat/cancel/new edit：
   - clarification.used = 1 时修正为 `delegate`；
   - clarification.used = 0 时保留 `unresolved`，交给业务澄清判断。
6. 模型调用本身失败不属于 `unresolved`，而属于 technical failure。

### 7.4 reduceTaskState

纯函数，不调用模型：

| 条件 | 状态转换 |
|---|---|
| 无 pending + local/large/full | 创建新 Root Task，预算 0 |
| pending + answer/supplement | 合并原始消息，继承旧 taskIntent |
| pending + delegate | 恢复旧任务，设置 `useModelDefaults` 输入信号 |
| pending + replace | 清除旧任务，创建新 Root Task，预算重新为 0 |
| pending + question/chat | 进入 QA，pending 保持 |
| pending + cancel | 清除 pending，返回 task_cancelled |

`additionalInstructions` 最多保留 6 条，每条最多 500 字。合成请求必须保留 `rootRequest` 和原始用户消息，不能让模型改写审计内容。

### 7.5 answerQuestion

新增轻量只读 QA 节点，优先复用 context model；`OPENROUTER_API_KEY2` 未配置时回退到主 `modelClient`。输入：

- 当前问题；
- 最近对话；
- 页面概要和相关组件概要；
- pendingTask；
- 上一次澄清问题；
- 若存在，最近一次几何冲突摘要。

使用只允许以下结构的 strict schema：

```ts
{
  type: 'assistant_reply'
  message: string
}
```

QA 节点不得访问 Patch Schema，不得连接 local/large/full 子图，不得修改 draftPage。回答后默认保留合法 pendingTask。

QA 使用独立 4 秒超时并允许同一模型重试一次；context model 技术失败时可回退主模型，但任何模型失败都不得转换成业务澄清。两层均失败时返回 `execution_failed(retryable=true)` 并原样保留 pendingTask。QA 输出还必须经过长度限制和协议标记过滤，不能回传页面 Patch、工具调用或新的执行授权。

### 7.6 preflightEdit

复用现有路由、组件定位和规划能力，只收集执行前可发现的业务歧义：

- 目标组件候选；
- 请求是否是纯新增意图；纯新增 Text/Image/Button/Input/Form/Chart 时直接使用 page scope，不进入“选择现有组件”定位；
- 明确删除请求的范围；
- 相互冲突的要求；
- 构造合法组件必需的数据；
- 能够提前识别的布局影响。

preflight 不向用户直接提问，只产生零个或多个 ClarificationProposal。无法在 preflight 发现的几何问题允许在 draftPage 模拟阶段产生 late proposal，但仍必须经过同一个 Broker。

纯新增请求允许因为内容方向缺失产生一次 `MISSING_EXECUTION_DATA` proposal，但 fallback 必须保留 `addComponent` 语义。例如“加点图片”不能因为页面中已有 Image 就转成 updateProps，也不能询问“替换哪个组件”作为默认路径。

### 7.7 clarificationBroker

只处理业务 proposal。技术异常必须在进入 Broker 前分流。

固定排序：

```text
1. blocking && !hasSafeFallback 的明确破坏性操作
2. 可能选错实际组件的 TARGET_AMBIGUOUS
3. CONFLICTING_REQUIREMENTS
4. MISSING_EXECUTION_DATA
5. 超过安全自动修复范围的 GEOMETRY_RELAYOUT_AUTH_REQUIRED
```

同级按 `affectedComponentCount` 降序，再按 source 固定顺序排序，确保结果可复现。纯视觉参数不得产生 proposal。

```ts
if (task.clarificationUsed === 0 && proposals.length > 0) {
  return askHighestPriorityProposal()
}

return applyProposalFallbacks()
```

创建 pendingTask 时服务端固定 `clarification.used = 1`。不得存在第二次 `clarification_requested`。

Broker 输出必须是以下判别联合，子图不得再直接构造用户可见澄清终态：

```ts
type ClarificationBrokerDecision =
  | { type: 'continue'; appliedFallbacks: AutonomousFallback[] }
  | { type: 'ask'; proposalId: string; pendingTask: AIPendingTask }
  | { type: 'no_change'; message: string }
  | { type: 'execution_failed'; code: string; message: string; retryable: boolean }
```

`ask` 前必须将 pendingTask 规范化并签名。`continue` 只把 fallback 结果写入 task/executionPolicy/selection，不得直接修改真实页面；`no_change` 和 `execution_failed` 都不得消耗新的澄清预算。

### 7.8 deriveExecutionPolicy

纯函数。建议第一版常量：

```ts
const MAX_CLARIFICATION_ROUNDS = 1
const MAX_AFFECTED_COMPONENTS = 12
const DEFAULT_OPERATION_LIMIT = 12
```

```ts
canClarify = task.clarificationUsed === 0
useModelDefaults = task.clarificationUsed === 1 || relationToPending === 'delegate'
allowDelete = hasExplicitPositiveDeletionRequest(userAuthorizationEvidence)
  && !hasExplicitDeletionRejection(userAuthorizationEvidence)
allowRegionalRelayout = true
maxAffectedComponents = 12
```

`allowRegionalRelayout = true` 只允许 Patch Executor 在当前局部冲突闭包内修复，不能授权整页重排。超过 12 个受影响组件时：

- 预算未使用：产生几何业务 proposal；
- 预算已使用：放弃越界操作，保留安全修改或返回 no_change。

删除权限采用保守白名单：只有用户原始消息或追加指令明确包含正向删除动作且没有否定表达时为 true；模型规划出的删除需求不能自行开启权限。否定表达优先，例如“删除动画但不要删除组件”不能开启组件删除权限。授权解析只识别完整动作与对象组合（如“删除这个按钮”），不能因出现单独的“删、去掉、不用”字样授权。

## 8. 自主 fallback 规范

必须先实现本节，再将最大澄清轮次改为 1。

### 8.1 Component Locator

当 `canClarify = true`：允许输出 selection 或 ClarificationProposal。  
当 `canClarify = false`：strict schema 只允许 selection。

自主选择顺序：

1. 稳定 ID 或完整组件名称精确匹配；
2. 当前文案/标题/alt 精确匹配；
3. 组件类型明确且页面中唯一；
4. RAG/词法综合分数最高；
5. 分数相同按页面空间顺序和稳定 ID 排序，确保结果可复现。

小页面也必须执行真实词法排序，不能给所有组件相同分数后直接选择数组第一项。除非用户明确表达“全部/所有”且操作不包含删除，否则不能因为歧义选择全部候选。

结构化输出无效或超时属于技术失败：重试一次，仍失败可以使用已经存在的确定性候选排名；如果完全没有候选证据，返回 `execution_failed`，不得随机选择。

### 8.2 Large Edit Planner

当 `canClarify = true`：允许输出 plan 或 ClarificationProposal。  
当 `canClarify = false`：Schema 只允许 plan，并在提示中要求使用保守默认值。

业务歧义 fallback：生成保守计划，限制 2～4 步和现有操作预算。  
模型超时或连续无效输出：返回 `execution_failed`，不伪装成业务 fallback。

每个执行步骤开始前必须重置：

```ts
modelAttempt = 0
repairAttempt = 0
noOpRetry = 0
geometryRepairAttempt = 0
needsRelocate = false
currentPatch = null
previousPatch = null
validationError = null
```

### 8.3 Patch Generator

当 `canClarify = true`：允许输出 page_patch 或 ClarificationProposal。  
当 `canClarify = false`：动态 Schema 只允许 page_patch。

Schema 必须同时受到 executionPolicy 限制：

- `allowDelete = false`：不包含 `removeComponent`；
- 超出目标集合的 componentId 不进入 enum；
- page scope 才允许 `updatePageStyle`/`addComponent`；
- operationLimit 继续作为硬限制。

连续结构化输出无效或模型超时：`execution_failed`。  
合法 Patch 连续两次没有有效变化：`no_change`。  
合法 Patch 经过有限修复仍无法安全应用：`no_change` 或保留已验证的安全部分，不能再次澄清。

### 8.4 Geometry

所有几何尝试都在 draftPage 上执行：

- 冲突闭包不超过 12 个组件：允许局部自动修复；
- 超过 12 个组件且预算未使用：产生一次几何 proposal；
- 超过 12 个组件且预算已使用：不扩大范围，放弃该危险修改；
- 未明确允许删除时，几何修复不得通过删除组件解决；
- 最终完整页面校验失败：不提交页面。

Geometry 节点返回 `{ type:'applied' } | { type:'late_proposal', proposal, checkpoint } | { type:'execution_failed' }`，不得直接返回 `clarification_requested`。`allowRegionalRelayout` 只表示允许在 12 个组件以内运行确定性修复算法，不表示用户批准任意移动，也不能被序列化进 pendingTask。向用户询问后重新执行时，原 Graph Run 的 draftPage 已丢弃，因此不存在“半提交”或跨请求复制草稿。

## 9. 结果归一化

### 9.1 no_change

以下情况使用正常 `no_change` 终态：

- 页面已经符合用户要求；
- 合法 Patch 连续两次没有业务变化；
- 预算耗尽后没有安全 fallback；
- 几何影响超出安全范围且无法保留安全部分。

不得再由 `verifyEffectiveChange` 返回 `NO_EFFECTIVE_PAGE_CHANGE` 红色错误。

### 9.2 execution_failed

以下情况保留技术失败：

- context/tool 路由连续失败且无法获得合法意图；
- planner 连续超时或非法结构化输出；
- Patch Generator 连续超时或非法结构化输出；
- Patch Executor 发生非业务可降级的内部错误。

技术失败不清除合法 pendingTask，除非 pendingTask 本身 revision/ID 已失效。

### 9.3 revision_conflict

响应到达后，如果 `editorStore.pageRevision !== baseRevision`：

- 不提交 AI 页面；
- 不删除用户消息；
- 添加助手提示；
- 标记该用户消息为 failed/retryable；
- 清除已经失效的 pendingTask；
- 提供重新发送入口。

## 10. API 与 SSE 协议

`success` SSE 可以携带所有正常业务终态：

```ts
type SuccessResult =
  | AIClarificationRequested
  | AIPageEditCompleted
  | AIAssistantReply
  | AITaskCancelled
  | AINoChange
```

只有真正技术失败使用：

```json
{
  "type": "error",
  "code": "EXECUTION_FAILED",
  "message": "...",
  "retryable": true
}
```

为兼容旧客户端，在迁移期 `need_clarification` 可以在 service 层映射为 `clarification_requested`，但服务端新代码不得继续产生 `CLARIFICATION_LOOP_STOPPED` 或 `CLARIFICATION_UNRESOLVED`。

## 11. 前端行为

### 11.1 消息生命周期

```text
append user message
-> status = processing
-> receive normal result
   -> status = completed
-> receive technical error/revision conflict
   -> status = failed
```

移除 catch 中的 `discardPendingEditMessage()`。Abort 同样保留用户消息，可标记为 failed 或 cancelled。

```ts
type AIMessageStatus = 'processing' | 'completed' | 'failed' | 'cancelled'

interface AIConversationMessage {
  // 保留现有字段
  status: AIMessageStatus
  taskId?: string
  retryable?: boolean
  errorCode?: string
}
```

旧 localStorage 消息迁移时默认 `status='completed'`。发送消息后必须先完成 localStorage 持久化，再启动 fetch；状态更新也必须持久化。失败重试创建新消息并通过 `taskId` 关联原任务，不能复用或覆盖旧消息 ID。

### 11.2 终态处理

```ts
switch (result.type) {
  case 'clarification_requested':
    appendAssistant(result.question)
    setPendingTask(result.pendingTask)
    break
  case 'assistant_reply':
    appendAssistant(result.message)
    syncPendingTask(result.pendingTask)
    break
  case 'task_cancelled':
    clearPendingTask()
    appendAssistant(result.message)
    break
  case 'no_change':
    appendAssistant(result.message)
    break
  case 'page_edit_completed':
    commitPageTransaction()
    clearPendingTask()
    appendCompletionMessage()
    break
}
```

红色错误区域只用于技术错误。`assistant_reply`、`task_cancelled`、`no_change`、revision conflict 使用普通对话消息或警告样式。

## 12. 文件级实施清单

### 新增

- `server/ai/graph/routingDecision.ts`
  - `normalizeRoutingDecision`
  - 整句 pending 快速规则
  - 路由一致性校验
- `server/ai/graph/taskReducer.ts`
  - 创建、恢复、替换、取消 pendingTask
  - 合并原始请求与补充指令
- `server/ai/graph/clarificationBroker.ts`
  - 业务 proposal 排序
  - 一次预算状态转换
  - fallback 选择
- `server/ai/graph/executionPolicy.ts`
  - 纯函数推导执行权限
- `server/ai/graph/answerQuestion.ts`
  - 只读 QA 节点
- `server/ai/graph/autonomousFallback.ts`
  - 组件候选排序和各类业务 fallback
- `server/ai/graph/pendingTaskIntegrity.ts`
  - pendingTask canonicalize、HMAC 签名与 constant-time 验证
  - 令牌失败审计原因与本地开发临时密钥策略
- `server/ai/graph/executionCheckpoint.ts`
  - late proposal 的本轮恢复点结构和重复 proposal 防循环逻辑
- `server/ai/__tests__/`
  - 使用 Vitest 覆盖路由、任务归并、Broker、权限、fallback、迁移和终态

### 修改

- `src/types/aiPatch.ts`
  - 新路由、pendingTask、executionPolicy 和终态类型
- `server/structuredSchemas.ts`
  - 路由输出增加 relation
  - 增加 assistantReply schema
  - locator/planner/patch 支持 canClarify 动态 schema
- `server/ai/graph/pageEditState.ts`
  - 增加 routingDecision、task、executionPolicy、clarificationProposals、executionCheckpoint、brokerPass
  - 移除语义重叠的 pendingClarification/resolvedEditBrief 状态
- `server/ai/graph/pageEditAgent.ts`
  - 重排主图节点和条件边
  - question 指向 answerQuestion
  - no effective change 归一化为 no_change
- `server/ai/graph/modelIntentRouter.ts`
  - 输出 intent + relation
  - 技术失败不调用 clarificationUpdate
- `server/ai/graph/resolveClarification.ts`
  - 移除自然语言正则主裁决；迁移完成后删除，职责由 routingDecision + taskReducer 接替
- `server/ai/graph/clarification.ts`
  - 替换为 Broker；删除 loop-stopped 错误
- `server/ai/graph/locateComponents.ts`
  - 增加 selection-only 模式和确定性最佳候选 fallback
  - 删除“歧义时选择全部”默认行为
- `server/ai/graph/localEditGraph.ts`
  - 读取 executionPolicy
  - 支持 proposal、late proposal、patch-only 模式、no_change
  - 禁止子图直接产生用户可见 clarification 终态
- `server/ai/graph/largeEditGraph.ts`
  - plan-only 模式
  - 完整重置每步状态
- `server/ai/graph/fullRelayoutGraph.ts`
  - 完整重置每组状态
  - 删除权限读取 executionPolicy
- `server/ai/graph/patchPolicy.ts`
  - 验证当前模式是否允许 clarification
- `server/largeEditPlan.ts`
  - 动态 plan schema 和保守默认计划提示
- `server/ai/http/editPageHandler.ts`
  - 校验并签名 pendingTask；令牌失败时降级为无 pending 的全新路由
  - 输出新增正常终态
- `src/services/aiEditPage.ts`
  - 解析完整终态集合
  - technical error 与正常 no_change 分离
- `src/stores/aiConversation.ts`
  - 使用 pendingTask；旧 pendingClarification 安全失效，不在客户端升级或补签
  - 消息增加 status/taskId
  - 兼容旧 localStorage 数据
- `src/components/AIGenerator.vue`
  - 永久保留用户消息
  - 处理全部终态
  - revision conflict 转成非破坏性可重试结果
- `.env.example`
  - 增加 `AI_PENDING_TASK_SECRET`，说明生产稳定密钥与本地临时密钥行为
- `package.json`
  - 增加 Vitest 依赖及 `test:unit` 脚本

## 13. 实施顺序

### Phase 1：类型、兼容层和测试基础

1. 增加新终态、AIPendingTask、RoutingDecision 类型。
2. 增加旧会话迁移：保留消息和 memory，清除无法验证的 pendingClarification/openQuestions，不将其升级为 pendingTask。
3. 安装 Vitest，增加 `test:unit: "vitest run"`；测试环境使用 Node，不挂载真实 Vite AI 中间件。
4. 实现 pendingTask canonicalize/签名/验证，并为测试注入固定 secret。
5. 保持旧主图行为不变，先确保类型检查和旧功能通过。

### Phase 2：自主 fallback

1. 实现 locator 确定性候选排名。
2. 实现 locator selection-only schema。
3. 实现 planner plan-only schema。
4. 实现 patch-only schema 和删除操作硬限制。
5. 将合法 no-op 归一化为 no_change。
6. 修复 large/full 子步骤状态泄漏。

在 Phase 2 完成并通过测试前，不修改澄清上限。

### Phase 3：意图关系与任务状态

1. 扩展 context/tool 路由结构化输出。
2. 实现严格整句规则。
3. 实现 normalizeRoutingDecision。
4. 实现 taskReducer。
5. 将所有消息统一接入现有意图链。

### Phase 4：Broker 与一次预算

1. 节点从直接返回 clarification 改为提交 proposal。
2. 接入 ClarificationBroker。
3. 接入 inspectExecutionResult、executionCheckpoint 和 late proposal 回流路径。
4. 验证同一 proposalId 不会在单次 Graph Run 中循环处理。
5. 最大业务澄清次数设置为 1。
6. 删除 CLARIFICATION_LOOP_STOPPED/UNRESOLVED。
7. 验证预算耗尽后所有分支都有 fallback。

### Phase 5：QA、终态和前端

1. 实现 answerQuestion。
2. 扩展 SSE 与 service 终态。
3. 修改 AIGenerator 终态分支。
4. 移除消息回滚。
5. 增加 revision conflict 的可重试展示。

### Phase 6：集成验证与清理

1. 删除旧 resolveClarification 正则决策。
2. 删除旧 clarification 轮次兼容字段。
3. 清理不再使用的 error code。
4. 完成类型检查、单元测试、构建和手工场景验证。

## 14. 测试矩阵

### 路由与归一化

1. 无 pending，模型输出 answer：relation 强制 none。
2. pending revision 失效：清除 pending，当前消息作为新消息路由。
3. `算了`：整句 cancel。
4. `算了，把按钮改成红色`：不是 cancel，应为 replace/local_edit。
5. `不用了之前的图片，换成产品截图`：不是纯取消。
6. pending + used=1 + 有效模型 unresolved：归一化为 delegate。
7. context/tool 技术失败：不产生 proposal，不改变预算。

### 澄清预算

8. 新任务第一次关键目标歧义：返回一次 clarification_requested。
9. pending + `随便`：恢复任务，canClarify=false，继续执行。
10. pending + `嗯`：不能二次提问，进入安全默认执行。
11. pending + question：QA 回答，pending 保留，预算不变。
12. pending + 新任务：替换旧任务，新任务预算为 0。
13. pending + cancel：task_cancelled，不修改页面。

### 执行权限与 fallback

14. 未明确删除：Schema 中不存在 removeComponent。
15. 明确删除且无否定：允许 removeComponent。
16. 明确“不要删除”：即使模型计划删除也被 Schema/Policy 拒绝。
17. locator 歧义 + canClarify=false：选择稳定最佳候选。
18. locator 无任何候选证据：execution_failed，不随机修改。
19. planner 业务歧义 + canClarify=false：返回保守计划。
20. planner 连续超时：execution_failed，不消耗预算。
21. patch 业务歧义 + canClarify=false：只允许 page_patch。
22. patch 连续结构无效：execution_failed。
23. 连续有效 no-op：no_change。
24. 几何闭包不超过 12：自动局部修复。
25. 几何闭包超过 12 且预算已用：不扩大修改范围。

### 前端与终态

26. clarification_requested：用户消息保留，pending 保存。
27. assistant_reply：普通助手消息，页面不变。
28. task_cancelled：清除 pending，页面不变。
29. no_change：不显示红色澄清错误。
30. execution_failed：用户消息保留并标记可重试。
31. revision conflict：不提交 AI 页面，用户消息保留。
32. Abort：用户消息保留并显示已取消状态。
33. page_edit_completed：只产生一条历史命令，可撤销。

### 多步骤状态隔离

34. large edit 第二步的 geometryRepairAttempt 从 0 开始。
35. full relayout 下一组的 needsRelocate 为 false。
36. 上一步 pending/proposal 不泄漏到下一步。

### Pending 完整性与 late proposal

37. 合法签名 pendingTask：可恢复原 Root Task。
38. 修改 rootRequest、revision、候选 ID 或 clarification.used 后复用旧 token：pending 被拒绝，当前消息重新路由。
39. 删除 pendingTask 后重复发送旧回答：不得继承旧授权或直接进入 delegate。
40. 开发服务器使用临时密钥重启：旧 pending 失效但用户消息保留。
41. late geometry proposal、预算未使用：结束本轮、丢弃 draftPage、返回一次 clarification_requested。
42. late geometry proposal、预算已使用且闭包不超过 12：应用 limit_geometry_scope 并从 checkpoint 继续。
43. late geometry proposal、预算已使用且闭包超过 12：no_change，不提交任何 draftPage 修改。
44. 同一 proposalId 在恢复后再次出现：不得循环，直接 no_change。
45. `addComponent` 请求“加点图片”不得被 locator 转换成修改或替换现有 Image。
46. “随便”恢复新增图片任务：只生成 page-scope addComponent，不包含 removeComponent/updateProps(existing image)。
47. 删除授权只来自原始用户消息；模型 plan 中出现“删除”不得开启 allowDelete。
48. “删除动画但不要删除组件”：removeComponent 不出现在动态 Schema。
49. context model 未配置：answerQuestion 回退主模型；两者失败时 pending 保留。
50. 读取旧版 `pendingClarification`：保留消息和 memory，清除不可验证 pending/openQuestions；下一条消息按新任务处理，服务端不补签。

## 15. 验收标准

以下条件必须全部满足：

1. 用户可以发送任意非空文本，消息永远不会因 AI 执行失败而消失。
2. 所有消息经过保留的三级意图识别层。
3. “加点图片”最多触发一次业务澄清；随后“随便”可以完成安全修改。
4. 一次澄清后任何节点都不能再次返回 clarification_requested。
5. 问题、闲聊、取消、新任务不会被误当作旧任务授权。
6. 无 pending 时模型关系幻觉不会合并不存在的任务。
7. 技术失败不消耗澄清预算。
8. 未明确授权的删除操作在结构化 Schema 层不可生成。
9. no_change 和 revision conflict 不显示为澄清错误。
10. local/large/full 原有编辑能力、原子提交、revision 校验和撤销功能保持可用。
11. `npm run type-check`、`npm run test:unit`、`npm run build` 全部通过。
12. pendingTask 任一受保护字段被修改后都无法通过完整性校验。
13. late proposal 只能经 Broker 产生用户可见澄清，子图不得直接提问。
14. 返回 clarification_requested 时本轮 draftPage 不会被序列化、缓存或提交。
15. 删除权限可追溯到具体原始用户消息，无法由模型输出或 fallback 开启。
16. “加点图片 → 随便”完成安全新增，且不修改、全选或删除现有图片组件。

## 16. 建议提交拆分

为降低回归风险，建议按以下顺序拆分提交：

1. `test(ai): add state-machine regression coverage`
2. `feat(ai): sign and validate pending tasks`
3. `refactor(ai): add terminal results and safe session migration`
4. `feat(ai): add deterministic autonomous fallbacks`
5. `refactor(ai): normalize intent relation and task lifecycle`
6. `feat(ai): add clarification broker and one-round budget`
7. `feat(ai): route late proposals through broker checkpoints`
8. `feat(ai): add contextual QA replies`
9. `fix(ui): preserve sent messages and handle all terminal results`
10. `chore(ai): remove legacy clarification paths`
