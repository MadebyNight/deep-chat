# Deep Chat 组件库规范

## 组件归属

- `src/components/base/` 存放跨页面复用的控件。业务代码从 `base/index.js` 导入公开控件，新增公开控件时在 `base/index.ts` 导出。共享层不能依赖聊天、设置、侧栏等业务组件。
- 业务组件放在所属目录，例如输入与附件、消息、Markdown、搜索、设置、会话和侧栏。组件目录同时登记共享组件、业务组件和具名内部组件。业务专用样式留在对应的 CSS Module。
- 查找现有实现用[组件清单](../../component-catalog.json)。加载、键盘、文件选择和返回行为已有入口时，复用对应实现。

## 选用控件

| 场景 | 控件 |
| --- | --- |
| 普通文字操作、确认、危险操作 | `Button`，按用途选 `outlined`、`primary`、`danger` 或 `dangerOutlined` |
| 仅图标的操作 | `IconButton`，用 `tooltip` 或 `aria-label` 提供可读名称 |
| 业务样式按钮、切换项、附件入口 | `ActionButton`，通过 `className` 定制外观并沿用共用按压行为 |
| 单行、多行输入 | `Input`、`Textarea`，保留原生属性、`ref`、表单和键盘行为 |
| 下拉选择、布尔开关、操作菜单 | `Select`、`Switch`、`Menu` |
| 模态弹窗、悬浮提示、短时通知 | `Modal`、`Tooltip`、`Toast` |

## 样式与交互

- 颜色、尺寸、边框和过渡优先使用 [主题变量](../app/theme.css) 和[移动端样式](../app/mobile.css)。保持浅深色一致、移动端布局紧凑，并兼顾窄屏和字体缩放。蓝色用于首要操作、选中态和触摸反馈，普通操作默认回到所属组件的静止样式。
- `ActionButton` 在有效按压期间设置 `data-pressed`，松手、取消、离开或失焦时清除。定制按压样式用 `[data-pressed]`。Android WebView 在松手后仍可能匹配 `:active` 或 `:hover`，悬停样式应放在 `@media (hover: hover) and (pointer: fine)` 内。
- 选中、展开、忙碌和禁用是独立状态。按语义使用 `aria-pressed`、`aria-selected`、`aria-expanded`、`aria-busy` 或 `disabled`，并保留键盘焦点。普通动作进行中可以用文字反馈，重复提交要由操作本身拦住。使用 `aria-disabled` 时也要拦截实际激活操作。
- 优先使用共享控件的原生语义。涉及系统选择器或复合控件时，保留必要的原生属性与 ARIA 结构。特殊结构如已有的更新弹层由所属模块管理，新增例外时把原因和范围写在检查规则旁。

## 开发与验收

| 命令 | 用途 |
| --- | --- |
| `npm run components:list` | 列出扫描到的组件、分组和源码路径 |
| `npm run components:preview` | 启动本地预览，查看通用控件的主题和交互状态 |
| `npm run components:update` | 新增、删除或重命名组件后，从源码重新生成清单 |
| `npm run components:check` | 对照清单，检查受管的原生 JSX 控件、静态 ARIA 角色及基础层导入边界 |
| `npm run type` | 检查类型和组件调用接口 |

提交界面改动前检查 `component-catalog.json` 的差异，并运行组件检查和类型检查。真机验证根据变更覆盖按下、松手、触摸取消、真正的选中态及 Android 返回键。程序调用 `.click()` 只适合验证动作是否触发，触摸样式还需要真实触摸事件。组件检查和预览属于开发工具，正式 App 仍从 `src/main.tsx` 构建。
