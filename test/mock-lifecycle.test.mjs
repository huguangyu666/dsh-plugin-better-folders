/**
 * 生命周期 Mock 测试：用一个轻量 Fake Context 装载 host 端，断言所有注册行为
 * 与工具 / 指令的实际效果。不需要启动完整 DSH 宿主。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'

// 把插件状态重定向到临时目录，避免测试污染真实的 ~/.dsh/better-folders/state.json。
const SANDBOX = mkdtempSync(join(tmpdir(), 'better-folders-test-'))
process.env.DSH_HOME = SANDBOX
process.on('exit', () => {
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch { /* 清理失败不影响测试结论 */ }
})

/** 造一个内存版工作区注册表。 */
function fakeRegistry(paths) {
  let seq = 0
  const items = paths.map((entry) => {
    seq += 1
    const source = typeof entry === 'string' ? { path: entry } : entry
    return { id: source.id ?? `w${seq}`, path: source.path, title: source.title ?? '', sessionIds: [] }
  })
  return {
    items,
    list: () => items.slice(),
    get: (id) => items.find((item) => item.id === id),
    async create(path, title) {
      const found = items.find((item) => item.path.toLowerCase() === path.toLowerCase())
      if (found) return found
      seq += 1
      const entity = { id: `w${seq}`, path, title: title ?? '', sessionIds: [] }
      items.unshift(entity)
      return entity
    },
    async delete(id) {
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return false
      items.splice(index, 1)
      return true
    },
    async insertBefore(id, beforeId) {
      const from = items.findIndex((item) => item.id === id)
      const [entity] = items.splice(from, 1)
      const at = beforeId === undefined ? items.length : items.findIndex((item) => item.id === beforeId)
      items.splice(at < 0 ? items.length : at, 0, entity)
      return items.map((item) => item.id)
    },
  }
}

/**
 * 造一个 Fake Cordis Context。
 * 刻意不提供 `inject`，让插件走「服务缺失就静默跳过」的回退分支。
 */
function fakeContext(registry) {
  const registered = { tools: [], commands: [], sections: [], routes: [] }
  const listeners = []
  const disposers = []
  const ctx = {
    workspaceRegistry: registry,
    effect(fn) {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    tools: { register: (definition) => { registered.tools.push(definition); return () => {} } },
    commands: { register: (definition) => { registered.commands.push(definition); return () => {} } },
    systemPrompt: { section: (section) => { registered.sections.push(section); return () => {} } },
    webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
  }
  return { ctx, registered, listeners, dispose: () => disposers.forEach((fn) => typeof fn === 'function' && fn()) }
}

const PROJ = 'C:\\Users\\dev\\Documents\\MyProjects'

test('apply 注册工具、指令、提示词段与 HTTP 路由', () => {
  const registry = fakeRegistry([{ path: `${PROJ}\\plugin-workspace` }, { path: `${PROJ}\\demo-app` }])
  const { ctx, registered, dispose } = fakeContext(registry)

  apply(ctx)

  const names = registered.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['manage_workspace_tables', 'organize_workspaces'])
  const organizeTool = registered.tools.find((tool) => tool.name === 'organize_workspaces')
  // 坑 5：parameters 必须是合法 JSON Schema 对象。
  assert.equal(organizeTool.parameters.type, 'object')
  assert.ok(Array.isArray(organizeTool.parameters.properties.action.enum))
  const tablesTool = registered.tools.find((tool) => tool.name === 'manage_workspace_tables')
  assert.equal(tablesTool.parameters.type, 'object')
  assert.ok(Array.isArray(tablesTool.parameters.properties.action.enum))

  assert.equal(registered.commands.length, 1)
  assert.equal(registered.commands[0].name, 'folders')
  // 坑 4：hint 不能为空字符串。
  assert.ok(registered.commands[0].input.hint.length > 0)

  assert.equal(registered.sections.length, 1)
  assert.equal(registered.sections[0].name, 'better-folders:discipline')

  assert.equal(registered.routes.length, 1)
  assert.equal(registered.routes[0].path, '/better-folders/api')

  dispose()
})

test('apply 监听 workspace 域的 domain/changed 事件', () => {
  const registry = fakeRegistry([])
  const { ctx, listeners, dispose } = fakeContext(registry)
  apply(ctx)
  assert.ok(listeners.some((entry) => entry.event === 'domain/changed'))
  // 非 workspace 域的变化不应触发整理。
  const handler = listeners.find((entry) => entry.event === 'domain/changed').handler
  assert.doesNotThrow(() => handler({ domain: 'other', table: '', key: '', operation: 'put' }))
  dispose()
})

test('工具 action=status 返回分组现状', async () => {
  const registry = fakeRegistry([
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
    { path: 'C:\\Users\\dev\\Documents\\notes' },
  ])
  const { ctx, registered, dispose } = fakeContext(registry)
  apply(ctx)

  const tool = registered.tools[0]
  const result = await tool.execute({ action: 'status' })
  assert.equal(result.ok, true)
  assert.equal(result.workspaceCount, 3)
  assert.equal(result.groupCount, 1)
  assert.equal(result.pendingCount, 1)
  assert.equal(result.groups[0].path, PROJ)
  dispose()
})

test('工具 action=apply 真的把上级目录注册成工作区', async () => {
  const registry = fakeRegistry([{ path: `${PROJ}\\plugin-workspace` }, { path: `${PROJ}\\demo-app` }])
  const { ctx, registered, dispose } = fakeContext(registry)
  apply(ctx)

  const tool = registered.tools[0]
  const result = await tool.execute({ action: 'apply' })
  assert.equal(result.createdCount, 1)
  assert.ok(registry.items.some((item) => item.path === PROJ))

  // 幂等：再跑一次不再新建。
  const again = await tool.execute({ action: 'apply' })
  assert.equal(again.createdCount, 0)
  dispose()
})

test('工具 action=unmerge 还原', async () => {
  const registry = fakeRegistry([{ path: `${PROJ}\\plugin-workspace` }, { path: `${PROJ}\\demo-app` }])
  const { ctx, registered, dispose } = fakeContext(registry)
  apply(ctx)
  const tool = registered.tools[0]
  await tool.execute({ action: 'apply' })

  const result = await tool.execute({ action: 'unmerge' })
  assert.equal(result.removed.length, 1)
  assert.equal(registry.items.some((item) => item.path === PROJ), false)
  dispose()
})

test('/folders status 与 /folders organize 输出可用文本', async () => {
  const registry = fakeRegistry([{ path: `${PROJ}\\plugin-workspace` }, { path: `${PROJ}\\demo-app` }])
  const { ctx, registered, dispose } = fakeContext(registry)
  apply(ctx)
  const command = registered.commands[0]

  const status = await command.handler({ rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /更好的 DSH 文件夹/)

  const plan = await command.handler({ rawInput: 'plan' })
  assert.match(plan.text, /预览/)

  const applied = await command.handler({ rawInput: 'organize' })
  assert.match(applied.text, /已整理/)
  assert.ok(registry.items.some((item) => item.path === PROJ))

  const unmerged = await command.handler({ rawInput: 'unmerge' })
  assert.match(unmerged.text, /已还原/)
  dispose()
})
