# AI 页面修改 Review 问题修复实施 Spec

状态：Proposed  
依赖文档：`docs/ai-page-edit-refactor-spec.md`  
适用范围：当前未提交的 AI 页面修改重构差异  
目标：在不重写 LangGraph、不改变页面原子提交模型的前提下，修复 Code Review 中确认的纯新增误判、跨轮 fallback/授权丢失、几何闭包上限失效、Locator 技术错误误分类，以及失败消息污染上下文等问题。

## 1. 结论与实施边界

本修复方案在现有架构内实施：

- 保留 `rule -> context -> tool` 三级路由；
- 保留 `local_edit / large_edit / full_relayout` 三个执行子图；
- 保留签名 `AIPendingTask` 作为跨请求最小状态；
- 保留 Clarification Broker 的一次业务澄清预算；
- 保留 draftPage 执行、最终 revision 校验和单条历史命令提交；
- 不引入 LangGraph Checkpointer；
- 不把 `executionPolicy`、fallback、授权结果或 draftPage 序列化到客户端；
- 不新增另一套与 Component Locator 竞争的组件名称到 ID 解析器。

本次修复必须覆盖以下六个问题：

1. 纯新增表达误入组件修改路径；
2. pending 恢复后 Planner fallback 丢失，旧候选不读取新回答；
3. 删除澄清的肯定回答无法形成可追溯、有限范围的授权；
4. 几何冲突闭包被截断后无法识别超过 12 个组件；
5. Locator 技术失败没有重试，并被错误转换为业务澄清；
6. failed/cancelled/processing 消息继续进入 Router、RAG 和 Planner 上下文。

## 2. 新增系统不变量

在原 Spec 的不变量基础上增加：

```text
FIX-INV-01 明确的纯新增请求只能进入 page scope，不能选择现有同类型组件作为修改目标。
FIX-INV-02 被否定的“删除/替换”动作不属于正向破坏性动作。
FIX-INV-03 pending 恢复所需的 fallback 只能从已验证 pendingTask 和本轮原始消息重新派生。
FIX-INV-04 pending 候选只能限制恢复轮的候选池，不能绕过本轮回答直接再次提问。
FIX-INV-05 删除授权必须同时包含来源和有限组件 ID 范围；不存在“允许删除页面任意组件”的空范围授权。
FIX-INV-06 模型输出、路由理由、Planner 指令和会话 memory 均不能形成删除授权。
FIX-INV-07 几何闭包发现第 13 个不同组件时必须显式标记 overflow，不能依赖截断数组的长度。
FIX-INV-08 Locator 超时、异常、Abort、非法 JSON 和非法协议结果都是技术状态，不能转换成 ClarificationProposal。
FIX-INV-09 只有 status=completed 的历史消息允许进入任何模型、RAG 或 Planner 上下文。
FIX-INV-10 子图设置 execution_failed result 后必须原样传播，不能继续生成 Patch 或改写为其他错误。
```

## 3. 目标数据模型

### 3.1 动作分析结果

新增纯函数模块 `server/ai/graph/editActionAnalysis.ts`：

```ts
export type EditActionKind = 'add' | 'replace' | 'delete'

export interface EditActionMention {
  kind: EditActionKind
  negated: boolean
  componentTypes: ComponentType[]
  rawClause: string
}

export interface EditActionAnalysis {
  mentions: EditActionMention[]
  positiveAddTypes: ComponentType[]
  positiveDestructiveTypes: ComponentType[]
  hasPositiveAdd: boolean
  hasPositiveDestructive: boolean
  isPureAdd: boolean
}
```

所有纯新增判断必须通过 `analyzeEditActions(request).isPureAdd`，原来的 `isPureAddRequest` 可以保留为薄封装，禁止各节点自行维护不同正则。

### 3.2 Pending 确认依据

新增仅存在于单次服务端 Graph state 的结构：

```ts
export interface PendingConfirmationEvidence {
  clarificationCode: AIBusinessClarificationCode
  clarificationSource: AIClarificationSource
  signedTargetComponentIds: string[]
  signedCandidateComponentIds: string[]
  relation: PendingRelation
  rawUserReply: string
}
```

约束：

- 只能由已经通过 HMAC、pageId、revision 和组件 ID 校验的 pendingTask 构造；
- 新任务、replace、无效 pending、QA、chat、cancel 时必须为 `null`；
- 不写入 `AIEditTaskState`，避免跟随 `task` 进入模型提示；
- 不写入 `AIPendingTask`，不回传客户端；
- 不写入会话 memory；
- 只允许 `taskReducer` 创建，后续节点只读。

### 3.3 TaskReduction 扩展

编辑分支改为：

```ts
type TaskReductionEdit = {
  action: 'edit'
  task: AIEditTaskState
  pendingTask: null
  resumeFallbacks: AutonomousFallback[]
  pendingConfirmationEvidence: PendingConfirmationEvidence | null
}
```

新 Root Task：

```ts
resumeFallbacks = []
pendingConfirmationEvidence = null
```

合法 pending 恢复：

```ts
pendingConfirmationEvidence = {
  clarificationCode: pending.clarification.code,
  clarificationSource: pending.clarification.source,
  signedTargetComponentIds: pending.targetComponentIds,
  signedCandidateComponentIds: pending.candidateComponentIds,
  relation: decision.relationToPending,
  rawUserReply: originalCurrentMessage
}
```

### 3.4 删除授权

将全局布尔删除权限替换为带来源和范围的结构：

```ts
export interface DeleteAuthorization {
  authorized: boolean
  source: 'none' | 'explicit_user_request' | 'signed_pending_confirmation'
  componentIds: string[]
}

export interface ExecutionPolicy {
  canClarify: boolean
  useModelDefaults: boolean
  deleteAuthorization: DeleteAuthorization
  allowRegionalRelayout: boolean
  maxAffectedComponents: number
  operationLimit: number
  maxPlanSteps: number
}
```

兼容期可以保留只读派生字段：

```ts
allowDelete = deleteAuthorization.authorized
```

但动态 Schema 和 Patch Policy 必须使用 `deleteAuthorization.componentIds`，不能只检查布尔值。

删除授权的 `componentIds` 不能为空。尚未解析到稳定 ID 时，authorization 必须保持未授权，直到 preflight/locator 解析完成。

ExecutionPolicy 的限制值必须对全部 fallback 做收敛计算，禁止继续使用只取第一个匹配项的 `.find()`：

```ts
maxPlanSteps = min(6, ...allConservativeFallbacks.map(item => item.maxSteps))
operationLimit = min(12, ...allConservativeFallbacks.map(item => item.operationLimit))
```

没有 conservative fallback 时使用默认值。fallback 只能降低限制，后加入的 fallback 不能被较早、较宽松的 fallback 覆盖。

### 3.5 几何闭包结果

```ts
export interface GeometryConflictClosure {
  conflicts: GeometryConflictDetail[]
  affectedComponentIds: string[]
  devices: DeviceType[]
  overflow: boolean
}
```

`GeometryConflictError` 增加：

```ts
public readonly overflow: boolean
```

## 4. 修复一：统一动作分析与纯新增路由

### 4.1 分句与否定作用域

动作分析按以下顺序执行：

1. trim 并压缩空白；
2. 按 `，,。；;！!？?\n` 切分子句；
3. 在每个子句内寻找动作 span；
4. 只在动作前的邻近窗口判断否定，不做整句全局取反；
5. 将动作和邻近组件名词映射为结构化 mention。

第一版否定词：

```text
不要 / 别 / 禁止 / 无需 / 不要再 / 不能 / 不允许 / 不用
```

第一版动作词：

```text
add:     新增 / 添加 / 加入 / 插入 / 创建 / 放 / 加 / 来 / add / create / insert
replace: 替换 / 换掉 / 换成 / replace
delete:  删除 / 移除 / 删掉 / 删去 / 去掉 / remove / delete
```

新增动词必须支持量词：

```text
一 / 两 / 几 / 些 / 个 / 张 / 幅 / 块 / 组 / 套 / 条 / 段
```

示例：

| 请求 | 结果 |
|---|---|
| `放张图片` | pure add Image |
| `加两张产品图` | pure add Image |
| `来个按钮` | pure add Button |
| `不要替换，也不要删除，只要加图片` | pure add Image |
| `添加图片，不要替换现有图片` | pure add Image |
| `新增按钮并删除旧按钮` | add + destructive，不是 pure add |
| `替换现有图片` | destructive，不是 pure add |

### 4.2 纯新增接线

以下位置统一调用同一分析函数：

- `pageEditAgent.ruleIntentNode`；
- `pageEditAgent.isVagueImageAddition`；
- `locateComponents`；
- `patchPolicy.validateGeneratedEditResponse`；
- 大改计划中判断新增步骤 scope 的辅助逻辑。

纯新增任务固定行为：

```text
editScope = page
selectedComponentIds = []
allowedOperationKinds = addComponent + 必要的 updatePageStyle
```

不得开放：

```text
updateProps / updateStyle / placeRelative / removeComponent / moveLayer
```

`isVagueImageAddition` 必须读取统一动作分析结果。`放张图片`、`来张图片`等表达在缺少内容方向时允许触发一次 `MISSING_EXECUTION_DATA`；预算耗尽后使用 `use_model_defaults`。

## 5. 修复二：跨轮恢复接线

### 5.1 恢复 fallback 的确定性派生

新增 `server/ai/graph/pendingResume.ts`：

```ts
export const deriveResumeFallbacks = (input: {
  pendingTask: AIPendingTask
  relation: PendingRelation
  currentMessage: string
}): AutonomousFallback[]
```

该函数不能调用模型。输入 pendingTask 必须已经在 HTTP 边界验证。

无信息回答定义：

```text
delegate relation
或整句：是 / 可以 / 行 / 好的 / 继续 / 同意 / 没问题 / 嗯 / 好
```

固定映射：

| pending source/code | 当前回答 | resume fallback |
|---|---|---|
| `large_edit_planner + MISSING_EXECUTION_DATA` | delegate/无信息回答 | `use_conservative_plan(maxSteps=2, operationLimit=8)` |
| `component_locator/patch_generator + MISSING_EXECUTION_DATA` | delegate/无信息回答 | `use_model_defaults(allowedComponentIds=signed target IDs)` |
| `TARGET_AMBIGUOUS` | 任意有效回答 | 空；必须重新进入 Locator |
| `DELETION_AUTH_REQUIRED` | 任意回答 | 空；交给授权推导 |
| `GEOMETRY_RELAYOUT_AUTH_REQUIRED` | 任意回答 | 空；重新执行并以实际闭包决策 |
| `CONFLICTING_REQUIREMENTS` | delegate/无信息回答 | large 使用保守计划；local 无安全子集时 no_change |

用户提供了具体补充信息时，优先使用补充信息重新生成计划，不强制应用保守 fallback；但 operationLimit 仍不得超过执行策略上限。

### 5.2 pageEditAgent 接线

`reduceTaskNode` 在 reduction.action 为 edit 时写入：

```ts
appliedFallbacks: reduction.resumeFallbacks
pendingConfirmationEvidence: reduction.pendingConfirmationEvidence
```

禁止继续无条件设置：

```ts
appliedFallbacks: []
```

新任务/replace 才清空 fallback 和确认依据。

### 5.3 TARGET_AMBIGUOUS 恢复

删除 `locateComponents` 当前的 resumed pending 直接 `proposalUpdate` 早返回。

替换为候选池逻辑：

```text
如果存在签名 candidateComponentIds：
  candidatePool = 当前页面中仍存在的签名候选
否则：
  candidatePool = 当前页面组件索引
```

然后按顺序：

1. 使用 `state.originalRequest` 对 candidatePool 做确定性排名；
2. 稳定 ID、精确名称、精确文案、唯一类型形成唯一领先时直接选择；
3. 否则将 candidatePool 和完整 task request 交给 Locator 模型；
4. `canClarify=false` 时 Schema 只允许 selection；
5. 模型技术失败后使用同一确定性排名兜底；
6. 没有可靠证据时返回 `execution_failed(NO_SAFE_TARGET_CANDIDATE)`；
7. 不得再次生成业务澄清。

签名候选只限制候选池，不能授权修改全部候选。

### 5.4 Large/Full 预算约束

Large Planner 重新生成 plan 后，现有 conservative fallback 必须：

```ts
steps = steps.slice(0, executionPolicy.maxPlanSteps)
step.operationBudget = Math.min(step.operationBudget, executionPolicy.operationLimit)
```

每个 Large step 实际调用 Local Graph 时再次执行：

```ts
operationLimit = Math.min(step.operationBudget, state.executionPolicy.operationLimit)
```

Full Relayout 每组不得继续硬编码无条件 `operationLimit=8`：

```ts
operationLimit = Math.min(8, state.executionPolicy.operationLimit)
```

跨请求不恢复旧 plan；不引入 plan 序列化。

## 6. 修复三：删除授权和组件范围

### 6.1 授权证据来源

允许的来源只有：

1. 根请求或追加的原始用户消息包含明确、未否定的删除动作；
2. 已签名 pending 的 code 为 `DELETION_AUTH_REQUIRED`，本轮原始回答是明确肯定，并且 pending 已保存稳定目标 ID。

禁止的来源：

- 模型 route reason；
- Planner instruction/summary；
- effectiveTaskRequest 中的服务端合成语句；
- ClarificationProposal 的自然语言 question 单独出现；
- fallback；
- conversation memory；
- 当前页面内容或组件名称自身包含“删除”。

### 6.2 肯定与否定回答

明确肯定：

```text
是 / 可以 / 行 / 好的 / 继续 / 同意 / 没问题
```

明确否定：

```text
不 / 不可以 / 不行 / 不同意 / 不要 / 不允许 / 不能 / 保留 / 别删
```

判定顺序：否定优先于肯定。

上下文确认成立的全部条件：

```text
pendingConfirmationEvidence.clarificationCode = DELETION_AUTH_REQUIRED
relation = answer
rawUserReply 整句命中肯定规则
signedTargetComponentIds 非空
这些 ID 当前仍存在
```

其中任一条件不满足，都不能开放删除。

### 6.3 删除目标解析

新增 preflight 辅助节点或纯函数组合 `resolveDeletionScope`，复用现有组件索引和排名逻辑：

```text
明确删除请求
  -> buildAIComponentIndex
  -> rankComponentCandidates
  -> 解析稳定 ID/精确名称/精确文案/唯一类型
  -> 得到 authorized component IDs
```

规则：

- `删除这个按钮` 且页面只有一个 Button：授权该 Button；
- `删除页脚按钮` 且名称/文案唯一：授权唯一匹配；
- 多个同类型组件且没有唯一证据：产生 `TARGET_AMBIGUOUS` 或 `DELETION_AUTH_REQUIRED` proposal；
- `删除不需要的组件`：没有稳定范围，不授权全部组件；
- 用户明确说“删除所有图片”时，只有当前请求确实表达全部，才允许解析为所有 Image；
- 最多 12 个删除目标；超过上限返回 no_change 或要求缩小范围；
- full relayout 也必须先解析删除范围，不能因为整页重构而把每个分组都加入删除授权。

不得新建独立的模糊名称匹配算法；必须复用 Locator 的排名、证据和稳定排序。

proposal 与签名顺序必须固定：

1. 先解析并验证当前页面仍存在的 target/candidate IDs；
2. 将 target/candidate IDs 写回活动 `task`；
3. 再创建 `TARGET_AMBIGUOUS` 或 `DELETION_AUTH_REQUIRED` proposal；
4. Broker 使用更新后的 task 创建并签名 pendingTask。

其中：

- 用户已经明确要求删除，但目标不唯一时使用 `TARGET_AMBIGUOUS`；用户下一轮选定目标后，授权仍来自原始明确删除请求；
- 用户没有明确要求删除，但执行器判断删除可能是必要步骤时使用 `DELETION_AUTH_REQUIRED`；此时必须先有唯一、有限的 target IDs，才能询问是否授权；
- 没有 target IDs 的 `DELETION_AUTH_REQUIRED` proposal 属于无效 proposal，必须转为 no_change 或 execution_failed，不能签名空范围删除确认。

### 6.4 Schema 和 Patch Policy

进入 Local Graph 的每个组件 scope 计算：

```ts
allowedDeleteIds = intersection(
  selectedComponentIds,
  executionPolicy.deleteAuthorization.componentIds
)
```

Full Relayout 每组同样与当前 group IDs 取交集。

只有 `allowedDeleteIds.length > 0` 时：

- `allowedOperationKinds` 才包含 `removeComponent`；
- 动态 Schema 才创建 `removeComponent` 分支；
- `componentId` enum 只能是 allowedDeleteIds。

`patchPolicy` 必须再次校验 removeComponent 的 ID 位于允许集合中。Patch Executor 保留“页面至少一个组件”的最终防线。

## 7. 修复四：Geometry overflow

### 7.1 闭包算法

`collectGeometryConflictClosure` 固定执行：

```text
uniqueSeeds = 去重后的初始变更组件
overflow = uniqueSeeds.length > maxComponents
queue = uniqueSeeds.slice(0, maxComponents)
affected = queue IDs

遍历 queue：
  收集所有直接冲突
  如果发现新的 otherId：
    affected.size < maxComponents -> 加入 affected 和 queue
    affected.size >= maxComponents -> overflow = true，不加入 queue
```

即使 overflow，也允许记录第 13 个冲突的概要用于日志，但不得把第 13 个组件加入自动修复范围。

### 7.2 决策

```text
overflow=false
  -> 允许最多 12 个组件的局部修复或 limit_geometry_scope

overflow=true && clarificationUsed=0
  -> Broker 接收 GEOMETRY_RELAYOUT_AUTH_REQUIRED
  -> fallback 固定 return_no_change

overflow=true && clarificationUsed=1
  -> 直接 no_change
  -> 不生成 limit_geometry_scope
  -> 不再次提问
```

`GeometryConflictError`、日志和测试断言都必须包含 overflow。

### 7.3 循环保护

- overflow proposal 的 fallback 与非 overflow proposal 不同，因此 proposalId 自然不同；
- 相同 overflow proposal 再次出现时命中 handledProposalIds，归一化为 no_change；
- 不允许通过分批选择不同的 12 个组件绕过总闭包上限。

## 8. 修复五：Locator 技术容错

### 8.1 技术错误分类

以下情况属于技术失败：

- `OpenRouterError` 的 `TIMEOUT`、`CONNECTION_FAILED`、`EMPTY_RESPONSE`、`OUTPUT_TRUNCATED`、`INVALID_JSON`；
- 可重试的 429/5xx 上游错误；
- JSON 结构存在但不满足 Locator 协议；
- selection 引用候选池之外的 ID；
- selection 在 components scope 下没有任何 ID。

以下情况不得重试：

- `config.signal.aborted`；
- `OpenRouterError.code === 'ABORTED'`；
- `UNAUTHORIZED`；
- 明确不可重试的 4xx Schema 拒绝。

### 8.2 调用顺序

```text
准备候选池
  -> Locator 模型 attempt 1
      -> 合法 selection：完成
      -> 合法 need_clarification 且 canClarify=true：提交 proposal
      -> 技术失败：attempt 2
  -> attempt 2 仍技术失败
      -> 确定性排名兜底
          -> 有可靠唯一证据：选择
          -> 无可靠证据：execution_failed(LOCATOR_MODEL_FAILED)
```

`canClarify=false` 时 Locator schema 只允许 selection。即使模型绕过 Schema 返回 need_clarification，也按非法协议技术失败处理，不能提交 proposal。

### 8.3 RAG 降级

`retrieveCandidates` 抛出非 Abort 错误时：

- 使用完整本地 componentIndex；
- 执行真实词法/类型/空间排序；
- 记录 warning 或 routing trace；
- 不消耗澄清预算。

### 8.4 错误传播

Locator 最终失败返回：

```ts
{
  status: 'error',
  result: {
    type: 'execution_failed',
    runId,
    code: 'LOCATOR_MODEL_FAILED',
    message: '暂时无法可靠定位需要修改的组件。',
    retryable: true,
    pendingTask: state.pendingTask
  }
}
```

现有 Local Graph 的 `afterLocate` 已检查 `state.result`，因此不新增条件边；需要增加测试证明结果会经过 Large/Full 和主图原样传播。

Abort 必须继续抛出或让顶层 controller 检测后静默结束，不能转换为 execution_failed，也不能重试。

## 9. 修复六：上下文状态过滤

### 9.1 前端

`AIGenerator.vue` 构建 request snapshot 时：

```ts
requestMessages = session.recentMessages.filter(
  message => message.status === 'completed'
)
```

UI 和 localStorage 仍保留所有消息。失败重试继续创建新消息 ID。

### 9.2 HTTP 边界

`editPageHandler.messagesFrom`：

1. 先做现有结构、长度和 role 校验；
2. 旧消息缺少 status 时默认 `completed`；
3. 只返回 `status === 'completed'` 的消息；
4. 过滤后再截取最后 6 条，而不是先截取再过滤。

正确顺序：

```ts
normalize all bounded inputs
  -> filter completed
  -> slice(-6)
```

否则最后 6 条里大量失败消息可能挤掉更早的有效上下文。

### 9.3 下游保证

Graph state 的 `recentMessages` 从入口开始就是干净集合，因此以下节点不再自行重复过滤：

- Context/Tool Router；
- answerQuestion；
- Component Locator 的 RAG query；
- Large Edit Planner；
- Patch Generator。

单元测试直接调用节点时，测试工厂仍应传入干净消息；另保留一个防御性测试验证 API 边界过滤。

## 10. LangGraph 状态与路径

### 10.1 新任务

```text
message
  -> route
  -> reduceTask(new task, no confirmation, no resume fallback)
  -> preflight action/deletion scope
  -> broker if needed
  -> derive policy
  -> execute
```

### 10.2 TARGET_AMBIGUOUS 恢复

```text
verified pending + current answer
  -> route relation=answer/supplement/delegate
  -> reduceTask stores confirmation evidence, resumeFallbacks=[]
  -> Locator restricts candidate pool to signed candidates
  -> current answer participates in rank/model selection
  -> unique selection or technical failure
  -> never second clarification
```

### 10.3 Planner 委托恢复

```text
verified planner pending + “随便”
  -> relation=delegate
  -> resumeFallbacks=[use_conservative_plan]
  -> derive policy maxPlanSteps=2, operationLimit=8
  -> regenerate plan with plan-only schema
  -> truncate and execute bounded plan
```

### 10.4 删除确认恢复

```text
verified deletion pending + “可以”
  -> reduceTask stores signed target IDs and raw reply
  -> derive delete authorization from confirmation evidence
  -> schema exposes removeComponent only for signed IDs in current scope
```

```text
verified deletion pending + “不可以”
  -> deleteAuthorization.authorized=false
  -> safe non-delete subset or no_change
```

## 11. 文件级实施清单

### 新增

- `server/ai/graph/editActionAnalysis.ts`
  - 分句、动作 span、邻近否定、组件类型提示；
  - `analyzeEditActions`；
  - `isPureAddRequest` 薄封装可迁移到此处。
- `server/ai/graph/pendingResume.ts`
  - `deriveResumeFallbacks`；
  - 无信息回答判定；
  - pending confirmation evidence 构造辅助函数。
- `server/ai/__tests__/editActionAnalysis.spec.ts`
- `server/ai/__tests__/pendingResume.spec.ts`
- `server/ai/__tests__/geometryClosure.spec.ts`
- `server/ai/__tests__/locatorRecovery.spec.ts`

### 修改

- `src/types/aiPatch.ts`
  - 增加 `PendingConfirmationEvidence`、`DeleteAuthorization`；
  - 扩展 `ExecutionPolicy`；
  - 保持 `AIPendingTask` 客户端协议不变。
- `server/ai/graph/pageEditState.ts`
  - 增加 `pendingConfirmationEvidence`；
  - 初始化为 null；
  - 新任务/replace 时清理。
- `server/ai/graph/taskReducer.ts`
  - edit reduction 返回 resumeFallbacks 和 confirmation evidence；
  - pending 消费前保存已验证澄清上下文。
- `server/ai/graph/pageEditAgent.ts`
  - 接入 reduction 返回值；
  - preflight 接入统一动作分析和删除范围解析；
  - 不再无条件清空恢复 fallback。
- `server/ai/graph/autonomousFallback.ts`
  - 复用新的动作分析；
  - 保留候选排名和 proposal ID；
  - 删除重复新增正则。
- `server/ai/graph/locateComponents.ts`
  - pending candidates 改为候选池；
  - 当前回答参与排名；
  - 模型重试和确定性兜底；
  - 技术错误与业务 proposal 分离；
  - 删除操作 ID 与授权范围取交集。
- `server/ai/graph/executionPolicy.ts`
  - 推导 DeleteAuthorization；
  - 读取 PendingConfirmationEvidence；
  - 推导 maxPlanSteps/operationLimit；
  - 否定回答优先。
- `server/ai/graph/patchPolicy.ts`
  - removeComponent 必须属于 authorized IDs；
  - pure-add 继续做硬限制。
- `server/structuredSchemas.ts`
  - removeComponent schema 接收独立 allowedDeleteIds；
  - 不因普通 componentIds 存在就开放删除。
- `server/ai/graph/largeEditGraph.ts`
  - plan steps 和 operationBudget 读取 policy；
  - 每步预算再次取最小值。
- `server/ai/graph/fullRelayoutGraph.ts`
  - 每组 operationLimit 读取 policy；
  - remove IDs 与 group IDs 取交集。
- `src/domain/pagePatchExecutor.ts`
  - Geometry closure 返回 overflow；
  - GeometryConflictError 携带 overflow；
  - 种子数量先判断。
- `server/ai/graph/localEditGraph.ts`
  - 根据 overflow 选择 fallback；
  - Locator execution_failed 保持传播；
  - geometry proposal 不得二次提问。
- `server/ai/http/editPageHandler.ts`
  - API 边界过滤非 completed 消息；
  - 过滤后 slice；
  - 保留 pending HMAC 验证顺序。
- `src/components/AIGenerator.vue`
  - request snapshot 只发送 completed 历史；
  - UI 仍显示所有状态。
- `server/largeEditPlan.ts`
  - 统一新增步骤判断；
  - canClarify=false 的提示不得继续要求模型询问用户。

## 12. 分阶段实施

### Phase A：测试锁定与动作分析

1. 先为六个已确认缺陷写失败测试；
2. 新增 `editActionAnalysis.ts`；
3. 替换所有 pure-add 判断；
4. 验证 vague image 路径恢复；
5. 运行 type-check 和相关测试。

完成标准：所有纯新增表达进入 page scope，现有图片不会成为修改目标。

### Phase B：跨轮恢复与删除授权

1. 增加 PendingConfirmationEvidence；
2. 扩展 TaskReduction；
3. 实现 `deriveResumeFallbacks`；
4. 改造 pending candidate 早返回；
5. 接入 conservative Planner fallback；
6. 实现删除目标解析和 ID 范围；
7. 动态 Schema/Patch Policy 双重限制删除 ID。

完成标准：

- “英雄区那张”能在旧候选中选中目标；
- Planner 后“随便”只执行保守计划；
- 删除确认只开放签名目标；
- 删除拒绝不开放任何 removeComponent。

### Phase C：Geometry overflow

1. 修改闭包返回类型；
2. 增加 overflow 传播；
3. 修复 fallback 决策；
4. 增加 12/13/种子超过 12 的测试；
5. 验证不会通过分批闭包绕过限制。

完成标准：第 13 个组件必定触发 overflow，预算已用时直接 no_change。

### Phase D：Locator 技术容错

1. 增加错误分类和 Abort 判断；
2. 模型重试一次；
3. RAG 失败降级本地候选；
4. 确定性兜底；
5. execution_failed 跨 local/large/full/main 传播测试。

完成标准：技术失败不产生 proposal、不消耗预算、不重试用户取消。

### Phase E：上下文过滤和集成验证

1. 前端过滤 request messages；
2. HTTP 边界 normalize -> filter -> slice；
3. 验证 Router、QA、RAG、Planner 都只收到 completed；
4. 运行完整测试、type-check、build；
5. 手工验证截图场景和取消/重试场景。

## 13. 测试矩阵

### 动作识别

1. `放张图片` => pure add Image。
2. `加两张产品图` => pure add Image。
3. `来个按钮` => pure add Button。
4. `添加图片，不要替换现有图片` => pure add。
5. `不要替换，也不要删除，只要加图片` => pure add。
6. `新增图片并删除旧图` => 非 pure add。
7. pure add 页面已有唯一 Image 时，不能选择或修改该 Image。
8. vague pure add 第一次可澄清，第二轮 delegate 只新增。

### Pending 恢复

9. TARGET_AMBIGUOUS + `英雄区那张` 使用本轮回答排名。
10. 签名候选池外的 ID 不得被模型选中。
11. pending candidate IDs 失效时 pending 在 HTTP 边界被拒绝。
12. Planner + `随便` 应用 maxSteps=2。
13. Planner + `随便` 每步预算不超过 8。
14. Planner + 具体补充重新生成计划，但总预算不突破 policy。
15. replace 新任务不继承旧 fallback 或 confirmation evidence。

### 删除授权

16. `去掉唯一按钮` 解析到该按钮 ID。
17. `删除页脚按钮` 只开放页脚按钮。
18. `删除不需要的组件` 不授权全部组件。
19. DELETION pending + `可以` 只授权签名 target IDs。
20. DELETION pending + `不可以` 不开放 removeComponent。
21. 普通 pending + `可以` 不能形成删除授权。
22. 模型 plan/summary 含“删除”不能形成授权。
23. full relayout 每组只能删除授权 ID 与 group 的交集。
24. Patch 引用未授权删除 ID 时被 patchPolicy 拒绝。

### Geometry

25. 12 个组件闭包 overflow=false。
26. 第 13 个冲突组件 overflow=true。
27. 初始 seed 超过 12 时立即 overflow=true。
28. overflow + budget=0 只问一次且 fallback 为 no_change。
29. overflow + budget=1 直接 no_change。
30. overflow 不产生 limit_geometry_scope。
31. 相同 overflow proposal 不循环。

### Locator 技术状态

32. TIMEOUT 后重试一次。
33. INVALID_JSON 后重试一次。
34. 非法 selection ID 作为技术无效结果重试。
35. 两次失败但有精确名称证据时确定性选择。
36. 两次失败且无证据时 LOCATOR_MODEL_FAILED。
37. LOCATOR_MODEL_FAILED 保留合法 pendingTask。
38. ABORTED 不重试、不返回业务 proposal。
39. RAG 失败使用本地候选。
40. canClarify=false 时模型返回 need_clarification，按技术无效处理。

### 消息上下文

41. completed 消息进入 Graph。
42. failed 消息保留在 store，但不进入 Graph。
43. cancelled 消息保留在 store，但不进入 Graph。
44. processing 消息不进入 Graph。
45. 旧消息无 status 时按 completed 迁移。
46. 先过滤再 slice，失败消息不挤掉有效上下文。
47. Router、QA、RAG、Planner 接收到同一干净消息集合。

### 集成终态

48. `加点图片 -> 随便` 新增图片且不修改现有 Image。
49. 已签名 DELETION pending + `可以` 只删除已签名目标。
50. 已签名 DELETION pending + `不可以` 返回安全子集或 no_change。
51. Planner 澄清 -> delegate 后最多执行保守计划。
52. Locator 技术失败显示技术错误，不显示业务澄清。
53. 13+ 几何闭包不提交任何危险 draftPage。
54. cancelled 历史要求不影响下一轮路由。
55. 所有正常成功仍只产生一条可撤销历史命令。

## 14. 验收标准

以下条件必须全部满足：

1. 所有纯新增表达只能生成 addComponent/updatePageStyle；
2. 被否定的删除/替换词不会破坏纯新增识别；
3. pending 候选恢复时本轮回答真正参与目标选择；
4. Planner delegate 恢复后 conservative fallback 实际生效；
5. 删除授权同时具备可信来源和非空稳定 ID 范围；
6. 删除确认不能扩大到签名目标之外；
7. full relayout 不能因为全局意图获得全页面删除权限；
8. 几何闭包第 13 个组件可被明确检测；
9. overflow 不会被截断为安全闭包继续执行；
10. Locator 技术错误重试一次，仍失败才返回 execution_failed；
11. Locator 技术错误和 Abort 均不消耗业务澄清预算；
12. 只有 completed 历史消息进入全部下游上下文；
13. 用户消息仍永久保留，过滤上下文不等于删除 UI 记录；
14. pendingTask 客户端协议和 HMAC 覆盖字段保持不变；
15. `npm run type-check`、`npm run test:unit`、`npm run build` 全部通过；
16. 新增测试覆盖本 Spec 的 55 个场景或等价参数化断言。
17. 多个 conservative fallback 同时存在时，maxPlanSteps 和 operationLimit 使用最严格的最小值。
18. Broker 不得签名 targetComponentIds 为空的删除授权问题。

## 15. 建议提交拆分

```text
test(ai): lock review regression scenarios
fix(ai): classify pure add actions with scoped negation
fix(ai): reconnect pending resume fallbacks and candidate answers
fix(ai): scope deletion authorization to verified component ids
fix(ai): detect geometry closure overflow
fix(ai): retry locator technical failures with deterministic fallback
fix(ai): exclude incomplete messages from model context
test(ai): cover cross-round authorization and terminal propagation
docs(ai): document review fixes and final invariants
```

## 16. 实施注意事项

- 每个 Phase 完成后单独运行相关测试，避免到最后才发现状态字段没有接入 Graph Schema；
- 新增 state 字段必须同时更新类型、StateSchema、initial state 和新任务/replace 清理逻辑；
- 所有 pending 派生逻辑必须发生在 HMAC 验证之后；
- 不使用模型判断 clarification budget、fallback 或删除授权；
- 不把失败消息从 store 删除；
- 不通过扩大候选、扩大组件闭包或降低验证级别来提高“成功率”；
- 不将本次修复扩展为 LangGraph、SSE 或页面 Schema 的整体重写。
