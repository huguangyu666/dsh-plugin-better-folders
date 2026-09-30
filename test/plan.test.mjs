/**
 * 分组算法与整理器测试：纯内存，不触碰 ctx / 磁盘 / 真实注册表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG,
  ancestorAt,
  canonKey,
  computePlan,
  createOrganizer,
  folderTitle,
  isRootPath,
  normalizeConfig,
  pathApi,
} from '../src/plan.js'

/** 造一个内存版工作区注册表，行为对齐 ctx.workspaceRegistry 的相关契约。 */
function fakeRegistry(paths) {
  let seq = 0
  const items = paths.map((entry) => {
    seq += 1
    const source = typeof entry === 'string' ? { path: entry } : entry
    return {
      id: source.id ?? `w${seq}`,
      path: source.path,
      title: source.title ?? '',
      sessionIds: [...(source.sessionIds ?? [])],
    }
  })
  return {
    items,
    list: () => items.slice(),
    get: (id) => items.find((item) => item.id === id),
    async create(path, title) {
      const found = items.find((item) => canonKey(item.path) === canonKey(path))
      if (found) return found
      seq += 1
      const entity = { id: `w${seq}`, path, title: title ?? '', sessionIds: [] }
      items.unshift(entity) // 真实注册表也是「新建前置」
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
      if (from < 0) throw new Error(`unknown workspace ${id}`)
      const [entity] = items.splice(from, 1)
      const at = beforeId === undefined ? items.length : items.findIndex((item) => item.id === beforeId)
      items.splice(at < 0 ? items.length : at, 0, entity)
      return items.map((item) => item.id)
    },
  }
}

/** 造一个带内存状态持久化的整理器。 */
function makeOrganizer(paths, config) {
  const registry = fakeRegistry(paths)
  const state = { createdIds: [] }
  const organizer = createOrganizer({
    registry,
    readConfig: () => ({ ...DEFAULT_CONFIG, ...config }),
    loadState: () => ({ createdIds: [...state.createdIds], lastResult: state.lastResult }),
    saveState: (next) => { state.createdIds = [...next.createdIds]; state.lastResult = next.lastResult },
    record: () => {},
  })
  return { registry, state, organizer }
}

const PROJ = 'C:\\Users\\dev\\Documents\\MyProjects'

// ── 路径工具 ────────────────────────────────────────────────────────────────

test('pathApi 按路径拼写选择实现', () => {
  assert.equal(pathApi('C:\\Users\\a').sep, '\\')
  assert.equal(pathApi('C:/Users/a').sep, '\\')
  assert.equal(pathApi('\\\\server\\share').sep, '\\')
  assert.equal(pathApi('/home/user').sep, '/')
})

test('canonKey 统一分隔符、去尾斜杠、Windows 忽略大小写', () => {
  assert.equal(canonKey('C:\\Users\\A\\'), canonKey('c:/users/a'))
  assert.equal(canonKey('/home/user/proj/'), '/home/user/proj')
  assert.notEqual(canonKey('/home/User'), canonKey('/home/user'))
})

test('isRootPath 只认文件系统根', () => {
  assert.equal(isRootPath('C:\\'), true)
  assert.equal(isRootPath('/'), true)
  assert.equal(isRootPath('C:\\Users'), false)
  assert.equal(isRootPath('/home'), false)
})

test('ancestorAt 向上取祖先，越过根返回 undefined', () => {
  assert.equal(ancestorAt('C:\\a\\b\\c', 1), 'C:\\a\\b')
  assert.equal(ancestorAt('C:\\a\\b\\c', 2), 'C:\\a')
  assert.equal(ancestorAt('C:\\', 1), undefined)
  assert.equal(ancestorAt('/a/b', 1), '/a')
})

test('folderTitle 取目录名', () => {
  assert.equal(folderTitle('C:\\Users\\dev\\Documents\\MyProjects'), 'MyProjects')
  assert.equal(folderTitle('/home/user/proj'), 'proj')
})

test('normalizeConfig 夹取数值并回退缺省', () => {
  const cfg = normalizeConfig({ minChildren: 0, maxDepth: 99, enabled: false })
  assert.equal(cfg.minChildren, 2)
  assert.equal(cfg.maxDepth, 8)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.autoOrganize, true)
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG)
})

// ── 汇合计划 ────────────────────────────────────────────────────────────────

test('同一个上级目录下的工作区被汇合成一个待建节点', () => {
  const plan = computePlan([
    { id: 'a', path: `${PROJ}\\plugin-workspace` },
    { id: 'b', path: `${PROJ}\\demo-app` },
    { id: 'c', path: 'C:\\Users\\dev\\Documents\\notes' },
  ], DEFAULT_CONFIG)

  assert.equal(plan.length, 1)
  assert.equal(plan[0].path, PROJ)
  assert.equal(plan[0].childCount, 2)
  assert.deepEqual(plan[0].childIds, ['a', 'b'])
  assert.equal(plan[0].state, 'pending')
})

test('只有一个子工作区的目录不建节点（minChildren=2）', () => {
  const plan = computePlan([
    { id: 'a', path: 'C:\\Users\\dev\\Documents\\notes' },
    { id: 'b', path: 'C:\\Users\\dev\\code\\webapp' },
  ], DEFAULT_CONFIG)
  assert.equal(plan.length, 0)
})

test('minChildren=3 时两个子工作区的目录被排除', () => {
  const plan = computePlan([
    { id: 'a', path: `${PROJ}\\x` },
    { id: 'b', path: `${PROJ}\\y` },
    { id: 'c', path: `${PROJ}\\z` },
  ], { ...DEFAULT_CONFIG, minChildren: 3 })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].childCount, 3)
})

test('上级目录本身已是工作区时标记为 merged', () => {
  const plan = computePlan([
    { id: 'parent', path: PROJ },
    { id: 'a', path: `${PROJ}\\plugin-workspace` },
    { id: 'b', path: `${PROJ}\\demo-app` },
  ], DEFAULT_CONFIG)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].state, 'merged')
  assert.equal(plan[0].existingId, 'parent')
  assert.deepEqual(plan[0].childIds, ['a', 'b'])
})

test('maxDepth=2 会为更上层公共祖先建节点', () => {
  const plan = computePlan([
    { id: 'a', path: `${PROJ}\\x\\one` },
    { id: 'b', path: `${PROJ}\\y\\two` },
  ], { ...DEFAULT_CONFIG, maxDepth: 2 })
  const paths = plan.map((group) => group.path)
  // 第一级的 x / y 各只有一个子工作区，被 minChildren 过滤；只剩第二级的 PROJ。
  assert.deepEqual(paths, [PROJ])
  assert.equal(plan[0].childCount, 2)
  assert.equal(plan[0].depth, 2)
})

test('文件系统根永不作为文件夹节点', () => {
  const plan = computePlan([
    { id: 'a', path: 'C:\\A' },
    { id: 'b', path: 'C:\\B' },
  ], { ...DEFAULT_CONFIG, maxDepth: 4 })
  assert.equal(plan.length, 0)
})

test('POSIX 路径同样工作', () => {
  const plan = computePlan([
    { id: 'a', path: '/home/me/work/alpha' },
    { id: 'b', path: '/home/me/work/beta' },
  ], DEFAULT_CONFIG)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].path, '/home/me/work')
  assert.equal(folderTitle(plan[0].path), 'work')
})

test('childIds 保持注册顺序，便于排序锚点', () => {
  const plan = computePlan([
    { id: 'z', path: `${PROJ}\\zzz` },
    { id: 'a', path: `${PROJ}\\aaa` },
  ], DEFAULT_CONFIG)
  assert.deepEqual(plan[0].childIds, ['z', 'a'])
})

test('真实形态：多级目录同时汇合，且不会向上级联', () => {
  const plan = computePlan([
    { id: 'p1', path: `${PROJ}\\plugin-workspace` },
    { id: 'p2', path: `${PROJ}\\demo-app` },
    { id: 'p3', path: `${PROJ}\\dsh-plugin-memory` },
    { id: 't1', path: 'C:\\Users\\dev\\code\\sandbox' },
    { id: 't2', path: 'C:\\Users\\dev\\code\\sandbox\\perf-test' },
    { id: 't3', path: 'C:\\Users\\dev\\code\\sandbox\\perf-baseline' },
    { id: 'solo', path: 'C:\\Users\\dev\\Documents\\notes' },
  ], DEFAULT_CONFIG)

  const byPath = new Map(plan.map((group) => [group.path, group]))
  // MyProjects 有 3 个同级工作区 -> 待建。
  assert.equal(byPath.get(PROJ).state, 'pending')
  assert.equal(byPath.get(PROJ).childCount, 3)
  // sandbox 已经是工作区，2 个同级子工作区 -> merged。
  const testing = byPath.get('C:\\Users\\dev\\code\\sandbox')
  assert.equal(testing.state, 'merged')
  assert.equal(testing.childCount, 2)
  // code 下只有「sandbox」一个工作区 -> 不建节点。
  assert.equal(byPath.has('C:\\Users\\dev\\code'), false)
  // 防级联：MyProjects 是本轮要新建的文件夹节点，不再算作 Documents 的同级成员，
  // 所以 Documents 只剩「notes」一个，不该被建出来。
  assert.equal(byPath.has('C:\\Users\\dev\\Documents'), false)
})

test('防级联：本插件建出的文件夹节点不再参与上一层的汇合', () => {
  const workspaces = [
    { id: 'folder', path: PROJ }, // 本插件建出来的文件夹节点（已注册）
    { id: 'f1', path: `${PROJ}\\one` },
    { id: 'f2', path: `${PROJ}\\two` },
    { id: 'solo', path: 'C:\\Users\\dev\\Documents\\notes' },
  ]

  // 没有记录 folderKeys 时，MyProjects 被当成普通工作区，Documents 下凑出两个成员。
  const naive = computePlan(workspaces, DEFAULT_CONFIG)
  assert.equal(naive.find((group) => group.path === 'C:\\Users\\dev\\Documents').childCount, 2)

  // 记录为「本插件创建的文件夹节点」后，它不再是 Documents 的成员，级联被打断。
  const guarded = computePlan(workspaces, DEFAULT_CONFIG, { folderKeys: [PROJ] })
  assert.equal(guarded.some((group) => group.path === 'C:\\Users\\dev\\Documents'), false)
})

test('用户自己注册的父级工作区仍然算作上一层的同级成员', () => {
  const plan = computePlan([
    { id: 'parent', path: PROJ },
    { id: 'a', path: `${PROJ}\\plugin-workspace` },
    { id: 'b', path: `${PROJ}\\demo-app` },
    { id: 'solo', path: 'C:\\Users\\dev\\Documents\\notes' },
  ], DEFAULT_CONFIG)
  const byPath = new Map(plan.map((group) => [group.path, group]))
  // MyProjects 是用户注册的工作区（不是插件建的文件夹节点），因此 Documents 有 2 个成员。
  assert.equal(byPath.get('C:\\Users\\dev\\Documents').childCount, 2)
})

// ── 整理器 ──────────────────────────────────────────────────────────────────

test('organize(apply=false) 只预览，不写注册表', async () => {
  const { registry, organizer } = makeOrganizer([
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
  ])
  const before = registry.items.length
  const result = await organizer.organize({ apply: false })
  assert.equal(result.applied, false)
  assert.equal(result.createdCount, 0)
  assert.equal(registry.items.length, before)
  assert.equal(result.actions[0].action, 'create')
})

test('organize(apply=true) 建出文件夹节点并记录到状态', async () => {
  const { registry, state, organizer } = makeOrganizer([
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
  ])
  const result = await organizer.organize({ apply: true })
  assert.equal(result.createdCount, 1)
  assert.equal(result.failedCount, 0)
  assert.equal(state.createdIds.length, 1)

  const folder = registry.items.find((item) => canonKey(item.path) === canonKey(PROJ))
  assert.ok(folder, '文件夹节点应已注册')
  assert.equal(folder.title, 'MyProjects')
  // keepOrder：文件夹应排在它的第一个子工作区之前。
  const folderIndex = registry.items.findIndex((item) => item.id === folder.id)
  const firstChildIndex = registry.items.findIndex((item) => canonKey(item.path) === canonKey(`${PROJ}\\plugin-workspace`))
  assert.ok(folderIndex < firstChildIndex, '文件夹节点应排在子工作区之前')
})

test('organize 幂等：第二次执行不再新建', async () => {
  const { state, organizer } = makeOrganizer([
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
  ])
  await organizer.organize({ apply: true })
  const second = await organizer.organize({ apply: true })
  assert.equal(second.createdCount, 0)
  assert.equal(second.actions.filter((action) => action.action === 'existing').length, 1)
  assert.equal(state.createdIds.length, 1)
})

test('unmerge 删除本插件创建且没有会话的节点', async () => {
  const { registry, state, organizer } = makeOrganizer([
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
  ])
  await organizer.organize({ apply: true })
  const result = await organizer.unmerge()
  assert.equal(result.removed.length, 1)
  assert.equal(result.remainingCount, 0)
  assert.equal(state.createdIds.length, 0)
  assert.equal(registry.items.some((item) => canonKey(item.path) === canonKey(PROJ)), false)
})

test('unmerge 保留已经在用的文件夹节点（有会话）', async () => {
  const { registry, state, organizer } = makeOrganizer([
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
  ])
  await organizer.organize({ apply: true })
  const folderId = state.createdIds[0]
  // 模拟用户已经在文件夹节点下开了会话。
  const folder = registry.items.find((item) => item.id === folderId)
  assert.ok(folder, '文件夹节点应已注册')
  folder.sessionIds.push('session-in-use')

  const result = await organizer.unmerge()
  assert.equal(result.removed.length, 0)
  assert.equal(result.kept.length, 1)
  assert.match(result.kept[0].reason, /会话/)
  assert.equal(result.remainingCount, 1)
  assert.ok(registry.items.some((item) => item.id === folderId), '在用节点必须保留')
})

test('unmerge 不动用户自己建的工作区', async () => {
  const { registry, organizer } = makeOrganizer([
    { id: 'user-made', path: 'C:\\Users\\dev\\Documents\\notes' },
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
  ])
  await organizer.organize({ apply: true })
  const result = await organizer.unmerge()
  assert.equal(result.removed.length, 1)
  assert.ok(registry.items.some((item) => item.id === 'user-made'), '用户工作区必须保留')
})

test('status 汇总工作区、分组与已建节点', async () => {
  const { organizer } = makeOrganizer([
    { path: `${PROJ}\\plugin-workspace` },
    { path: `${PROJ}\\demo-app` },
    { path: 'C:\\Users\\dev\\Documents\\notes' },
  ])
  const status = organizer.status()
  assert.equal(status.workspaceCount, 3)
  assert.equal(status.groupCount, 1)
  assert.equal(status.pendingCount, 1)
  assert.equal(status.mergedCount, 0)
  assert.equal(status.groups[0].title, 'MyProjects')
})

test('workspaceRegistry 不可用时优雅失败', async () => {
  const organizer = createOrganizer({ registry: undefined, readConfig: () => DEFAULT_CONFIG })
  const result = await organizer.organize({ apply: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /workspaceRegistry/)
})
