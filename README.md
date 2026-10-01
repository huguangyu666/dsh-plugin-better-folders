# dsh-plugin-better-folders · 更好的 DSH 文件夹

> 自动整理 DSH 工作区：把**同一个上级目录**下的多个工作区汇合成一个可折叠的文件夹节点。

仓库：<https://github.com/huguangyu666/dsh-plugin-better-folders>

---

## 它解决什么问题

DSH 的工作区（Workspace）=「一个项目目录 + 跑在它下面的会话」。真实使用中这些目录往往成堆地躺在同一个父目录里：

```
C:\Users\me\Documents\MyProjects\plugin-workspace
C:\Users\me\Documents\MyProjects\dsh-plugin-memory
C:\Users\me\Documents\MyProjects\demo-app
C:\Users\me\Documents\MyProjects\quant
...                        ← 十几个同级目录
C:\Users\me\code\sandbox
C:\Users\me\code\webapp
```

侧边栏默认的「按工作区」是平铺的，十几个同级目录排成一大列，找起来很累。

本插件把它们汇合成：

```
📁 MyProjects              ← 自动生成的文件夹节点
   ├ plugin-workspace
   ├ dsh-plugin-memory
   ├ demo-app
   └ quant
📁 code
   ├ sandbox
   └ webapp
notes                        ← 单个工作区保持原样
```

## 工作原理（为什么不用重画侧边栏）

DSH 侧边栏自带 **「按工作区树」** 视图（`groupBy = "workspace-tree"`，由
`@deepseek-ai/dsh-client-ui-workspace` 提供）：它会把每个工作区挂到**最近的已注册祖先工作区**下面。

所以「把相同上一级目录的工作区汇合在一起」在本插件里等价于：

> **把那个共同的上级目录本身注册成一个工作区（文件夹节点）。**

注册完，内置树视图会自动把子工作区嵌进去 —— 插件不需要、也没有去覆盖官方 UI，因此
不会出现「插件一挂，侧边栏白屏」这类事故。

## 功能

| 能力 | 入口 |
|---|---|
| 一键整理 / 预览 / 还原 | 设置 → 插件 → **更好的 DSH 文件夹** |
| 侧边栏快捷整理按钮 | 侧边栏底部 **📁 整理文件夹** |
| 对话斜杠指令 | `/folders status \| plan \| organize \| unmerge` |
| Agent 原生工具 | `organize_workspaces`（action: status / plan / apply / unmerge） |
| 自动整理 | 工作区列表变化后自动汇合（可关） |
| 原生设置表单 | 设置命名空间 `better-folders` |

### 整理规则（全部可在设置里调）

| 配置 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 插件总开关 |
| `autoOrganize` | `true` | 工作区列表变化后自动整理 |
| `minChildren` | `2` | 至少多少个同级工作区才汇合出一个文件夹节点 |
| `maxDepth` | `1` | 向上追溯几级目录寻找共同上级（1 = 只看直接上级） |
| `autoTreeView` | `true` | 整理后把侧边栏切到「按工作区树」视图 |
| `keepOrder` | `true` | 把文件夹节点排在它的第一个子工作区之前 |

> **关于向上级联（已内置防护）**：如果某上级目录本身也是一个工作区、且它下面正好还有
> 另一个工作区，那么它也会被当作一个汇合点。为了避免「每建一层就在更上一层凑出新配对、
> 一路级联到盘符根」，插件对**自己创建的文件夹节点**做了排除：它们不再算作上一层的
> 同级成员。用户**自己注册**的父级工作区不受此限制（例如你已把 `sandbox` 建成工作区，
> 它仍会正常挂在 `code` 下）。根目录（`C:\`、`/`）永远不建节点。

## 安全边界

* **只增不删**：整理只调用 `workspaceRegistry.create()`，从不删除任何工作区、目录或会话历史。
* **还原是安全的**：`unmerge` 只删除**本插件自己创建过、且没有任何会话**的文件夹节点
  （记录在 `~/.dsh/better-folders/state.json`）。用户手动建的工作区、已经在里面开过会话
  的节点，一律保留。
* **还原会顺手关掉「自动整理」**：删除节点本身会触发工作区变化事件；如果自动整理还开着，
  下一次自动整理会立刻把刚删掉的节点重建出来，用户永远还原不掉。所以还原会显式把
  `autoOrganize` 置为 `false`，把「要不要继续自动整理」的决定权交回你（在面板里一键就能重开）。
* **删除工作区注册 ≠ 删除数据**：即便手动删掉文件夹节点，磁盘目录和会话历史都还在。
* **幂等**：重复整理不会重复建节点；由 `domain/changed` 触发的自动整理会自然收敛。

## 安装

```bash
# 1) 构建
npm install          # 只装 esbuild
npm run build

# 2) 跑测试
npm test

# 3) 装进 profile（默认 web），带备份与 dump-config 复核
node tools/install-into-profile.mjs --profile web --dry-run   # 先看将执行什么
node tools/install-into-profile.mjs --profile web
```

装完**重启 DSH**（插件在启动时装配）。

从 GitHub 克隆安装：

```bash
git clone https://github.com/huguangyu666/dsh-plugin-better-folders.git
cd dsh-plugin-better-folders
npm install && npm run build
node tools/install-into-profile.mjs --profile web
```

卸载：

```bash
node tools/install-into-profile.mjs --profile web --uninstall
```

## 使用

装上并重启（桌面版需**刷新页面**加载客户端半）之后，通常什么都不用做：

* **自动整理**会在启动 4 秒后跑一次，把合格的上级目录注册成文件夹节点；
* **客户端半**随后做一次视图校准：只要 `autoTreeView` 是开的、且确实存在可汇合的
  目录，就把侧边栏切到「按工作区树」。**这一步是能不能看出效果的关键** ——
  整理本身只注册工作区，真正的视觉汇合由内置树视图完成；不切视图的话，侧边栏
  只会平白多出几个条目，反而更乱。

手动操作：

1. 打开 **设置 → 插件 → 更好的 DSH 文件夹**。
2. 点 **预览** 看清将要新建哪些文件夹节点。
3. 点 **一键整理**。若 `autoTreeView` 开着，侧边栏会自动切到「按工作区树」。
   若没切过去（客户端服务不可用时会退回写 localStorage），手动选
   **视图选项 → 分组方式 → 按工作区树**，或刷新页面。
4. 不满意就点 **还原**。还原会同时关闭「自动整理」，避免刚还原就被自动重建；
   想继续自动整理就在面板里把开关重新打开。

> **没看到效果时先查这三件事**：① 插件装的是不是**当前正在用的那个 profile**
> （桌面版用 `desktop`，`dsh web` 用 `web`）；② 客户端半加载了没（刷新页面）；
> ③ 侧边栏分组方式是不是「按工作区树」。
>
> **立刻手动见效**：侧边栏 **视图选项 → 分组方式 → 按工作区树**。整理只是把上级目录
> 注册成工作区，真正的视觉汇合由这个内置视图完成；只要切过去，文件夹节点就会把同级
> 工作区收进去。
>
> 排查「点了没反应」：客户端半会把能力探测结果写到
> `~/.dsh/better-folders/diag.json`（`/better-folders/api/diag`），不需要开 DevTools。

对话里也可以：

```
/folders            # 查看现状
/folders plan       # 预览
/folders organize   # 执行整理
/folders unmerge    # 还原
```

## HTTP API

面板与侧边栏按钮通过同源接口驱动（`ctx.webServer` 注册的 `prefix` 路由）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/better-folders/api/status` | 现状 + 分组 + 已建节点 + 上次运行结果 |
| GET | `/better-folders/api/settings` | 当前配置 |
| POST | `/better-folders/api/settings` | 写入配置（部分字段） |
| POST | `/better-folders/api/preview` | 预览计划，不写入 |
| POST | `/better-folders/api/apply` | 执行整理 |
| POST | `/better-folders/api/unmerge` | 还原 |

## 工程结构

```
dsh-plugin-better-folders/
├── src/
│   ├── plan.js            # 纯分组算法 + 整理器（零外部依赖，可单测）
│   ├── index.js           # Host 端：设置 / 自动整理 / HTTP API / 工具 / 指令 / 提示词
│   └── client-source.js   # Client 端：设置面板 + 侧边栏按钮 + 树视图切换
├── lib/                   # esbuild 产物（lib/index.js + lib/client.js）
├── test/
│   ├── contract.test.mjs       # 包元数据 / patch / 产物契约
│   ├── plan.test.mjs           # 分组算法与整理器
│   └── mock-lifecycle.test.mjs # Fake Context 生命周期与工具/指令行为
├── tools/install-into-profile.mjs
├── build.mjs
├── cordis.patch.yml
└── package.json
```

## 实现备注

* **Host 端 `inject` 只声明 `workspaceRegistry`**。`settings` / `webServer` / `tools` /
  `commands` / `systemPrompt` 全部通过 `ctx.inject(...)` 按需挂载 —— 在 headless profile
  里没有 `webServer` 时，插件依然能提供工具与指令，而不是整个挂掉。
* **`@deepseek-ai/schemastery` 懒加载**：DSH 运行时会提供；本地裸跑测试时加载失败只会
  降级为「没有原生设置表单」，不影响整理能力。
* **BOM 铁律**：状态文件与备份一律用 `fs.writeFileSync(..., 'utf8')`，不经过 PowerShell
  的 `Set-Content`，避免 DSH 启动时 `JSON.parse` 被 BOM 打挂。
* **视图切换双通道**：优先调用客户端服务 `ctx.uiWorkspace.view.setGroupBy('workspace-tree')`
  即时生效；不可用时退回改写 localStorage 的 `dsh.workspace.view.v5`（下次刷新生效）。

## 测试

```bash
npm test
```

32 个用例覆盖：路径规范化（Windows / POSIX / UNC）、汇合计划（同级 / 多级 / 已注册父目录 /
根目录保护 / 顺序锚点）、整理器（预览 / 应用 / 幂等 / 还原 / 会话保护 / 用户工作区保护）、
Fake Context 生命周期（工具 / 指令 / 提示词 / 路由注册与行为）。

## License

MIT
