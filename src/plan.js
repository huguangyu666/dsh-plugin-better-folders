/**
 * dsh-plugin-better-folders —— 核心分组算法（纯函数，零外部依赖，便于单测）。
 *
 * 设计要点：
 * 1. DSH 侧边栏自带的「按工作区树」（groupBy = "workspace-tree"）会把每个工作区
 *    挂到**最近的已注册祖先工作区**下面（见 @deepseek-ai/dsh-client-ui-workspace）。
 * 2. 所以「把相同上一级目录的工作区汇合在一起」在本插件里 = 把那个共同的上级目录
 *    本身注册成一个工作区（下称「文件夹节点」）。注册后内置树视图会自动把子工作区
 *    嵌进它下面，不需要插件自己去画 UI。
 * 3. 只对「子工作区数量 >= minChildren」的上级目录建节点，避免给只有一个子工作区
 *    的目录造出无意义的空文件夹。
 *
 * 本模块不触碰 ctx / 文件系统 / 设置，全部输入由调用方注入，因此可以直接被
 * node --test 覆盖。
 *
 * @module dsh-plugin-better-folders/plan
 */

import path from 'node:path'

/** Windows 盘符绝对路径，如 `C:\Users\x` 或 `C:/Users/x`。 */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/
/** Windows UNC 绝对路径，如 `\\server\share`。 */
const WIN_UNC = /^\\\\/

/** 插件默认配置（同时也是设置项的默认值）。 */
export const DEFAULT_CONFIG = {
  enabled: true,
  autoOrganize: true,
  minChildren: 2,
  maxDepth: 1,
  autoTreeView: true,
  keepOrder: true,
}

/**
 * 选择与路径拼写匹配的 path 实现：Windows 盘符/UNC 用 win32，其余用 posix。
 * 这样在 Windows 主机上处理 Windows 路径、在 Linux 主机上处理 POSIX 路径都不会串味。
 * @param {string} p 任意路径。
 * @returns {typeof path.win32 | typeof path.posix} 对应的 path 实现。
 */
export function pathApi(p) {
  const value = typeof p === 'string' ? p : ''
  return WIN_DRIVE.test(value) || WIN_UNC.test(value) ? path.win32 : path.posix
}

/**
 * 路径去重/比较用的规范化键：统一分隔符、去掉结尾分隔符，Windows 下忽略大小写。
 * 不解析 symlink —— 工作区记录本身已经是 realpath 规范化过的。
 * @param {string} p 路径。
 * @returns {string} 规范化键（空输入返回空串）。
 */
export function canonKey(p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  const api = pathApi(p)
  if (api === path.win32) {
    const unified = p.replace(/\//g, '\\').replace(/\\+$/, '')
    return (unified.length === 0 ? p.replace(/\//g, '\\') : unified).toLowerCase()
  }
  const unified = p.replace(/\/+$/, '')
  return unified.length === 0 ? '/' : unified
}

/**
 * 是否已经是文件系统根（`C:\`、`/`、UNC 共享根）。
 * @param {string} p 路径。
 * @returns {boolean} 根路径为 true。
 */
export function isRootPath(p) {
  if (typeof p !== 'string' || p.length === 0) return true
  const api = pathApi(p)
  return api.dirname(p) === p
}

/**
 * 向上取第 `levels` 级祖先目录。
 * @param {string} p 起始路径。
 * @param {number} levels 向上级数（>= 1）。
 * @returns {string | undefined} 祖先目录，越过根时返回 undefined。
 */
export function ancestorAt(p, levels) {
  let current = p
  for (let i = 0; i < levels; i += 1) {
    if (typeof current !== 'string' || current.length === 0) return undefined
    const api = pathApi(current)
    const next = api.dirname(current)
    if (!next || next === current) return undefined
    current = next
  }
  return current
}

/**
 * 把任意输入收敛成合法配置：数值夹取、布尔取真值、缺省回退。
 * @param {object} [raw] 原始配置。
 * @returns {typeof DEFAULT_CONFIG} 规范化后的配置。
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const int = (value, fallback, min, max) => {
    const n = Math.floor(Number(value))
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    enabled: source.enabled !== false,
    autoOrganize: source.autoOrganize !== false,
    minChildren: int(source.minChildren, DEFAULT_CONFIG.minChildren, 2, 64),
    maxDepth: int(source.maxDepth, DEFAULT_CONFIG.maxDepth, 1, 8),
    autoTreeView: source.autoTreeView !== false,
    keepOrder: source.keepOrder !== false,
  }
}

/**
 * 文件夹节点的显示标题：默认取目录名。
 * @param {string} p 目录路径。
 * @returns {string} 标题（取不到目录名时回退为原路径）。
 */
export function folderTitle(p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  const api = pathApi(p)
  const base = api.basename(p)
  return base || p
}

/**
 * 计算「汇合计划」：哪些上级目录应该成为文件夹节点。
 *
 * **防级联**：本插件建出来的文件夹节点不再作为上一层汇合的「同级工作区」分子，
 * 否则每新建一层都会在更上一层凑出新的配对，一路级联到盘符根（例如
 * `MyProjects` 建好后，`Documents` 下就凭空多出「MyProjects + notes」两个成员，
 * 于是又建一个 Documents 节点）。因此本函数会迭代到不动点：先把已建的文件夹节点
 * 排除，再把本轮将要新建的节点也排除，直到不再有新的节点被接受。
 *
 * 注意：**用户自己注册的父级工作区不受此规则影响** —— 它始终算作上级的同级成员
 * （例如用户已把 `sandbox` 建成工作区，它仍会正常挂在 `code` 下面）。
 *
 * @param {Array<{ id: string, path: string }>} workspaces 已注册工作区（按注册顺序）。
 * @param {object} [rawConfig] 插件配置。
 * @param {{ folderKeys?: Set<string> | string[] }} [options] 已由本插件创建的文件夹节点路径集合。
 * @returns {Array<{
 *   path: string, key: string, depth: number, childIds: string[],
 *   childCount: number, existingId?: string, existingTitle?: string,
 *   state: 'merged' | 'pending',
 * }>} 计划条目，按路径排序。
 */
export function computePlan(workspaces, rawConfig, options) {
  const config = normalizeConfig(rawConfig)
  const list = Array.isArray(workspaces) ? workspaces : []

  /** 已注册路径 -> 工作区，用于判断「这个上级目录是不是已经是工作区了」。 */
  const registered = new Map()
  for (const workspace of list) {
    const key = canonKey(workspace?.path)
    if (key && !registered.has(key)) registered.set(key, workspace)
  }

  /** 本插件已经建出来的文件夹节点（规范化路径）。 */
  const folderKeys = new Set()
  const seed = options?.folderKeys
  if (seed instanceof Set) {
    for (const key of seed) folderKeys.add(typeof key === 'string' ? canonKey(key) : '')
  } else if (Array.isArray(seed)) {
    for (const key of seed) folderKeys.add(canonKey(key))
  }
  folderKeys.delete('')

  /**
   * 统计每个候选上级目录的同级成员。
   * @param {Set<string>} excluded 规范化路径，命中者不参与统计。
   * @returns {Map<string, { path: string, key: string, depth: number, childIds: string[] }>} 候选表。
   */
  const countChildren = (excluded) => {
    const candidates = new Map()
    for (const workspace of list) {
      const id = workspace?.id
      const start = workspace?.path
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof start !== 'string' || start.length === 0) continue
      if (excluded.has(canonKey(start))) continue

      let current = start
      for (let depth = 1; depth <= config.maxDepth; depth += 1) {
        const parent = ancestorAt(current, 1)
        if (parent === undefined) break
        // 根目录（C:\、/）不作为文件夹节点：它下面几乎总是有东西，建出来只会碍事。
        if (isRootPath(parent)) break
        const key = canonKey(parent)
        if (!key) break
        let entry = candidates.get(key)
        if (entry === undefined) {
          entry = { path: parent, key, depth, childIds: [] }
          candidates.set(key, entry)
        }
        if (!entry.childIds.includes(id)) entry.childIds.push(id)
        current = parent
      }
    }
    return candidates
  }

  /** 从候选表里挑出达标（同级成员 >= minChildren）的目录 key。 */
  const acceptOf = (candidates) => {
    const accepted = new Set()
    for (const entry of candidates.values()) {
      if (entry.childIds.length >= config.minChildren) accepted.add(entry.key)
    }
    return accepted
  }

  // 迭代到不动点：excluded 只增不减，因此必然终止（上界是候选目录数量）。
  let excluded = new Set(folderKeys)
  let candidates = countChildren(excluded)
  let accepted = acceptOf(candidates)
  for (let round = 0; round <= config.maxDepth + 1; round += 1) {
    let grew = false
    for (const key of accepted) {
      // 用户自己注册的父级工作区不算「插件建的文件夹节点」，不排除。
      if (registered.has(key) || excluded.has(key)) continue
      excluded.add(key)
      grew = true
    }
    if (!grew) break
    candidates = countChildren(excluded)
    accepted = acceptOf(candidates)
  }

  const merges = []
  for (const entry of candidates.values()) {
    if (!accepted.has(entry.key)) continue
    const existing = registered.get(entry.key)
    merges.push({
      path: entry.path,
      key: entry.key,
      depth: entry.depth,
      childIds: entry.childIds,
      childCount: entry.childIds.length,
      existingId: existing === undefined ? undefined : existing.id,
      existingTitle: existing === undefined ? undefined : existing.title,
      state: existing === undefined ? 'pending' : 'merged',
    })
  }

  merges.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return merges
}

/**
 * 生成可读的分组摘要（给面板/工具输出用）。
 * @param {ReturnType<typeof computePlan>} groups 计划。
 * @returns {Array<{ path: string, title: string, childCount: number, state: string }>} 摘要行。
 */
export function summarizeGroups(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    path: group.path,
    title: folderTitle(group.path),
    childCount: group.childCount,
    state: group.state,
  }))
}

/**
 * 用注入的依赖构造「整理器」。所有副作用（注册表读写、配置读写、状态持久化）
 * 都由调用方以函数形式提供，方便在测试里替换成内存实现。
 *
 * @param {object} deps 依赖集合。
 * @param {{ list: Function, get: Function, create: Function, delete: Function, insertBefore?: Function }} deps.registry 工作区注册表（ctx.workspaceRegistry）。
 * @param {() => object} deps.readConfig 读取当前配置。
 * @param {() => { createdIds?: string[] }} deps.loadState 读取插件状态。
 * @param {(state: object) => void} [deps.saveState] 写入插件状态。
 * @param {(event: object) => void} [deps.record] 记录运行结果（供 /status 展示）。
 * @param {(...args: unknown[]) => void} [deps.log] 日志。
 * @returns {{ planOf: Function, status: Function, organize: Function, unmerge: Function }} 整理器。
 */
export function createOrganizer(deps) {
  const registry = deps?.registry
  const readConfig = typeof deps?.readConfig === 'function' ? deps.readConfig : () => DEFAULT_CONFIG
  const loadState = typeof deps?.loadState === 'function' ? deps.loadState : () => ({ createdIds: [] })
  const saveState = typeof deps?.saveState === 'function' ? deps.saveState : () => {}
  const record = typeof deps?.record === 'function' ? deps.record : () => {}
  const log = typeof deps?.log === 'function' ? deps.log : () => {}

  /** 读取当前工作区的精简快照。 */
  function snapshotWorkspaces() {
    let raw
    try {
      raw = typeof registry?.list === 'function' ? registry.list() : []
    } catch (error) {
      log('读取工作区列表失败:', error?.message ?? error)
      raw = []
    }
    return (Array.isArray(raw) ? raw : [])
      .map((workspace) => ({
        id: workspace?.id,
        path: workspace?.path,
        title: workspace?.title,
        sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
      }))
      .filter((workspace) => typeof workspace.id === 'string' && workspace.id.length > 0
        && typeof workspace.path === 'string' && workspace.path.length > 0)
  }

  /** 本插件创建过的文件夹节点路径（用于防级联）。 */
  function trackedFolderKeys() {
    const state = loadState()
    const keys = []
    for (const id of Array.isArray(state?.createdIds) ? state.createdIds : []) {
      const entity = typeof registry?.get === 'function' ? registry.get(id) : undefined
      if (entity !== undefined && typeof entity.path === 'string' && entity.path.length > 0) keys.push(entity.path)
    }
    return keys
  }

  /** 计算配置 + 快照 + 计划。 */
  function planOf() {
    const config = normalizeConfig(readConfig())
    const workspaces = snapshotWorkspaces()
    const groups = computePlan(workspaces, config, { folderKeys: trackedFolderKeys() })
    return { config, workspaces, groups }
  }

  /** 当前状态（面板 / 工具 / 指令共用）。 */
  function status() {
    const { config, workspaces, groups } = planOf()
    const state = loadState()
    const createdIds = Array.isArray(state?.createdIds) ? state.createdIds : []
    const tracked = createdIds
      .map((id) => {
        const entity = typeof registry?.get === 'function' ? registry.get(id) : undefined
        return entity === undefined
          ? { id, path: undefined, alive: false }
          : { id, path: entity.path, alive: true, title: entity.title }
      })
    return {
      ok: true,
      plugin: 'dsh-plugin-better-folders',
      config,
      workspaceCount: workspaces.length,
      groupCount: groups.length,
      pendingCount: groups.filter((group) => group.state === 'pending').length,
      mergedCount: groups.filter((group) => group.state === 'merged').length,
      groups: summarizeGroups(groups),
      trackedFolders: tracked,
      lastResult: state?.lastResult ?? null,
    }
  }

  /**
   * 执行整理。`apply` 为 false 时只预览，不写任何东西。
   * @param {{ apply?: boolean }} [options] 选项。
   * @returns {Promise<object>} 结果报告。
   */
  async function organize(options) {
    const apply = options?.apply === true
    if (typeof registry?.list !== 'function') {
      return { ok: false, applied: false, error: 'workspaceRegistry 不可用' }
    }
    const { config, workspaces, groups } = planOf()
    const state = loadState()
    const createdIds = new Set(Array.isArray(state?.createdIds) ? state.createdIds : [])
    const known = new Set(workspaces.map((workspace) => workspace.id))

    const actions = []
    for (const group of groups) {
      if (group.existingId !== undefined) {
        actions.push({
          path: group.path,
          action: 'existing',
          folderId: group.existingId,
          childCount: group.childCount,
        })
        continue
      }
      if (!apply) {
        actions.push({
          path: group.path,
          action: 'create',
          childCount: group.childCount,
          title: folderTitle(group.path),
        })
        continue
      }
      try {
        const entity = await registry.create(group.path, folderTitle(group.path))
        const id = entity?.id
        if (typeof id === 'string' && id.length > 0) createdIds.add(id)

        // 把新文件夹排到它的第一个子工作区之前，让树视图里的顺序符合直觉。
        let placedBefore
        if (config.keepOrder && typeof id === 'string' && typeof registry?.insertBefore === 'function') {
          const anchor = group.childIds.find((childId) => known.has(childId) && childId !== id)
          if (anchor !== undefined) {
            try {
              await registry.insertBefore(id, anchor)
              placedBefore = anchor
            } catch (error) {
              log('文件夹排序跳过:', error?.message ?? error)
            }
          }
        }
        actions.push({
          path: group.path,
          action: 'created',
          folderId: id,
          childCount: group.childCount,
          placedBefore,
        })
      } catch (error) {
        actions.push({
          path: group.path,
          action: 'failed',
          childCount: group.childCount,
          error: String(error?.message ?? error),
        })
      }
    }

    const createdCount = actions.filter((action) => action.action === 'created').length
    const failedCount = actions.filter((action) => action.action === 'failed').length
    if (apply) {
      saveState({
        createdIds: [...createdIds],
        lastResult: { at: Date.now(), created: createdCount, failed: failedCount },
      })
      record({ at: Date.now(), ok: failedCount === 0, created: createdCount, failed: failedCount })
    }
    return {
      ok: failedCount === 0,
      applied: apply,
      config,
      workspaceCount: workspaces.length,
      groups: summarizeGroups(groups),
      actions,
      createdCount,
      failedCount,
      trackedCount: createdIds.size,
    }
  }

  /**
   * 还原：只删除本插件创建、且**没有挂任何会话**的文件夹节点。
   * 用户已经在文件夹里开过会话时保留，避免误删用户正在用的工作区。
   * @returns {Promise<object>} 结果报告。
   */
  async function unmerge() {
    if (typeof registry?.get !== 'function' || typeof registry?.delete !== 'function') {
      return { ok: false, error: 'workspaceRegistry 不可用' }
    }
    const state = loadState()
    const ids = Array.isArray(state?.createdIds) ? state.createdIds : []
    const removed = []
    const kept = []
    const remaining = []
    for (const id of ids) {
      const entity = registry.get(id)
      if (entity === undefined) continue
      const sessionCount = Array.isArray(entity.sessionIds) ? entity.sessionIds.length : 0
      if (sessionCount > 0) {
        kept.push({ id, path: entity.path, reason: `已有 ${sessionCount} 个会话，保留` })
        remaining.push(id)
        continue
      }
      try {
        await registry.delete(id)
        removed.push({ id, path: entity.path })
      } catch (error) {
        kept.push({ id, path: entity.path, reason: String(error?.message ?? error) })
        remaining.push(id)
      }
    }
    saveState({ createdIds: remaining, lastResult: { at: Date.now(), removed: removed.length } })
    record({ at: Date.now(), ok: true, removed: removed.length })
    return { ok: true, removed, kept, remainingCount: remaining.length }
  }

  return { planOf, status, organize, unmerge }
}
