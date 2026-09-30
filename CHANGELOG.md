# Changelog

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
