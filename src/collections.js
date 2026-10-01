/**
 * dsh-plugin-better-folders —— 「表」（工作区集合）数据模型。
 *
 * 与 `plan.js` 的「按上级目录汇合」完全互补：
 *
 *   plan.js   依据**真实目录层级**，把同一个上级目录下的工作区汇合成文件夹节点
 *             —— 汇合关系由磁盘结构决定，用户不能自由指定。
 *   collections.js  依据**用户自己定的集合**，把任意几个工作区圈进一个「表」
 *             —— 表**不落地成任何目录**，不创建文件、不改 cwd、不碰会话历史，
 *             纯粹是「看」和「切」的聚合视图。
 *
 * 同一个工作区可以同时属于多个表；删表不删任何东西。
 *
 * @module dsh-plugin-better-folders/collections
 */

/** 集合名称长度上限。 */
export const NAME_MAX_LENGTH = 40
/** 单个集合的成员上限（防御性，正常用不到）。 */
export const MEMBERS_MAX = 500

/**
 * 生成一个集合 id。
 * @param {number} [now] 时间戳（便于测试注入）。
 * @returns {string} 形如 `col-<base36 时间>-<随机>`。
 */
export function newCollectionId(now = Date.now()) {
  const suffix = Math.random().toString(36).slice(2, 7)
  return `col-${now.toString(36)}-${suffix}`
}

/**
 * 规范化名称：去首尾空白、折叠内部空白、截断超长。
 * @param {unknown} name 原始名称。
 * @returns {string} 规范化后的名称（可能为空串）。
 */
export function normalizeName(name) {
  if (typeof name !== 'string') return ''
  const collapsed = name.trim().replace(/\s+/g, ' ')
  return collapsed.length > NAME_MAX_LENGTH ? collapsed.slice(0, NAME_MAX_LENGTH) : collapsed
}

/**
 * 规范化 id 列表：去空、去重、保序、限长。
 * @param {unknown} ids 原始 id 列表。
 * @returns {string[]} 规范化后的 id 列表。
 */
export function normalizeMemberIds(ids) {
  if (!Array.isArray(ids)) return []
  const seen = new Set()
  const out = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MEMBERS_MAX) break
  }
  return out
}

/**
 * 把任意持久化内容收敛成合法集合列表。损坏条目直接丢弃，绝不抛错 ——
 * 状态文件坏掉不该让插件起不来。
 * @param {unknown} raw 持久化内容（`{ collections: [...] }` 或裸数组）。
 * @returns {Array<{ id: string, name: string, workspaceIds: string[], createdAt: number, updatedAt: number }>} 集合列表。
 */
export function normalizeCollections(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.collections) ? raw.collections : [])
  const seenIds = new Set()
  const out = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : newCollectionId()
    if (seenIds.has(id)) continue
    seenIds.add(id)
    const name = normalizeName(entry.name) || '未命名表'
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now()
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt
    out.push({ id, name, workspaceIds: normalizeMemberIds(entry.workspaceIds), createdAt, updatedAt })
  }
  return out
}

/**
 * 新建一个表。
 * @param {Array} collections 现有集合。
 * @param {string} name 名称。
 * @param {string[]} [workspaceIds] 初始成员。
 * @param {number} [now] 时间戳（便于测试注入）。
 * @returns {{ collections: Array, collection: object }} 新列表与被创建的表。
 */
export function createCollection(collections, name, workspaceIds, now = Date.now()) {
  const list = normalizeCollections(collections)
  const collection = {
    id: newCollectionId(now),
    name: normalizeName(name) || `表 ${list.length + 1}`,
    workspaceIds: normalizeMemberIds(workspaceIds),
    createdAt: now,
    updatedAt: now,
  }
  return { collections: [...list, collection], collection }
}

/**
 * 重命名表。
 * @param {Array} collections 现有集合。
 * @param {string} id 目标 id。
 * @param {string} name 新名称。
 * @param {number} [now] 时间戳。
 * @returns {{ collections: Array, changed: boolean }} 结果。
 */
export function renameCollection(collections, id, name, now = Date.now()) {
  const list = normalizeCollections(collections)
  const next = normalizeName(name)
  if (next.length === 0) return { collections: list, changed: false }
  let changed = false
  const out = list.map((entry) => {
    if (entry.id !== id) return entry
    changed = true
    return { ...entry, name: next, updatedAt: now }
  })
  return { collections: out, changed }
}

/**
 * 删除表。**只删这个集合本身**，不碰任何工作区、会话或磁盘内容。
 * @param {Array} collections 现有集合。
 * @param {string} id 目标 id。
 * @returns {{ collections: Array, removed: boolean }} 结果。
 */
export function deleteCollection(collections, id) {
  const list = normalizeCollections(collections)
  const out = list.filter((entry) => entry.id !== id)
  return { collections: out, removed: out.length !== list.length }
}

/**
 * 整表替换成员（保序）。
 * @param {Array} collections 现有集合。
 * @param {string} id 目标 id。
 * @param {string[]} workspaceIds 新成员列表。
 * @param {number} [now] 时间戳。
 * @returns {{ collections: Array, changed: boolean }} 结果。
 */
export function setMembers(collections, id, workspaceIds, now = Date.now()) {
  const list = normalizeCollections(collections)
  const next = normalizeMemberIds(workspaceIds)
  let changed = false
  const out = list.map((entry) => {
    if (entry.id !== id) return entry
    if (entry.workspaceIds.length === next.length && entry.workspaceIds.every((value, index) => value === next[index])) {
      return entry
    }
    changed = true
    return { ...entry, workspaceIds: next, updatedAt: now }
  })
  return { collections: out, changed }
}

/**
 * 加入 / 移出一个成员。
 * @param {Array} collections 现有集合。
 * @param {string} id 目标 id。
 * @param {string} workspaceId 工作区 id。
 * @param {number} [now] 时间戳。
 * @returns {{ collections: Array, added: boolean, changed: boolean }} 结果。
 */
export function toggleMember(collections, id, workspaceId, now = Date.now()) {
  const list = normalizeCollections(collections)
  const target = list.find((entry) => entry.id === id)
  if (target === undefined || typeof workspaceId !== 'string' || workspaceId.length === 0) {
    return { collections: list, added: false, changed: false }
  }
  const has = target.workspaceIds.includes(workspaceId)
  const next = has
    ? target.workspaceIds.filter((value) => value !== workspaceId)
    : [...target.workspaceIds, workspaceId]
  const result = setMembers(list, id, next, now)
  return { collections: result.collections, added: !has, changed: result.changed }
}

/**
 * 按工作区 id 找到它所属的全部表。
 * @param {Array} collections 集合列表。
 * @param {string} workspaceId 工作区 id。
 * @returns {string[]} 表 id 列表。
 */
export function collectionsOfWorkspace(collections, workspaceId) {
  return normalizeCollections(collections)
    .filter((entry) => entry.workspaceIds.includes(workspaceId))
    .map((entry) => entry.id)
}
