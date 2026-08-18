# 项目交接说明（AGENT.md）

> 本文件用于让后续 Codex/开发者快速理解并接手项目，不替代工作区上层的 `AGENTS.md` 指令。
> 更新本文件时不要记录 `.env.local`、API Key 或其他敏感信息。

## 1. 项目定位

这是一个基于 **Vue 3 + TypeScript + Pinia + Element Plus + ECharts** 的低代码营销页面搭建平台。

核心能力包括：

- 在画布中拖拽、缩放、旋转、移动和调整组件层级；
- 通过属性面板配置组件内容、样式和事件；
- PC / 手机双端独立布局与实时预览；
- 基于命令模式的撤销与重做；
- 页面 JSON 导入、导出、本地保存和版本迁移；
- 导出可独立运行的 HTML；
- 根据自然语言生成可继续编辑的 Page Schema 页面；
- AI 生成过程包含两阶段规划、流式进度、规范化、校验、修复与重试。

项目最重要的架构原则是：**编辑器手工操作、JSON 导入和 AI 生成最终都落到同一套 Page Schema，再由现有 Vue 组件渲染。** AI 不直接生成 Vue/HTML 源码。

## 2. 项目位置与启动

当前实际项目根目录是：

```text
C:\Users\carol\Desktop\vue-yuan-drag-main\vue-yuan-drag-main
```

常用命令：

```bash
npm install
npm run dev
npm run type-check
npm run build
```

修改 `vite.config.ts` 中的 AI 中间件后需要重启开发服务器；普通 `src` 文件修改通常可由 HMR 生效。

## 3. 关键文件地图

### 编辑器与渲染

- `src/components/Editor.vue`
  - 编辑器入口和三栏布局；
  - 设备切换、撤销/重做、预览、AI 生成、JSON/HTML 导入导出、保存和新建页面；
  - 独立 HTML 导出逻辑目前也集中在此文件。
- `src/components/EditorCanvas.vue`
  - 画布缩放、拖放、移动、八方向缩放、旋转、网格、参考线、键盘微调；
  - PC/手机画布展示与自动适配；
  - 拖动期间临时更新视觉样式，鼠标释放时只提交一次历史命令。
- `src/components/PropertyPanel.vue`
  - 根据组件协议 Schema 动态生成属性控件；
  - 支持手机端样式恢复为 PC 基准样式。
- `src/components/PageRenderer.vue`
  - 预览页面、处理点击动作和表单提交。
- `src/components/AIGenerator.vue`
  - AI 页面助手弹窗；
  - 支持拖动标题栏调整弹窗位置；
  - 支持“生成新页面 / 继续修改”两种模式、多轮消息、进度、错误、清空对话和撤销最近一次 AI 修改。

### 数据与状态

- `src/types/index.ts`
  - `PageData`、`ComponentData`、组件类型、样式和响应式覆盖等核心类型。
- `src/stores/editor.ts`
  - 当前页面、选中组件、设备、不同设备缩放比例和编辑操作；
  - localStorage 持久化 key：`marketing-editor-page`；
  - 新建页面的初始 PC/手机布局。
- `src/stores/history.ts`
  - 命令模式撤销/重做，最大历史记录 100；
  - 新命令执行后清空 redo 栈。
- `src/stores/pageImport.ts`
  - 对不可信 JSON/AI 结果进行运行时校验、默认值补齐、安全修复和导入。
- `src/stores/aiConversation.ts`
  - 按 `pageId` 独立保存 AI 多轮会话；
  - 最近保留 8 条消息，更早消息压缩到滚动摘要；
  - 使用独立 localStorage，不污染页面 JSON。
- `src/stores/migration.ts`
  - Schema 迁移链；当前 `SCHEMA_VERSION` 为 `2026.05`。

### 组件协议

- `src/components/components/registry.ts`
  - 组件渲染映射；
  - 每种组件的默认样式、默认属性和属性面板协议。
- `src/components/components/`
  - Text、Image、Button、Input、Form、Chart 六类组件的具体实现。

### AI 生成

- `src/services/aiPage.ts`
  - 调用 `/api/ai/generate-page`，消费 SSE 进度、成功和失败事件。
- `src/services/aiEditPage.ts`
  - 调用 `/api/ai/edit-page`，传递当前 Schema、最近消息、滚动摘要和 page revision，消费增量修改 SSE。
- `src/services/pagePatchExecutor.ts`
  - 在 PageData 副本中校验并执行白名单 Patch，再交给统一导入修复。
- `src/types/aiPatch.ts`
  - AI 会话、增量 Patch、澄清响应和领域操作类型。
- `vite.config.ts`
  - 开发环境 AI 接口中间件；
  - 两阶段提示词、模型请求、SSE 解析、布局规范化、Schema 校验和重试均在此；
  - 当前真正注册的是 `aiPageGeneratorV2()`；文件顶部旧的 `aiPageGenerator` 未使用，是待清理技术债。
- `.env.example`
  - AI 环境变量示例。真实密钥应只放 `.env.local`，禁止提交或写入交接文档。
- `AI_PAGE_GENERATION_HANDOFF.md`
  - AI 页面生成专项历史交接材料，可作为补充阅读，但实现细节以当前代码为准。

### 其他

- `src/router/`：当前 `/` 路由进入编辑器。
- `README.md`：基础说明可能有少量滞后，例如 Schema 版本应以代码中的 `2026.05` 为准。

## 4. Page Schema 与组件模型

页面核心结构可概括为：

```text
PageData
├─ id
├─ meta
├─ style
├─ components: ComponentData[]
└─ responsiveOverrides

ComponentData
├─ id / type / name
├─ style
├─ props
├─ events
├─ schemaVersion
└─ responsiveOverrides
```

当前组件类型：`Text`、`Image`、`Button`、`Input`、`Form`、`Chart`。

组件注册表是扩展组件库的中心。新增组件时通常需要同步处理：

1. 类型定义；
2. Vue 渲染组件；
3. registry 的 renderer、默认样式、默认 props 和属性 Schema；
4. JSON 导入校验与修复；
5. AI 允许类型及提示词；
6. HTML 导出；
7. PC/手机布局和尺寸边界；
8. 必要的 Schema 迁移。

## 5. 核心数据流

### 手工编辑

```text
组件库/画布操作
→ editor store 修改 Page Schema
→ 命令对象进入 history
→ EditorCanvas / PropertyPanel 响应更新
→ localStorage 持久化
```

### JSON 导入

```text
外部 JSON
→ parse
→ validateAndRepairPageData
→ 类型、字段、ID、边界、响应式覆盖与版本迁移
→ 替换 editor store 页面
→ 清空旧历史并重新适配画布
```

### AI 生成

```text
用户自然语言
→ 第一阶段生成布局计划
→ 第二阶段按计划生成 Page Schema
→ 服务端规范化与布局校验
→ 不通过时把具体错误反馈给模型重试（最多 3 次）
→ SSE 返回页面
→ 前端 validateAndRepairPageData 再校验/修复
→ 导入 store，切回 PC 并选中首个组件
```

### AI 多轮增量修改

```text
用户继续提出修改
→ 发送当前 Page Schema + 最近 6 条消息 + 滚动摘要 + baseRevision
→ AI 只返回领域化 Patch 或澄清问题
→ 服务端校验操作白名单与稳定组件 ID
→ 前端在页面副本中执行并复用导入校验
→ 检查请求期间 revision 是否变化
→ 全部通过后作为一条历史命令提交
→ 可通过一次 undo 完整恢复
```

### 预览与导出

- 预览由 `PageRenderer.vue` 使用同一份 Schema 渲染；
- JSON 导出用于继续编辑和跨环境导入；
- HTML 导出生成独立页面，包含交互、表单校验、ECharts CDN 和移动端 CSS。

## 6. 编辑器交互与历史机制

- 默认 PC 画布：`1200 × 820`；
- 手机基准画布：`375 × 812`，页面高度可根据内容增长；
- 网格大小：10px；
- 画布缩放范围：约 0.3–2；
- 支持移动、缩放、旋转、图层调整、参考线和键盘微调；
- 新增、删除、移动、样式、属性、事件及图层操作均通过命令对象支持 undo/redo；
- 连续拖动时不能为每个 mousemove 都写历史，否则历史栈会爆炸；当前实现是在结束时提交一次。

完整替换页面后，`EditorCanvas` 会监听页面 id 并重新执行画布适配。

## 7. PC / 手机双端响应式模型

### 当前模型

- `component.style` 是 PC 端基准样式；
- `component.responsiveOverrides.mobile` 只保存与 PC 不同的字段；
- 渲染时通过 `getMergedStyle` / `getEffectiveStyle` 合并 PC 基准和手机覆盖；
- 手机端提交样式时，会与 PC 基准比较，只存差异；
- 这样可以避免复制整份样式，PC 后续修改也能自然传递到手机端未覆盖字段。

相关工具主要在 `src/utils/mobile.ts`。

当前重要常量：

```text
MOBILE_DEFAULT_MIN_HEIGHT = 120
MOBILE_WIDTH_THRESHOLD = 375
MOBILE_SMALL_BREAKPOINT = 360
MOBILE_PADDING = 12
MOBILE_AVAILABLE_WIDTH = 351
```

### 已完成的第一阶段低风险优化

- 接近满宽的组件在手机端使用 `width: calc(100% - 24px)`，左右各留 12px；
- 较窄组件使用 CSS `min()` / `clamp()` 和 `max-width`，避免小屏溢出；
- 手机页面容器使用 `width: min(100%, 375px)`；
- 导出 HTML 复用相同宽度策略；
- `<= 360px` 时移除外围留白、圆角和阴影，并用 `clamp()` 缩放文字、按钮和输入框字体；
- 新建页面的六个初始组件已有明确的手机端单列布局，手机页高约 1104px，避免初始组件重叠；
- AI 生成页面也会经过手机端单列规范化和重叠校验。

### 必须理解的边界

当前优化主要解决横向适配，纵向位置仍以绝对定位为主。仅把所有坐标和尺寸改成百分比不能完整解决问题，因为：

- 文本换行会改变实际高度，百分比无法自动把后续组件向下推；
- 表单、图表等组件有最小可用尺寸；
- 不同组件间距和视觉层级不是简单同比缩放；
- 装饰元素与内容元素需要不同布局规则；
- 绝对定位的多个百分比误差会累积，仍可能重叠。

下一阶段更合理的方向是混合布局：

- PC 继续使用自由绝对定位；
- 手机普通内容组件使用 flow/flex/grid 自动流式排布；
- 背景和装饰组件保留 absolute；
- Schema 可逐步增加 `layoutMode`、`order`、`widthMode`、`heightMode` 等语义字段。

这属于架构升级，不能当成简单 CSS 替换。

## 8. AI 页面生成实现

### 接口与模型请求

开发环境接口：`POST /api/ai/generate-page`。

环境变量示例：

- `OPENROUTER_API_KEY`
- `AI_MODEL`（示例为 `qwen/qwen3.7-plus`）
- `AI_PLANNING_MODEL`（可选）
- `AI_BASE_URL`

当前请求重点参数：

- `response_format: { type: "json_object" }`；
- reasoning 关闭；
- temperature 约 0.2；
- 主生成 `max_tokens` 约 3100；
- 流式响应；
- 约 45 秒空闲超时，会随数据块到达重置，不是固定总时长。

不要在项目介绍中声称当前已使用严格 Function Calling / JSON Schema 强约束。旧实现尝试过更严格的格式，但实际接口兼容性有问题；当前主要依靠 `json_object` 加应用侧校验修复。

### 两阶段生成

第一阶段 `createLayoutPlan` 只生成页面结构和布局计划，包括：

- 页面分区；
- 色彩与视觉方向；
- PC 端组件安排；
- 手机端排列策略。

规划阶段 token 较少、超时较短，失败时快速降级，避免显著增加等待时间。

规划阶段返回的组件矩形不能直接信任：`normalizeLayoutPlan` 会先把计划映射成临时组件，并复用桌面布局规范化规则修正边界、Form 尺寸和组件冲突，再把安全矩形交给第二阶段。Prompt 对“主视觉 Image + Form”明确使用左右双栏，避免批准一个本身不可执行的计划。

第二阶段根据该计划生成 4–6 个核心组件的完整 Page Schema。复杂页面相比单次生成更容易保持布局稳定。

### 规范化与校验链

模型 JSON 解析后，大致执行：

```text
normalizeDecorativeImages
→ normalizeForms
→ normalizeContentLayout
→ normalizeMobileLayout
→ basicPageError（内部包含 mobilePageError）
```

主要规则：

- 页面 PC 安全区按 `1200 × 820` 校验；
- 组件数量通常限制为 1–12；
- 组件类型必须在注册表允许范围内；
- 坐标、宽高、透明度必须是有效数值并满足边界；
- 普通内容组件保持至少 16px 间距；只移动无法解决冲突时，`normalizeContentLayout` 会按 Text/Image/Button/Input/Form/Chart 的语义最小尺寸逐级缩放，再寻找距离原计划最近的合法空位；
- 装饰图片可与内容重叠，但会被识别、限制到画布并调整图层；
- Form 的 PC 最小尺寸约 `320 × 420`；
- 手机端按 375px 基准、12px 边距、351px 可用宽度整理为单列；
- 手机页高根据内容动态增长；
- 手机端再次检查越界、最小尺寸和重叠。

仍有错误时，会把具体错误追加到下一轮提示词中，最多生成 3 次。前端收到结果后还会通过 `validateAndRepairPageData` 做第二道校验，因此服务端布局校验与前端 Schema 安全校验是分层互补的。

## 9. JSON 安全、迁移与事件

`pageImport.ts` 不直接信任外部 JSON，会处理：

- 非法或缺失字段；
- 不支持的组件类型；
- props、style、events 和 responsive override 类型；
- 重复/非法组件 ID；
- Form 字段和 Chart 数据结构；
- 组件协议默认值；
- Schema 版本迁移。

组件 ID 还会被清理，以便安全用于 DOM/CSS。预览点击跳转只接受受支持的 HTTP/HTTPS 地址。

### AI 增量 Patch 协议

增量修改不使用数组下标形式的通用 JSON Patch，而使用稳定组件 ID 和领域操作。当前支持：

- `updateProps`
- `updateStyle`
- `updatePageStyle`
- `placeRelative`
- `addComponent`
- `removeComponent`
- `moveLayer`

模型无权修改组件 ID。`placeRelative` 只描述“上方/下方/左侧/右侧”等关系，具体坐标由应用计算。目标存在歧义时，接口返回 `need_clarification`，不能猜测修改对象。

编辑器维护单调递增的 `pageRevision`。AI 请求返回时若 revision 已变化，说明用户在等待期间进行了手工编辑，本次 Patch 会被拒绝，避免覆盖新操作。一次 Patch 在页面副本上完整执行，通过后由 `applyAIPagePatchTransaction` 作为一条命令进入历史栈。

### 40+ 组件的大页面局部上下文

小于等于 40 个组件时继续使用原有单次增量修改路径，避免增加普通页面等待时间。超过 40 个组件时，服务端改用两阶段编辑：

1. `buildAIComponentIndex` 只提取组件稳定 ID、类型、名称、短文案和 PC/手机矩形；
2. 第一轮模型只从压缩索引中选择最多 12 个目标 ID，歧义或范围过大时返回澄清问题；
3. `selectLocalPageComponents` 根据目标 ID 补充数组邻居和桌面空间近邻，最多加载 16 个组件的完整 Schema；
4. 第二轮模型只接收页面外壳、目标组件和局部邻居，并生成领域 Patch；
5. `validateAIEditResult` 会限制 Patch 只能修改定位阶段选中的稳定 ID，邻居只用于判断布局，不能被顺带修改。

前端到本地 Vite 中间件的 HTTP 请求仍携带完整页面，以便服务端做 ID、revision 和最终 Patch 校验；被压缩的是发给模型的上下文。迁移到生产 BFF 后可进一步把页面 Schema 存在服务端，前端只传 `pageId + revision + message`。

### AI 请求取消链路

- AI 空闲时关闭弹窗会直接关闭；生成或修改请求进行中时，所有弹窗关闭入口都会提示“关闭将取消本次 AI 请求”；
- 用户确认后，`AIGenerator.vue` 通过当前请求的 `AbortController` 取消前端 `fetch`；取消属于终止而非暂停，不能恢复本次请求；
- 关闭确认框显示期间，已经返回的模型结果会等待关闭决策，防止响应与确认操作竞态；确认取消后即使响应已经到达也不会导入页面或应用 Patch；
- Vite AI 中间件监听响应连接关闭，并把取消信号传给布局规划和主生成/修改的上游 `fetch`，从而尽快中断模型请求；
- 增量修改被取消时会移除本轮尚未完成的用户消息，取消异常不展示为生成失败，也不会写 revision、历史栈或页面持久化结果。

## 10. AI 与生产环境安全

- 真实 API Key 只能存在 `.env.local` 或生产环境密钥管理中；
- 不能把 key 放进前端 bundle、仓库、截图或交接文档；
- 当前 `/api/ai/generate-page` 是 Vite 开发中间件，不等于生产后端；
- `/api/ai/edit-page` 同样是 Vite 开发中间件，生产部署时应与生成接口一起迁移；
- 正式部署应迁移到 BFF/Serverless，并增加鉴权、限流、日志、费用控制和异常监控；
- 不要对外宣称已经完成生产级 AI 服务部署。

## 11. 当前验证状态

最近完成移动端第一阶段优化后已通过：

```bash
npm run type-check
npm run build
```

AI 多轮增量修改也已完成一次真实链路回归：模型通过稳定 ID 返回单个 `updateStyle` 操作，页面成功修改；随后使用“撤销本次 AI 修改”恢复原状态，会话清理和 revision 更新正常，浏览器控制台无错误。

AI 取消链路已做浏览器回归：空闲关闭不弹确认；请求中关闭会弹确认；确认取消后弹窗关闭，页面 revision 不增加、目标组件未变化、未完成消息不进入会话，浏览器控制台无错误。回归中还覆盖了“模型在关闭确认框停留期间返回”的竞态。

AI 新页面布局修复后完成真实链路回归：使用“主标题 + 产品主视觉图 + 卖点说明 + 联系表单 + CTA”的蓝紫科技落地页需求，第一轮即成功生成并载入 6 个组件；桌面主视觉与表单双栏无重叠，手机端按 375px 单列排列，浏览器控制台无错误。

大页面局部上下文已使用 81 个合成组件完成真实模型回归：定位阶段只命中 `comp-73`，局部阶段加载 16 个组件，Patch 阶段第一次即返回只修改 `comp-73` 的 `updateProps` 操作。

构建存在非阻塞警告：主 JS 包约 2.35 MB，超过 500 kB 建议阈值，主要可能来自 ECharts 和 Element Plus。后续可通过按需加载、动态 import 或 `manualChunks` 优化。

当前没有完善的自动化测试体系。修改核心逻辑后至少应执行 type-check 和 build，并人工检查：

1. 新建页面 PC/手机布局；
2. 组件拖拽、缩放、旋转；
3. 属性修改和手机差异样式；
4. undo/redo；
5. JSON 导入导出；
6. HTML 导出及手机小屏；
7. AI 生成成功、失败提示和重试；
8. Form、Chart 和装饰图片的边界场景。

## 12. 已知边界与技术债

- `vite.config.ts` 过大，同时承载提示词、HTTP、流式解析、规范化和校验，建议拆分到独立 server 模块；
- 文件顶部仍有未使用的旧 `aiPageGenerator`；
- HTML 导出逻辑较大且内联在 `Editor.vue`，适合抽离；
- 手机端仍是“375 基准 + 小屏规则 + 绝对纵向布局”，不是任意手机宽度下的完全连续响应式；
- 390/414 等宽屏手机目前通常是最大 375px 居中显示；
- 旧 localStorage 页面不会因为新默认布局而被自动重写，新建页面才使用最新初始布局；
- 页面组件为扁平数组，目前没有嵌套容器/组件树；
- 还没有真实 API/数据库数据绑定，props 主要是静态数据；
- AI 输出的是可编辑 Schema，不是直接代码；
- 项目没有完整 E2E/单元测试；
- README 的个别版本描述可能滞后，应以类型和迁移代码为准。

## 13. 修改代码时的注意事项

1. 先确认是否会破坏 Page Schema 向后兼容；涉及结构变化时增加迁移，而不是直接假设旧数据不存在。
2. 组件相关能力要检查编辑器、预览、JSON 导入、AI 生成和 HTML 导出五条链路。
3. PC 样式是基准；手机端只存差异，避免把完整 PC 样式复制到 mobile override。
4. 布局修复应区分普通内容与装饰元素，不能用同一种碰撞规则。
5. 不要让 AI 只靠提示词保证正确，应用侧校验和可确定修复必须保留。
6. 不要在高频 mousemove 中反复写 Pinia 历史命令。
7. 修改 AI 中间件后重启 dev server，再测试真实生成。
8. 保留用户工作区中与当前任务无关的改动，不做破坏性 git 操作。
9. 任何密钥问题只检查变量是否存在，不输出变量值。

## 14. 推荐后续优先级

### P1：手机端混合布局

为普通内容引入流式布局语义，装饰元素保留绝对定位，解决文本高度变化导致的纵向重叠。

### P1：拆分 AI 服务代码

把 `vite.config.ts` 中的 prompt、provider client、SSE、normalizer、validator 拆成可测试模块，并补充布局修复单元测试。

### P2：导出链路复用

让编辑器、预览和 HTML 导出共享更多样式/事件规则，降低三处实现漂移。

### P2：性能优化

对 ECharts、Element Plus 和编辑器非首屏模块做按需加载和分包。

### P2：测试体系

优先覆盖 Schema 迁移、导入修复、命令历史、移动端布局规范化和 AI 错误反馈重试。

## 15. 下一窗口接手检查清单

开始新任务前建议按顺序执行：

1. 阅读本文件；
2. 根据任务阅读对应关键文件，不要只依据 README；
3. 查看当前 git 状态，保留用户已有修改；
4. 确认实际 `SCHEMA_VERSION` 和组件注册表；
5. 若涉及 AI，确认真正注册的是 `aiPageGeneratorV2()`；
6. 若涉及手机端，区分“横向宽度适配”和“纵向流式布局”两个问题；
7. 修改后运行 type-check/build，并做相关人工回归；
8. 更新本文件中因实现变化而过期的部分。

## 16. 一句话讲解口径

这是一个以统一 Page Schema 为核心的 Vue 3 低代码页面编辑器：手工编辑、JSON 导入和 AI 生成共享同一数据协议，编辑器用组件注册表驱动渲染和属性配置，用命令模式保证可撤销操作，用 PC 基准加手机差异覆盖实现双端编辑，并通过“两阶段生成 + 应用侧规范化校验 + 最多三次反馈重试”把自然语言稳定转换成可继续编辑的页面。
