/**
 * 契约测试：包元数据、挂载 Patch、构建产物。
 * 这些是「发布到 npm 后插件能不能被 DSH 正确加载」的静态保障。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(resolve(ROOT, relative), 'utf8')

test('package.json 声明了 DSH 挂载所需的一切', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, 'dsh-plugin-better-folders')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  // 坑 2：files 漏写 cordis.patch.yml，npm 安装后插件根本不加载。
  assert.ok(pkg.files.includes('cordis.patch.yml'), 'files 必须包含 cordis.patch.yml')
  assert.ok(pkg.files.includes('lib'), 'files 必须包含 lib')
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('cordis.patch.yml 是合法的 insert 声明', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^-\s*insert:/m)
  assert.match(patch, /id:\s*better-folders/)
  assert.match(patch, /name:\s*'dsh-plugin-better-folders'/)
})

test('构建产物存在且不夹带外部依赖', () => {
  const hostPath = resolve(ROOT, 'lib/index.js')
  const clientPath = resolve(ROOT, 'lib/client.js')
  assert.ok(existsSync(hostPath), '缺少 lib/index.js（先跑 npm run build）')
  assert.ok(existsSync(clientPath), '缺少 lib/client.js（先跑 npm run build）')

  const host = readFileSync(hostPath, 'utf8')
  const client = readFileSync(clientPath, 'utf8')

  // 官方包与 node 内置模块必须保持 external，不能被 bundle 进来。
  assert.ok(!/require\(["']node:fs["']\)/.test(host), 'host 产物夹带了 node:fs')
  assert.ok(!host.includes('window.__ModuleLoader__'), 'host 产物不应含客户端包装')
  assert.ok(client.includes('window.__ModuleLoader__.load'), 'client 产物缺 ModuleLoader 包装')
  assert.ok(client.includes('"dsh-plugin-better-folders"'), 'client 产物缺插件 id')
})
