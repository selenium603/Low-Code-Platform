# 低代码营销页面搭建平台

基于 Vue 3 + TypeScript + Pinia 的可视化低代码页面编辑器，面向营销活动与落地页场景。支持组件拖拽布局、实时属性配置、多端适配预览、页面 JSON 导入导出与一键导出独立 HTML 文件。

## 功能特性

### 可视化编辑

- **拖拽布局**：从左侧组件面板拖拽组件到画布，自由摆放位置
- **属性配置**：右侧面板实时编辑组件样式（字体、颜色、边框、圆角等）与业务属性
- **图层管理**：上移 / 下移 / 置顶 / 置底，灵活控制组件层级
- **画布操作**：缩放（0.3× ~ 2×）、网格吸附、对齐辅助线
- **撤销 / 重做**：基于命令模式的双栈历史管理，支持快捷键 `Ctrl+Z` / `Ctrl+Shift+Z`
- **方向键微调**：选中组件后可用方向键在当前设备画布中微调位置

### 组件库

内置 6 类组件，通过组件注册表（`registry.ts`）统一管理协议、默认值与属性面板 schema：

| 组件 | 说明 |
|------|------|
| 文本 | 多行文本内容，支持字体、字重、颜色、对齐、行高 |
| 图片 | URL 或本地上传，支持 `object-fit`、边框、圆角 |
| 按钮 | 可配置点击事件（打开链接 / 弹出消息）、悬停交互 |
| 输入框 | 支持 `text` / `tel` / `email` / `number` / `password` 等输入类型 |
| 表单 | 可配置多字段（label / type / placeholder / required），提交校验与回调 |
| 图表 | 基于 ECharts，支持柱状图 / 折线图 / 饼图、动态数据，以及图例、坐标轴、配色、单位和 tooltip 格式配置 |

### 多端适配

平台采用**双样式模型**实现 PC 端与移动端的独立编辑：

- **PC 端**：绝对定位布局，组件通过 `left / top / zIndex` 自由摆放
- **移动端**：375px 自由定位画布，组件可独立调整 `left / top / width / height`，并保留 12px 安全边距
- **差量覆盖**：移动端仅保存与 PC 端不同的字段到 `responsiveOverrides.mobile`，未修改的字段自动继承 PC 端基础样式；支持一键"恢复桌面端样式"
- **实时预览**：顶部切换 PC / 手机设备，画布即时切换布局模式，所见即所得
- **导出一致**：导出的 HTML 始终生成 `@media (max-width: 768px)` 媒体查询，移动端布局规则与编辑器预览完全一致

### 数据导入导出

- **JSON 导出**：将页面完整配置（含组件树、样式、事件、响应式覆盖）序列化为 JSON
- **JSON 导入**：导入时自动校验与修复数据结构，支持旧版本 schema 自动迁移
- **HTML 导出**：一键导出独立可运行的 HTML 文件，包含完整 CSS / JS，表单带原生校验，图表内嵌 ECharts
- **本地持久化**：编辑状态自动保存到 localStorage，刷新不丢失

### AI 页面助手

- **自然语言生成与修改**：生成可继续拖拽编辑的页面 Schema；修改请求由 LangGraph Agent 分流并在服务端完成
- **严格结构化输出**：整页生成、布局规划、RAG 定位和增量修改统一采用 strict Structured Output（JSON Schema），nullable 可选字段压缩后再进入应用校验；该链路不使用 Function Calling
- **多轮上下文**：按页面保存最近对话与结构化记忆，区分用户目标、设计约束、已完成修改和未决问题
- **大页面 RAG**：40+ 组件时按名称、文案、类型及 PC/手机空间关系进行组件向量召回，再加载局部 Schema 生成 Patch
- **大幅修改分阶段执行**：把复杂修改规划为 2～6 个步骤；整页重构按 `top → left → id` 确定性枚举并按预算连续分组
- **截断与格式容错**：按步骤操作量动态分配输出 token，识别 `finish_reason=length` 与不完整 JSON，携带明确错误自动重试
- **应用失败自动修正**：普通 Patch 在页面副本中出现边界或重叠错误时，自动携带失败 Patch 和精确错误请求一次修正版，连续失败才中止且不污染真实页面
- **安全应用**：服务端执行 revision、操作白名单、局部几何和最终整页几何校验，只通过 SSE 返回最终页面；前端以单条历史命令提交，支持一次撤销整轮修改

## 技术栈

| 分类 | 技术 |
|------|------|
| 前端框架 | Vue 3 + Composition API |
| 开发语言 | TypeScript 5.9 |
| 状态管理 | Pinia 3 |
| UI 组件库 | Element Plus 2 |
| 图表 | ECharts 6 |
| 构建工具 | Vite 7 |
| 代码规范 | ESLint + Prettier + oxlint |

## 项目结构

```
src/
├── components/
│   ├── Editor.vue              # 编辑器主容器（工具栏 + 面板编排 + 导入导出）
│   ├── ComponentPanel.vue      # 左侧组件面板（物料区）
│   ├── EditorCanvas.vue        # 中央画布（拖拽 / 缩放 / 吸附 / 设备切换）
│   ├── PropertyPanel.vue       # 右侧属性面板（样式 + 属性 + 事件配置）
│   ├── PageRenderer.vue        # 页面渲染器（PC / 移动端差异化渲染）
│   └── components/
│       ├── registry.ts         # Vue 组件渲染器映射
│       ├── TextComponent.vue
│       ├── ImageComponent.vue
│       ├── ButtonComponent.vue
│       ├── InputComponent.vue
│       ├── FormComponent.vue
│       └── ChartComponent.vue
├── stores/
│   ├── editor.ts               # 编辑器核心 store（组件操作 + 样式提交 + 设备管理）
│   ├── history.ts              # 撤销/重做历史栈（命令模式）
│   ├── migration.ts            # 数据版本迁移（schema 2026.01 → 2026.04）
│   └── pageImport.ts           # 兼容导出领域层 JSON 校验能力
├── types/
│   └── index.ts                # 全局类型定义
├── utils/
│   ├── mobile.ts               # 移动端布局工具函数与常量
│   └── chartOption.ts          # 编辑器、预览和 HTML 导出共用的 ECharts Option 构建器
├── router/
│   └── index.ts
├── assets/
├── App.vue
└── main.ts
server/ai/
├── graph/                      # LangGraph 状态、分流及局部/大幅/整页执行图
├── context/                    # 组件索引、RAG 上下文与确定性整页分组
├── model/                      # OpenRouter 结构化输出客户端
└── http/                       # SSE 与编辑接口 handler
```

## 快速开始

### 环境要求

- Node.js ^20.19.0 或 >=22.12.0

### 安装与运行

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 类型检查
npm run type-check

# 生产构建
npm run build

# 预览构建产物
npm run preview
```

## 使用指南

### 1. 搭建页面

从左侧**组件面板**拖拽组件到画布，在画布中自由摆放。点击选中组件后，右侧**属性面板**显示该组件的全部可配置项。

### 2. 多端适配

点击顶部工具栏的 **PC / 手机** 按钮切换设备：

- **PC 模式**：组件绝对定位，自由拖拽到任意位置
- **手机模式**：组件使用独立绝对定位，可自由拖拽、缩放并独立修改移动端样式
- 移动端修改的样式以**差量覆盖**方式保存，不影响 PC 端基础样式；点击"恢复桌面端样式"可清除移动端覆盖

### 3. 撤销 / 重做

- 工具栏按钮或快捷键 `Ctrl+Z`（撤销）/ `Ctrl+Shift+Z`（重做）
- 所有操作（新增、删除、移动、样式修改、属性修改、事件配置、图层调整）均纳入历史栈

### 4. 导入 / 导出

- **导出 JSON**：保存页面完整配置，可用于备份或团队协作
- **导入 JSON**：加载之前导出的 JSON，自动校验修复并迁移旧版本数据
- **导出 HTML**：生成独立可部署的 HTML 文件，包含完整样式与交互脚本

## 核心架构

### 命令模式与历史栈

所有状态写操作通过 `useHistoryStore().executeCommand(command)` 提交，每个 `command` 包含 `execute()` 和 `undo()` 方法。历史栈最大容量 100 步，保证多步撤销/重做的完整性。

### 组件协议注册表

每个组件类型在 `registry.ts` 中注册一份 `ComponentProtocol`，包含：

- `defaultStyle`：默认样式
- `defaultProps`：默认属性
- `schema`：属性面板字段定义（驱动 PropertyPanel 动态渲染表单）

新增组件只需注册协议 + 编写渲染器 `.vue`，无需修改面板和画布代码。

### 数据版本迁移

`migration.ts` 维护 schema 版本链（当前 `2026.04`），支持页面级和组件级迁移函数注册。导入旧版本 JSON 时自动逐版本升级，保证向后兼容。

### 响应式样式模型

```
组件最终样式 = component.style（PC 基础样式）
             + component.responsiveOverrides[device]（设备差量覆盖）
```

`getEffectiveStyle()` 在渲染时合并基础样式与设备覆盖，移动端 `commitComponentStyle` 仅保存与 PC 端不同的字段，避免全量固化。

## 浏览器兼容性

- Chrome / Edge（推荐）
- Firefox
- Safari

## 许可证

MIT License
