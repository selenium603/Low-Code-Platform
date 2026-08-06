# Vue Yuan Drag - 可视化页面编辑器

一个基于 Vue 3 + TypeScript 的低代码可视化页面搭建平台，通过组件拖拽与配置化方式快速生成业务页面。

## 功能特性

### 核心功能
- 组件拖拽：支持从组件库拖拽组件到画布，自由布局
- 撤销/重做：完整的命令模式实现，支持操作历史管理
- 属性编辑：实时编辑组件样式和属性
- 画布操作：支持缩放、网格吸附、辅助线

### 组件库
- 文本组件：支持内容、字体、颜色等样式编辑
- 图片组件：支持图片URL、尺寸调整
- 按钮组件：支持文本、样式、点击事件
- 输入框组件：支持占位符、样式配置

### 高级功能
- 图层管理：支持上移、下移、置顶、置底
- 页面预览：实时预览编辑效果
- JSON导出：支持导出页面配置
- 响应式设计：适配不同屏幕尺寸

## 技术栈

- **前端框架**：Vue 3 + Composition API
- **开发语言**：TypeScript
- **状态管理**：Pinia
- **UI组件库**：Element Plus
- **路由**：Vue Router
- **构建工具**：Vite

## 项目结构

```
src/
├── components/          # 组件目录
│   ├── Editor.vue      # 主编辑器组件
│   ├── EditorCanvas.vue # 画布组件
│   ├── ComponentPanel.vue # 组件面板
│   ├── PropertyPanel.vue  # 属性面板
│   └── components/     # 可拖拽组件
│       ├── TextComponent.vue
│       ├── ImageComponent.vue
│       ├── ButtonComponent.vue
│       └── InputComponent.vue
├── stores/             # 状态管理
│   ├── editor.ts      # 编辑器状态
│   └── history.ts     # 历史记录管理
├── types/             # TypeScript类型定义
│   └── index.ts
└── main.ts            # 入口文件
```

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

### 构建生产版本

```bash
npm run build
```

### 代码检查

```bash
npm run lint
```

## 使用说明

### 1. 添加组件
从左侧组件库拖拽组件到中间画布区域，组件会自动放置在鼠标释放位置。

### 2. 编辑组件
点击画布中的组件，右侧属性面板会显示该组件的可编辑属性。

### 3. 撤销/重做
使用顶部工具栏的撤销/重做按钮，或快捷键：
- 撤销：Ctrl+Z
- 重做：Ctrl+Y 或 Ctrl+Shift+Z

### 4. 图层管理
选中组件后，可以在属性面板中调整图层顺序：
- 上移一层
- 下移一层
- 置于顶层
- 置于底层

### 5. 导出页面
点击顶部"导出JSON"按钮，可以将页面配置导出为JSON文件。

## 核心实现

### 拖拽系统
- 使用 HTML5 Drag and Drop API
- 支持鼠标位置精确计算
- 考虑画布缩放比例

### 撤销/重做
- 基于命令模式实现
- 维护操作历史栈
- 支持多步撤销/重做

### 状态管理
- 使用 Pinia 管理全局状态
- 组件树使用 JSON Schema 描述
- 响应式数据驱动视图更新

## 浏览器兼容性

- Chrome (推荐)
- Firefox
- Safari
- Edge

## 开发计划

- [ ] 添加更多组件类型（表单、图表等）
- [ ] 支持组件组合和分组
- [ ] 添加动画效果配置
- [ ] 支持自定义组件开发
- [ ] 添加页面模板功能

## 贡献指南

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License

## 联系方式

如有问题或建议，欢迎通过 GitHub Issues 联系。

---

**注意**：本项目为学习和演示用途，持续开发中。
