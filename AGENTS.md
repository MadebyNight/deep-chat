# Deep Chat 仓库协作规范

修改界面、交互或 React 组件前，先读[组件库规范](src/components/COMPONENTS.md)。从 `src/components/base/index.ts` 复用通用控件，查找已有业务组件时先看 `component-catalog.json` 或运行 `npm run components:list`。

新增、删除或重命名组件后运行 `npm run components:update` 并检查清单差异。交付界面改动前运行 `npm run components:check` 和 `npm run type`。涉及按压、悬停、弹层或返回行为的改动，验证 Android WebView 的实际触摸路径。主题、模式等选中态应独立于临时的按压状态。
