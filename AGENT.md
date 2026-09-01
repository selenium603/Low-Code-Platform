# 项目交接说明（AGENT.md）

> 供后续 Codex/开发者快速理解并接手项目；更新时不要记录 `.env.local`、API Key 等敏感信息。

## 1. 项目定位

基于 **Vue 3 + TypeScript + Pinia + Element Plus + ECharts** 的低代码营销页面搭建平台：画布拖拽/缩放/旋转/层级、属性面板配置、PC/手机双端布局、命令模式撤销重做、JSON 导入导出、HTML 导出，以及 AI 生成/增量修改页面。

核心架构原则：**手工编辑、JSON 导入、AI 生成都落到同一套 Page Schema，由组件注册表 + Vue 组件渲染**。AI 只输出可编辑 Schema，不生成 Vue/HTML 源码。

## 2. 根目录与命令

根目录：`C:\Users\carol\Desktop\vue-yuan-drag-main\vue-yuan-drag-main`

```bash
npm install / npm run dev / npm run type-check / npm run build
```

修改 `vite.config.ts`（AI 中间件）后需重启 dev server；普通 src 文件 HMR 生效。

## 3. 关键文件地图

### 编辑器与渲染

- `src/components/Editor.vue`：入口与三栏布局；设备切换、撤销/重做、导入导出、新建页面；HTML 导出逻辑内联于此
- `src/components/EditorCanvas.vue`：画布缩放/拖放/移动/八方向缩放/旋转/网格/参考线/键盘微调；PC/手机适配
- `src/components/PropertyPanel.vue`：按组件协议 Schema 动态生成属性控件；支持手机样式恢复 PC 基准
- `src/components/PageRenderer.vue`：预览渲染、点击动作与表单提交
- `src/components/AIGenerator.vue`：AI 助手弹窗；生成/修改两种模式、多轮对话、SSE 进度与错误、撤销最近 AI 修改
- `src/components/components/registry.ts`：组件渲染映射 + 默认样式/属性 + 属性面板协议（组件库注册中心）

### 领域层与状态

- `src/domain/componentProtocols.ts`：六类组件的 `ComponentProtocol` 定义
- `src/domain/pageValidation.ts`：`validateAndRepairPageData` —— 不可信 JSON/AI 结果的校验、修复与迁移（`stores/pageImport.ts`、`services/pagePatchExecutor.ts` 均为其 re-export 入口）
- `src/domain/pagePatchExecutor.ts`：`applyAIPagePatch` / `validateAIPagePatch`，增量 Patch 白名单执行
- `src/types/index.ts`：PageData、ComponentData、Style、Props 等核心类型
- `src/stores/editor.ts`：当前页面/选中组件/设备/画布操作；localStorage key `marketing-editor-page`
- `src/stores/history.ts`：命令模式 undo/redo，最大 100 步，新命令清空 redo
- `src/stores/aiConversation.ts`：按 pageId 保存会话；最近 8 条消息 + 结构化记忆（用户目标/设计约束/已完成修改/未决问题）
- `src/stores/migration.ts`：Schema 迁移链，`SCHEMA_VERSION = '2026.05'`
- `src/utils/`：`chartOption.ts`（ECharts Option 唯一构建入口，编辑器/预览/HTML 导出共用）、`mobile.ts`（响应式常量与样式合并）、`textLayout.ts`（Text 最小高度估算）、`formLayout.ts`（Form 最小高度）

### AI 链路（Vite 开发中间件）

- `vite.config.ts`：注册 `aiPageGeneratorV2()`，提供 `POST /api/ai/generate-page`（两阶段生成 + SSE + 规范化校验 + 最多重试 3 次）与 `/api/ai/edit-page`
- `server/structuredSchemas.ts`：集中维护全部 strict JSON Schema（页面、布局计划、编辑响应、RAG 定位）；`strictResponseFormat`、`compactStructuredValue`（移除值为 null 的可选字段）
- `server/ai/graph/`：LangGraph 编辑 Agent —— `pageEditAgent.ts`（意图分流：局部/大幅/整页/提问）、`intentRouter.ts`、`localEditGraph.ts`、`largeEditGraph.ts`、`fullRelayoutGraph.ts`、`modelIntentRouter.ts`、`patchPolicy.ts`、`pageEditState.ts`、`pageChange.ts`
- `server/ai/context/`：`componentIndex.ts`（`buildAIComponentIndex`/`selectLocalPageComponents`）、`fullRelayoutGroups.ts`（整页重构分组）
- `server/componentRag.ts`：40+ 组件页面的 Embedding+关键词混合检索，失败降级本地关键词
- `server/largeEditPlan.ts`：大幅修改规划
- 前端入口：`src/services/aiPage.ts`、`src/services/aiEditPage.ts`

## 4. Page Schema 与组件模型

```text
PageData:      id / meta / style / components[] / responsiveOverrides
ComponentData: id / type / name / style / props / events / schemaVersion / responsiveOverrides
```

组件类型：`Text`、`Image`、`Button`、`Input`、`Form`、`Chart`。props 协议见 `src/types/index.ts`（Text.content；Image.src/alt/objectFit；Button.content/type；Input.placeholder/value/inputType；Form.title/submitText/fields；Chart.chartType/title/data + 图例/坐标轴/单位/主题色/tooltip）。

新增组件需同步：类型定义 → Vue 渲染组件 → registry 协议 → 导入校验修复 → AI 提示词/Schema → HTML 导出 → 双端布局边界 → Schema 迁移。

## 5. 核心数据流

- **手工编辑**：画布/组件库操作 → editor store → history 命令 → 视图响应 → localStorage
- **JSON 导入 / AI 结果**：parse → `validateAndRepairPageData`（迁移+校验+修复）→ 替换 store → 清空历史、重新适配画布
- **AI 生成**：需求 → 布局计划 → 生成 Page Schema（均 strict Structured Output）→ compact null → 服务端规范化 + 几何校验 → 失败带具体错误重试（≤3 次）→ SSE 返回 → 前端再校验 → 导入并选中
- **AI 增量修改**：Schema + 最近消息 + 结构化记忆 + baseRevision → LangGraph 分流 → 领域 Patch（稳定组件 ID，非数组下标）→ 页面副本执行+校验 → SSE 返回最终页面/澄清问题 → 前端校验 revision 后以**单条历史命令**提交（一次 undo 整体恢复）

## 6. 双端响应式模型

- `component.style` 为 PC 基准；`responsiveOverrides.mobile` 只存差异；渲染/提交时经 `getMergedStyle` 合并（`src/utils/mobile.ts`）
- 常量：`MOBILE_DEFAULT_MIN_HEIGHT=120`、`MOBILE_WIDTH_THRESHOLD=375`、`MOBILE_SMALL_BREAKPOINT=360`、`MOBILE_PADDING=12`、`MOBILE_AVAILABLE_WIDTH=351`
- 画布：PC 1200×820，手机 375×812（高度可增长），网格 10px，缩放约 0.3–2

**边界**：目前只解决横向适配（375 基准 + 小屏 clamp/min 规则），纵向仍是绝对定位——文本换行变高无法自动下推后续组件。下一阶段方向是手机普通组件改流式布局、装饰元素保留 absolute（涉及 Schema 语义字段，属架构升级，不能当 CSS 替换）。

## 7. AI 关键机制

- 所有结构化模型调用均用 **strict Structured Output（json_schema）**，不用 Function Calling；reasoning 关闭、temperature≈0.2、流式输出、**45s 空闲超时**（连续无数据块才超时，非固定总时长）
- 校验链：strict Schema → compactStructuredValue → normalizeDecorativeImages → normalizeForms → normalizeContentLayout → normalizeMobileLayout → basicPageError（含 mobilePageError）
- 重叠规则：普通内容严格 16px 间距；低层级 / 旋转 / 命名含背景装饰的 Image 允许受控重叠
- 增量 Patch Schema 每轮动态构建：`updateProps` 按目标组件真实类型约束属性，`componentId/targetId` 用当前允许 ID 枚举；`placeRelative` 只给方向、坐标应用计算；目标歧义返回 `need_clarification`，不猜测
- revision 检查：等待期间用户手工修改过则拒绝本次结果；Patch 均在页面副本执行，普通几何失败自动携带失败 Patch 请求一次修正版
- 大页面（>40 组件）：RAG 定位 + 局部上下文（≤16 组件完整 Schema）；明确整页重构按 `top→left→id` 确定性枚举分组
- 取消链路：前端 AbortController 取消 fetch，中间件监听 `res close` 中断上游模型请求；取消/失败不写记忆、revision、历史栈

## 8. 安全与部署

- 真实 API Key 只放 `.env.local`（参考 `.env.example`：`OPENROUTER_API_KEY`、`AI_MODEL`、`AI_PLANNING_MODEL`、`AI_RAG_ENABLED`、`AI_EMBEDDING_*` 等），禁止进前端 bundle/仓库/文档
- 当前 `/api/ai/*` 是 Vite 开发中间件，不等于生产后端；正式部署需迁移 BFF/Serverless，补鉴权、限流、日志、费用与异常监控

## 9. 已知边界与技术债

- `vite.config.ts` 过大（提示词/HTTP/SSE/规范化/校验混在一起），建议拆分
- HTML 导出内联在 `Editor.vue`，建议抽离
- 手机端非任意宽度连续响应式；390/414 等宽屏按最大 375px 居中
- 组件为扁平数组，无嵌套容器/组件树
- props 为静态数据，无真实 API/数据库绑定
- 无自动化测试体系；主包约 2.35MB（ECharts/Element Plus），建议按需分包

## 10. 修改代码时的注意事项

1. 结构变化先确认 Schema 向后兼容，必要时加迁移而非假设旧数据不存在
2. 组件能力改动要检查五条链路：编辑器、预览、JSON 导入、AI 生成、HTML 导出
3. PC 样式是基准，手机端只存差异
4. 布局修复区分普通内容与装饰元素，碰撞规则不可一刀切
5. AI 可靠性不能只靠提示词，应用侧校验与可确定修复必须保留
6. 不在高频 mousemove 中反复写历史命令
7. 改 AI 中间件后重启 dev server 再测
8. 不做破坏性 git 操作，保留无关改动
9. 密钥问题只检查变量是否存在，不输出值

## 11. 接手检查清单

阅读本文件 → 按任务读对应关键文件（不要只依赖 README）→ 查看 git 状态、保留已有修改 → 确认 `SCHEMA_VERSION` 与组件注册表协议 → AI 相关确认实际注册的是 `aiPageGeneratorV2()` → 手机端问题区分"横向宽度适配"与"纵向流式布局" → 改后跑 type-check/build + 相关人工回归 → 更新本文中过期内容

## 12. 一句话讲解

以统一 Page Schema 为核心的 Vue 3 低代码页面编辑器：手工编辑、JSON 导入、AI 生成共享同一数据协议；组件注册表驱动渲染与属性配置，命令模式保证可撤销，PC 基准 + 手机差异覆盖实现双端编辑；AI 通过"两阶段生成 + strict Structured Output + 应用侧规范化校验 + 分层反馈重试"把自然语言稳定转换成可继续编辑的页面。