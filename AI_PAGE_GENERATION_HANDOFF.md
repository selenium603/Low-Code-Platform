# AI 自然语言生成页面：交接与面试说明

## 1. 功能目标

在低代码页面编辑器中新增 AI 生成入口：用户输入一句自然语言需求，例如“生成一个简单的商品筛选页”，平台调用 OpenRouter 的 `qwen/qwen3.7-plus`，返回符合现有页面协议的 JSON，再导入当前编辑器。生成结果可以继续拖拽、缩放、改属性、撤销/重做、切换 PC/手机端以及导出 HTML。

核心原则是：**模型不输出 Vue/HTML 代码，而是输出项目已有的 Page Schema（JSON）**。渲染和编辑能力仍由组件注册表、现有画布和属性 Schema 负责。

---

## 2. 当前架构与数据流

```text
用户输入需求
  -> AIGenerator.vue（弹窗、进度、错误提示）
  -> src/services/aiPage.ts（读取服务端 SSE 进度）
  -> Vite dev middleware: POST /api/ai/generate-page
  -> OpenRouter / qwen/qwen3.7-plus（流式 JSON 输出）
  -> 服务端协议、几何和布局校验 + 可安全修复
  -> editorStore.importGeneratedPage()
  -> EditorCanvas.vue 重算缩放并渲染为现有 Vue 组件
```

相关文件：

- `src/components/AIGenerator.vue`：AI 输入弹窗、进度文本、错误提示、成功导入。
- `src/services/aiPage.ts`：客户端消费 SSE `progress / success / error` 事件。
- `vite.config.ts`：开发环境 API、中转 OpenRouter、流式响应聚合、重试、服务端校验。
- `src/stores/editor.ts`：`importGeneratedPage`，与普通 JSON 导入复用数据修复逻辑，但确保至少有一个可渲染组件。
- `src/components/EditorCanvas.vue`：监听整页 `id` 变化，AI 整页替换后强制重新适配画布。
- `.env.example`：无密钥模板。真实 Key 只放 `.env.local`，不可提交。

环境变量：

```env
OPENROUTER_API_KEY=
AI_MODEL=qwen/qwen3.7-plus
AI_BASE_URL=https://openrouter.ai/api/v1
AI_REASONING_ENABLED=false
```

页面生成请求本身已固定 `reasoning: false`；`AI_REASONING_ENABLED` 保留为环境配置说明，不会使当前生成接口重新打开 reasoning。

---

## 3. Page Schema 与模型输出约束

AI 输出根对象：

```ts
{
  id,
  meta: { title, description, createdAt, updatedAt, version: '2026.05', scene },
  style: { width: 1200, height: 820, backgroundColor },
  components: ComponentData[]
}
```

当前允许组件类型：`Text`、`Image`、`Button`、`Input`、`Form`、`Chart`。

每个组件至少包含：

```ts
{
  id, type, name, schemaVersion: '2026.05',
  style: { top, left, width, height, zIndex, rotate, opacity },
  props,
  events: [{ type: 'click', config: { action: 'none' } }]
}
```

不同组件的 `props` 协议由现有组件注册表定义：

- `Text`: `content`
- `Button`: `content`, `type`
- `Input`: `placeholder`, `value`, `inputType`
- `Image`: `src`, `alt`, `objectFit`
- `Form`: `title`, `submitText`, `fields`
- `Chart`: `chartType`, `title`, `data`

当前系统提示词位于 `vite.config.ts` 的 `aiPageGeneratorV2` 中。它采用折中策略：保留完整根对象、组件属性映射、布局规则和页面骨架示例；限制生成 `3~5` 个核心组件，避免过长提示词和过大的 JSON 使 Qwen 响应变慢。

---

## 4. 已完成的调整过程（按问题演进）

### 4.1 从普通 LLM 调用改为 Schema JSON

最初目标是“自然语言生成可编辑页面”。实现时没有让模型生成 HTML/Vue，而是要求返回 Page Schema。这样避免了 AI 代码无法接入画布的问题，也能复用组件协议、属性面板、预览和导出能力。

OpenRouter 的严格 `json_schema` / Function Calling 在该模型路由上曾出现 `400`。因此最终采用兼容性更高的：

```ts
response_format: { type: 'json_object' }
```

然后将强校验放在服务端完成。这是“结构化输出 + 应用侧校验”的方案，而非依赖模型一次性严格满足 JSON Schema。

### 4.2 增加服务端校验、纠错重试与错误信息

服务端会检查：

- 页面对象、组件数组与组件数量；
- 组件类型是否合法；
- `top/left/width/height/zIndex/rotate/opacity` 是否为数值；
- 页面是否固定为 `1200 × 820`；
- 普通内容组件是否越出安全区、是否出现非预期重叠；
- 旋转图片是否为合理的底层装饰。

校验失败不会直接导入，而是把具体原因追加到下一轮用户提示词，例如“组件 A 与组件 B 重叠或间距不足 16px”，最多尝试 3 次。最终错误会以可读中文展示在弹窗中。

### 4.3 修复“生成成功但画布没有显示”

发现“接口返回成功”不等价于“画布有可渲染内容”。新增 `editorStore.importGeneratedPage()`：

- 与普通 JSON 导入共用 `validateAndRepairPageData`；
- 若修复后组件数为 0，直接抛出明确错误；
- 成功后选中第一个组件；
- 导入 AI 结果时切换到 PC 设备画布；
- `EditorCanvas.vue` 监听页面 `id`，即使新旧页面尺寸与组件数相同，也强制重新 `fitToViewport(true)`。

### 4.4 增加过程反馈

客户端和服务端使用 SSE 传递阶段信息。用户能看到：

1. 已收到需求，正在规划页面结构；
2. 正在请求 Qwen（第 N/3 次）；
3. Qwen 已响应，正在生成页面结构；
4. 正在接收并校验 JSON；
5. 校验失败、网络失败或接口拒绝后的重试原因；
6. 成功导入的真实组件数量与自动修复数量。

### 4.5 排查并修复超时：从“等完整响应”改为流式读取

曾出现 60/90 秒超时。先关闭了 reasoning、降低温度和输出上限，但仍有偶发超时。

实际诊断（未输出 Key）表明：

- 最小请求：约 1.3 秒，HTTP 200；
- 当前真实提示词 + “生成一个简单的商品筛选页”：约 1.4 秒收到首个流式数据块，约 26.6 秒完成，HTTP 200。

因此根因不是 Key 或模型不可用，而是旧实现使用 `await upstream.json()`，必须等模型完整完成后才有响应。Qwen 在流中持续输出较长内容时，容易被总时长超时中断。

当前改为：

```ts
stream: true
```

服务端 `collectStreamContent()` 聚合 OpenRouter SSE 中的 `delta.content`。超时也改为**连续 45 秒没有任何数据块**才触发；只要模型仍有输出，就继续等待并显示阶段提示。当前生成请求使用：

```ts
reasoning: { enabled: false }
response_format: { type: 'json_object' }
temperature: 0.2
max_tokens: 2800
stream: true
```

### 4.6 布局限制的取舍与自动修复

最初“所有组件不得重叠且必须在 40px 安全区”过于严格，不支持倾斜图片置于表单下方的视觉设计。

现行规则：

- 常规内容组件：位于 `left: 40~1160`、`top: 40~780` 的安全区内，间距至少 16px；
- 旋转 `Image`：可以作为低 `zIndex` 装饰图与上层内容重叠，并允许靠近完整画布边缘；
- 若旋转装饰图的原始矩形超出 `1200 × 820`，`normalizeDecorativeImages()` 会自动裁正其 `left/top/width/height` 至画布范围，保留旋转和层级，不再因为这种可恢复的小误差耗尽 3 次重试；
- 非装饰性组件越界或互相压住，仍被视为需要 AI 修正的错误。

---

## 5. 面试时可以怎么讲

### 一句话版本

“我把 AI 生成能力接在低代码编辑器已有的 Page Schema 上，让模型返回可编辑 JSON 而不是代码；服务端负责结构和布局校验、可恢复错误自动修正以及重试，前端通过流式进度展示生成状态，最终直接复用既有的组件渲染、属性配置和导出链路。”

### 常见追问与参考回答

**Q：为什么不用 AI 直接生成 Vue 或 HTML？**

A：直接生成代码不能自然接入编辑器的选中、拖拽、属性面板、设备适配和撤销/重做。JSON Schema 是编辑器的领域模型，AI 只负责生成领域数据，渲染器负责把数据映射到 Vue 组件，职责边界更稳定。

**Q：如何保证 AI 输出可靠？**

A：不把可靠性完全押在 Prompt 上。先使用 JSON Object 输出约束，再在服务端做组件类型、属性、画布边界、几何重叠等校验；失败时把具体错误回填到下一轮生成。对于装饰图片越界这种可安全恢复的问题，直接规范化数据，减少不必要的模型重试。

**Q：为什么没有继续使用 Function Calling 或严格 JSON Schema？**

A：曾尝试过，但该 OpenRouter/Qwen 路由返回过 400。最终选择兼容性更好的 JSON Object 输出，再由应用层校验。这体现了模型能力、供应商兼容性和业务可靠性的取舍；若生产环境的模型路由稳定支持严格 Schema，可以替换而不影响前后端整体架构。

**Q：超时怎么解决？**

A：首先通过直连诊断排除 Key 和模型不可用，再发现模型在持续输出但后端等待完整 JSON。随后改为流式读取并用“无数据空闲超时”代替总超时；同时关闭不必要的 reasoning、限制 token 和组件数，并将真实阶段状态推送给前端。

**Q：重叠校验会不会限制设计？**

A：不能用一刀切规则。普通内容重叠往往是布局错误，但旋转图片做底层装饰是合理设计。因此采用“内容严格、装饰受控”的策略：只有旋转图片、低 zIndex 才可以与内容重叠。

**Q：纯前端项目怎么安全地调用大模型？**

A：真正的生产环境不能把长期 OpenRouter Key 打进浏览器包。本项目的 Vite middleware 只适合本地开发；部署时应迁移到 Serverless/Edge Function/BFF，Key 存部署平台密钥库，并做鉴权、限流、审计和成本控制。纯静态托管若让用户在浏览器填写 Key，只能作为个人开发工具，不适合面向终端用户。

---

## 6. 当前状态、验证与使用方式

已验证：

- `npm run type-check` 已通过；
- OpenRouter 最小请求与真实提示词流式请求均获得 HTTP 200；
- 流式真实请求测得首数据块约 1.4 秒、完成约 26.6 秒；
- Key 从未写入 `.env.example` 或此文档。

每次修改 `vite.config.ts` 后，都必须停止并重新运行：

```bash
npm run dev
```

原因是 AI 接口是 Vite 开发服务器 middleware，不会仅靠浏览器热更新重载。

---

## 7. 下一步建议（优先级）

1. **两阶段生成（P1）**：第一轮只生成页面分区/布局计划，第二轮按该计划生成组件 Schema。复杂页面的布局稳定性会明显优于单次生成。
2. **局部 AI 编辑（P1）**：支持“把右侧改成商品列表”“只重生成表单区”。请求中带当前 Page Schema，只替换指定组件集合，避免整页重建。
3. **模型降级（P1）**：主模型空闲超时或限流后，自动换更快的备用 OpenRouter 模型；在前端显示实际使用的模型和重试原因。
4. **布局分析器（P2）**：将当前几何校验抽到独立模块，补充文本行数预估、组件最小尺寸、相邻对齐线等规则，并返回结构化修复建议。
5. **生产部署（P0，若要上线）**：将 Vite middleware 迁移到 Serverless/Edge Function，增加用户鉴权、限流、日志、预算和敏感信息保护。
6. **清理技术债（P2）**：`vite.config.ts` 顶部仍留有早期未注册的 `aiPageGenerator` 试验实现；当前实际注册的是 `aiPageGeneratorV2()`。下一窗口可安全删除旧实现，避免维护时误读。

---

## 8. 下一窗口开始时的建议检查项

1. 先读取本文件和 `vite.config.ts` 中 `aiPageGeneratorV2()`。
2. 确认开发服务器已重启，且 `.env.local` 存在有效 `OPENROUTER_API_KEY`（不要打印或提交该值）。
3. 用“生成一个简单的商品筛选页”验证生成流程，观察 SSE 阶段信息。
4. 如出现错误，优先区分：OpenRouter 接口拒绝、45 秒无流数据、JSON 无法解析、几何/属性校验失败；不要把所有问题都归因于 Prompt。
5. 后续编辑优先保留“模型生成 Schema、应用校验 Schema、编辑器渲染 Schema”的边界。
