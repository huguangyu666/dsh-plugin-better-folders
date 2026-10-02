/**
 * 构建脚本：生成 lib/ 发布产物。
 *   lib/index.js   Host 端（ESM bundle）
 *   lib/client.js  Client 端（CJS bundle + window.__ModuleLoader__ 包装）
 *
 * 铁律：`@deepseek-ai/*` 与 `node:*` 一律 external —— DSH 运行时自带，
 * 打进产物只会造成双份实例和解析失败。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'dsh-plugin-better-folders'
const ROOT = dirname(fileURLToPath(import.meta.url))

rmSync(resolve(ROOT, 'lib'), { recursive: true, force: true })
mkdirSync(resolve(ROOT, 'lib'), { recursive: true })

// 1) Host 端：ESM bundle
execSync([
  'npx esbuild src/index.js',
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=es2022',
  '--charset=utf8',
  '--external:node:*',
  '--external:@deepseek-ai/*',
  '--outfile=lib/index.js',
].join(' '), { cwd: ROOT, stdio: 'inherit', shell: true })

// 2) Client 端：CJS + 官方 ModuleLoader 包装
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`
const footer = `return module.exports; } });`

execSync([
  'npx esbuild src/client-source.js',
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--charset=utf8',
  '--external:react',
  '--external:react/jsx-runtime',
  '--external:@deepseek-ai/*',
  '--log-override:commonjs-variable-in-esm=silent',
  `--banner:js=${JSON.stringify(banner)}`,
  `--footer:js=${JSON.stringify(footer)}`,
  '--outfile=lib/client.js',
].join(' '), { cwd: ROOT, stdio: 'inherit', shell: true })

// 3) 产物自检
const host = readFileSync(resolve(ROOT, 'lib/index.js'), 'utf8')
const client = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')

const checks = [
  [host.includes(ID), 'host bundle 缺插件标识'],
  [host.includes('organize_workspaces'), 'host bundle 缺 organize_workspaces 工具'],
  [host.includes('better-folders/api'), 'host bundle 缺 HTTP API 前缀'],
  [host.includes('domain/changed'), 'host bundle 缺工作区变化监听'],
  [host.includes('/diag'), 'host bundle 缺客户端诊断落盘点'],
  [client.includes('__ModuleLoader__.load'), 'client bundle 缺 ModuleLoader 包装'],
  [client.includes('settings.section'), 'client bundle 缺 settings.section 注册'],
  [client.includes('dsh.workspace.view.v5'), 'client bundle 缺视图切换逻辑'],
  [client.includes('ensureTreeViewMode'), 'client bundle 缺启动视图校准'],
  [client.includes('uiWorkspace'), 'client bundle 缺 uiWorkspace 依赖声明'],
  [client.includes('reportDiag'), 'client bundle 缺诊断上报'],
  [host.includes('/collections'), 'host bundle 缺「表」HTTP 接口'],
  [host.includes('manage_workspace_tables'), 'host bundle 缺「表」工具'],
  [client.includes('shell.overlay'), 'client bundle 缺标题行浮层注册'],
  [client.includes('sectionHeader'), 'client bundle 缺标题行定位逻辑'],
  [client.includes('TablesPanel'), 'client bundle 缺「表」面板'],
  [client.includes('sidebar.panellist'), 'client bundle 缺侧边栏导航项注册'],
  [client.includes('better-folders.tables'), 'client bundle 缺主区页面键'],
]
for (const [ok, message] of checks) {
  if (!ok) throw new Error(message)
}

console.log('构建完成：lib/index.js + lib/client.js')
console.log(`host: ${host.length} bytes | client: ${client.length} bytes`)
