# Changelog

## 0.4.1 — 2026-10-01

* **表模式的侧边栏行改成逐字抄官方样式**（用户反馈「和官方的不一样」）。
  之前我按菜单行的手感自己调了一套（min-height + 13px 字号 + 硬编码缩进），
  和官方侧边栏对不上。现在直接抄 `dsh-client-ui-workspace` 的
  `rows/Rows.module.css` 原文：

  ```css
  .projectRow,.sessionRow{border-radius:var(--dsw-radius-md);padding:0 8px;
    padding-inline-start:calc(8px + var(--dsh-workspace-indent,0px));gap:6px;display:flex}
  .projectRow{height:34px}   .sessionRow{height:32px}
  .title{font-size:14px;line-height:20px;margin:0 6px 0 4px;flex:1;text-overflow:ellipsis}
  .slot{width:16px;height:20px;color:var(--dsw-alias-label-tertiary)}
  .iconButton{width:16px;height:16px;border-radius:var(--dsw-radius-xs)}
  ```

  工作区行现在带官方文件夹图标（`IconFolderOpenOutlineRegular`），会话行带
  `IconListPenOutlineRegular`，缩进用官方的 `--dsh-workspace-indent` 变量（12px/级）。

### 顺带说明：「虚拟工作区」这条路为什么走不通

用户建议"搞一个虚拟工作区"。查证后确认不可行：

* `workspaceRegistry.create(path)` 会 `stat` 校验路径必须是**真实存在的目录**；
* `attachSession(sessionId)` 会校验 `session.cwd === workspace.path`，否则抛错
  （`dsh-workspace/lib/index.js:111`）——所以虚拟工作区装不下别的目录的会话；
* 官方树视图的嵌套是 `child.startsWith(parent + "/")`，纯路径前缀。

结论：官方侧边栏里的"文件夹"**就是"路径祖先"**，不是一种独立实体，数据模型里没有
"集合"这个维度。虚拟工作区最多只能是侧边栏里一个空的组。

## 0.4.0 — 2026-10-01

* **新增「表模式」：侧边栏里直接切换**（用户要的深度融合，终于做到了）。
  面板里点「侧边栏打开」→ 侧边栏整个变成该表的工作区 + 会话列表，点一下就切过去；
  点标题行的 ← 退出，**官方工作区浏览器原封不动回来**。

  关键在于 `ui-slots` 的**优先级抢占**：

  ```js
  // dsh-client-ui-slots/lib/index.js:221
  next.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0)); // 数字小的渲染
  // :237  register 返回 disposer
  return () => { rec.entries = rec.entries.filter((e) => e !== entry); ... };
  ```

  所以表模式用 `priority: -1` 抢占 `sidebar.workspaces`，退出时 dispose 归还。
  **这不是"换一个更弱的侧边栏"** —— 搜索、拖拽排序、归档、Pin、展开记忆、重命名/删除
  对话框全都还在，只是表模式下暂时让位。

  官方浏览器的子槽位声明（`sidebar.workspaces.directoryFlow` 等）挂在官方那条 entry 上，
  抢占不会撤销它们，所以目录选择流等仍然可用。

* 上一版（0.3.0）的侧边栏导航项 + 主区页面保留，作为"大列表 + 批量管理"的入口。

## 0.3.0 — 2026-10-01

* **新增深度融合入口：侧边栏导航项 + 主区「工作区表」页面**（官方槽位，不是浮层）。
  - `sidebar.panellist`：侧边栏多一行「工作区表」，与「插件」并排，点一下就切过去；
  - `main`（键控）：中间区渲染完整的切换台页面 —— 大列表、表管理、批量勾选成员、
    工作区下钻到会话。样式沿用官方浮层材质与尺寸。
* 原有入口全部保留：标题行 📁/📋 图标、底部兜底按钮、`/folders tables`、Agent 工具。

### 为什么没做成「侧边栏里直接分组」

用户想要的是「表」成为侧边栏的一种原生分组模式。查证后确认**做不到而不掉功能**：

* 官方侧边栏的分组是在 `WorkspaceBrowser` **组件内部**由已注册工作区算出来的
  （`groupByWorkspace()`），`groupBy` 只有 `workspace / workspace-tree / flat` 三个固定值；
* `sidebar.workspaces` 只对外声明 5 个子洞（会话菜单项 / 会话行按钮 / 目录选择流 /
  会话行 leading / hover），**没有「工作区行」或「分组标题」的洞**；
* `ctx.slots.entriesOfSlot('sidebar.workspaces')` 虽然能拿到官方组件的 `component`，
  但它的注入面（`inject` 工厂、`store`、`renderSlot`、locale）是 ui-workspace 插件内部的
  闭包，第三方重建不出来，硬渲染必崩 —— 所以「我的切换器 + 官方原版浏览器」叠不了。

唯一的路是整个覆盖 `sidebar.workspaces`，代价是**失去搜索、拖拽排序、归档、Pin、
展开记忆、重命名/删除对话框**。那不是深度融合，是换一个更弱的侧边栏，因此没做。

## 0.2.1 — 2026-10-01

* **修复「＋」点了没反应（真 bug）**：新建表 / 改名用的是 `window.prompt`，而
  **Electron 渲染进程不支持 `prompt()`，调用会直接抛错** —— 所以整个面板看起来是死的。
  `window.confirm` 虽可用但会阻塞渲染进程，也一并换掉。
  现在新建 / 改名 / 删除确认全部是**面板内联的输入行与确认行**（Enter 提交、Esc 取消）。
* **修复主题不同步**：面板此前用的是从别的插件抄来的 token
  （`--dsw-alias-bg-module-platform` 等），这些名字**不在官方主题 token 表里**，
  于是全部落到硬编码的深色兜底上 —— 在浅色主题下那个面板就是一块黑。现在改用官方
  真实 token：`--dsw-alias-bg-overlay`（官方描述就是「Overlay and popover background」）、
  `--dsw-alias-bg-layer-2`、`--dsw-alias-border-l2`、`--dsw-alias-brand-primary`、
  `--dsw-alias-interactive-bg-hover`、`--dsw-alias-state-error-primary`，
  并且**不再留深色兜底**。
* 按钮改用官方 `Button` 组件（`{ variant, size, icon }`），拿不到时退化为同样用官方
  token 的原生按钮。

## 0.2.0 — 2026-10-01

* **新增「表」——用户自定义的工作区集合**。和 0.1.x 的「按上级目录汇合」互补：
  那个由磁盘层级决定，这个由你自由指定。表**不落地成任何目录**：只记录工作区 id 的
  集合，不创建文件、不改 cwd、不碰会话历史；同一个工作区可同时属于多个表，删表不删东西。
  - Host：`~/.dsh/better-folders/collections.json` + `/better-folders/api/collections`
    （create / rename / delete / setMembers / toggleMember）
  - Agent 工具 `manage_workspace_tables`
  - 指令 `/folders tables [new|rename|delete|add|remove]`
  - 面板里列到**会话级**：点工作区打开工作区，点会话直接跳会话
* **把入口搬进「工作区」标题行**（用户指定）。那一行没有对外槽位（搜索/视图选项/
  添加工作区都是官方组件内部写死的），因此采用**只读测量 + 浮层贴合**：读取
  `[class*="sectionHeader"]` 的位置，把两个图标按钮浮在它左边，**不修改官方 DOM**，
  不会和 React 协调打架。图标来自官方组件库
  `@deepseek-ai/dsh-client-ui-primitives`（Module Loader 车道的隐式外部依赖），
  尺寸/圆角/悬停全部对齐原生 `searchButton`。定位失败时自动退回底部按钮。

## 0.1.2 — 2026-10-01

* **修复视图校准静默失效（0.1.1 的真凶）**：客户端插件的 Context 只暴露 `inject`
  里声明过的服务，而 0.1.1 没声明 `uiWorkspace`，于是 `ctx.uiWorkspace.view` 永远
  取不到 —— 视图校准和按钮里的切换全部静默失败，侧边栏一直停在平铺的「按工作区」，
  文件夹节点建出来了却看不出汇合效果。
  - `inject` 改为 `["slots", "uiWorkspace"]`；
  - 去掉客户端半里的 `ctx.effect`（客户端 Context 不保证提供，抛错会连带掐掉后续
    初始化；同 profile 的其他客户端插件也都没用）；
  - `switchToTreeView()` 现在会**回读 localStorage 验证是否真的切换成功**，失败则
    退化为「写偏好 + 提示刷新」。
* **按钮不再「没反应」**：侧边栏按钮会就地显示结果（已切到树视图 / 需刷新 /
  已是最新无需整理 / 失败原因），不再只写 console。
* **新增客户端诊断上报**：客户端把能力探测结果（`uiWorkspace` 是否可达、
  `setGroupBy` 是否存在、视图模式、各阶段结果）POST 到 `/better-folders/api/diag`，
  宿主落到 `~/.dsh/better-folders/diag.json`（保留最近 20 条）。
  排查「点了没反应」不必再让用户开 DevTools。

## 0.1.1 — 2026-10-01

* **修复「装了却看不出效果」**：客户端半现在会在启动后做一次视图校准 —— 只要
  `autoTreeView` 开着、且确实存在可汇合的目录，就自动把侧边栏切到「按工作区树」。
  此前自动整理只注册了文件夹节点，视图仍是平铺的，侧边栏只会平白多出几个条目，
  反而更乱。校准在 `ctx.uiWorkspace` 就绪后执行（按 700ms 间隔重试有限次），
  没有可汇合对象时不动用户视图。
* README 补充「没看到效果时先查这三件事」：profile 是否装对、客户端半是否加载
  （桌面版需刷新页面）、分组方式是否为「按工作区树」。

## 0.1.0 — 2026-09-30

首个版本。

* **自动整理工作区**：把同一个上级目录下的多个工作区汇合成一个可折叠的文件夹节点。
  做法是把该上级目录注册成一个工作区，复用 DSH 内置的「按工作区树」视图
  （`groupBy = "workspace-tree"`），不覆盖任何官方 UI。
* **防级联**：本插件创建出的文件夹节点不再参与上一层的汇合统计，避免「每建一层就在
  更上一层凑出新配对」一路级联到盘符根；用户自己注册的父级工作区不受此限制。
* **只增不删**：整理只调用 `workspaceRegistry.create()`，从不删除工作区、目录或会话历史。
* **安全还原**：`unmerge` 只删除本插件创建过且**没有会话**的文件夹节点；还原同时关闭
  「自动整理」，避免刚还原就被自动重建。
* 入口：设置页「更好的 DSH 文件夹」、侧边栏底部「📁 整理文件夹」、`/folders` 指令、
  `organize_workspaces` 工具、`/better-folders/api/*` HTTP 接口。
* 可配置：`enabled` / `autoOrganize` / `minChildren` / `maxDepth` / `autoTreeView` / `keepOrder`。
* 工程：`src/plan.js` 为纯函数算法层（零外部依赖），34 个单测覆盖路径规范化、汇合计划、
  防级联、整理器幂等 / 还原 / 会话保护，以及 Fake Context 生命周期。
