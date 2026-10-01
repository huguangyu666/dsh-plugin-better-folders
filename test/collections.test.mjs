/**
 * 「表」（工作区集合）模型测试。
 *
 * 核心不变量：表只是 id 的集合，任何操作都不得触碰工作区本身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMBERS_MAX,
  NAME_MAX_LENGTH,
  collectionsOfWorkspace,
  createCollection,
  deleteCollection,
  normalizeCollections,
  normalizeMemberIds,
  normalizeName,
  renameCollection,
  setMembers,
  toggleMember,
} from '../src/collections.js'

test('normalizeName 去空白、折叠内部空白、截断超长', () => {
  assert.equal(normalizeName('  性能  对比  '), '性能 对比')
  assert.equal(normalizeName(undefined), '')
  assert.equal(normalizeName('x'.repeat(100)).length, NAME_MAX_LENGTH)
})

test('normalizeMemberIds 去空、去重、保序、限长', () => {
  assert.deepEqual(normalizeMemberIds(['b', 'a', 'b', '', null, 'c']), ['b', 'a', 'c'])
  assert.deepEqual(normalizeMemberIds('not-an-array'), [])
  assert.equal(normalizeMemberIds(Array.from({ length: 900 }, (_, i) => `w${i}`)).length, MEMBERS_MAX)
})

test('normalizeCollections 丢弃损坏条目而不抛错', () => {
  assert.deepEqual(normalizeCollections(null), [])
  assert.deepEqual(normalizeCollections('garbage'), [])
  const list = normalizeCollections({ collections: [null, 42, { id: 'a', name: ' 表 ', workspaceIds: ['w1', 'w1'] }] })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '表')
  assert.deepEqual(list[0].workspaceIds, ['w1'])
})

test('createCollection 追加新表并补默认名', () => {
  const first = createCollection([], '')
  assert.equal(first.collections.length, 1)
  assert.equal(first.collection.name, '表 1')
  const second = createCollection(first.collections, '性能对比', ['w1'])
  assert.equal(second.collections.length, 2)
  assert.deepEqual(second.collection.workspaceIds, ['w1'])
  assert.notEqual(second.collection.id, first.collection.id)
})

test('renameCollection 改名字，空名字视为无效', () => {
  const created = createCollection([], '旧名')
  const renamed = renameCollection(created.collections, created.collection.id, '新名')
  assert.equal(renamed.changed, true)
  assert.equal(renamed.collections[0].name, '新名')
  const rejected = renameCollection(renamed.collections, created.collection.id, '   ')
  assert.equal(rejected.changed, false)
  assert.equal(rejected.collections[0].name, '新名')
})

test('deleteCollection 只删表本身', () => {
  const a = createCollection([], 'A', ['w1', 'w2'])
  const b = createCollection(a.collections, 'B')
  const result = deleteCollection(b.collections, a.collection.id)
  assert.equal(result.removed, true)
  assert.equal(result.collections.length, 1)
  assert.equal(result.collections[0].name, 'B')
  // 未知 id 是幂等 no-op
  assert.equal(deleteCollection(result.collections, 'nope').removed, false)
})

test('setMembers 整表替换且保序', () => {
  const a = createCollection([], 'A', ['w1'])
  const result = setMembers(a.collections, a.collection.id, ['w3', 'w1', 'w2'])
  assert.equal(result.changed, true)
  assert.deepEqual(result.collections[0].workspaceIds, ['w3', 'w1', 'w2'])
  // 相同内容不算变化
  const again = setMembers(result.collections, a.collection.id, ['w3', 'w1', 'w2'])
  assert.equal(again.changed, false)
})

test('toggleMember 加入 / 移出', () => {
  const a = createCollection([], 'A')
  const added = toggleMember(a.collections, a.collection.id, 'w1')
  assert.equal(added.added, true)
  assert.deepEqual(added.collections[0].workspaceIds, ['w1'])
  const removed = toggleMember(added.collections, a.collection.id, 'w1')
  assert.equal(removed.added, false)
  assert.deepEqual(removed.collections[0].workspaceIds, [])
  // 未知表是 no-op
  assert.equal(toggleMember(removed.collections, 'nope', 'w1').changed, false)
})

test('同一个工作区可以同时属于多个表', () => {
  const a = createCollection([], 'A', ['w1'])
  const b = createCollection(a.collections, 'B', ['w1', 'w2'])
  const ids = collectionsOfWorkspace(b.collections, 'w1')
  assert.equal(ids.length, 2)
  assert.deepEqual(collectionsOfWorkspace(b.collections, 'w2'), [b.collection.id])
})
