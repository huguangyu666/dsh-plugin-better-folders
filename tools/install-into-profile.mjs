/**
 * 把「更好的 DSH 文件夹」装进指定 dsh profile —— 带备份、BOM 校验与 dump-config 复核。
 *
 * 用法:
 *   node tools/install-into-profile.mjs --profile web             # 真装
 *   node tools/install-into-profile.mjs --profile web --dry-run   # 只打印将执行的命令
 *   node tools/install-into-profile.mjs --profile web --uninstall # 卸载
 *
 * 做四件事：备份 → 官方命令安装 → 校验（JSON 可解析 / 无 BOM / bundles 已含本插件）
 * → dump-config 复核合成树。任一步失败即打印回滚方法，不留半装状态。
 *
 * 注意：`dsh plugin add` 走 pnpm registry；离线或需要代理时请先设好 HTTPS_PROXY。
 * 装完必须重启 DSH（web/desktop）才会加载 —— 插件是在启动时装配的。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-plugin-better-folders'
const BACKUP_TAG = 'better-folders'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const profile = argOf('--profile', 'web')
const dryRun = args.includes('--dry-run')
const uninstall = args.includes('--uninstall')
const skipVerify = args.includes('--no-verify')

const profileDir = join(homedir(), '.dsh', 'profiles', profile)
const pkgFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')

const fail = (message, rollback) => {
  console.error(`\n❌ ${message}`)
  if (rollback) console.error(`   回滚：${rollback}`)
  process.exit(1)
}

console.log(`[install] 插件目录  : ${ROOT}`)
console.log(`[install] 目标 profile: ${profile}  (${profileDir})`)

if (!existsSync(pkgFile)) {
  fail(`profile 不存在或缺少 package.json：${pkgFile}（先用 dsh --profile ${profile} 初始化）`)
}
if (!existsSync(join(ROOT, 'lib', 'index.js')) || !existsSync(join(ROOT, 'lib', 'client.js'))) {
  fail('lib/ 产物缺失：先在插件目录跑 node build.mjs')
}
if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY && !dryRun) {
  console.warn('[install] ⚠ 未检测到 HTTPS_PROXY/HTTP_PROXY —— pnpm 访问 registry 可能较慢')
}

const before = JSON.parse(readFileSync(pkgFile, 'utf8'))
const already = (before.dsh?.profile?.bundles ?? []).includes(PKG_NAME)
console.log(`[install] 当前 bundles: ${(before.dsh?.profile?.bundles ?? []).join(', ')}`)
console.log(`[install] 已安装: ${already ? '是（将更新）' : '否'}`)

const cmd = uninstall
  ? ['plugin', '--profile', profile, 'remove', PKG_NAME]
  : ['plugin', '--profile', profile, 'add', ROOT]
console.log(`\n[install] 将执行: dsh ${cmd.join(' ')}`)
if (dryRun) {
  console.log('[install] --dry-run：到此为止，未做任何修改')
  process.exit(0)
}

// 1) 备份（坑 3：手工 patch 与 bundle 叠加会导致 duplicate loader entry id）
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const pkgBackup = `${pkgFile}.bak-${BACKUP_TAG}-${stamp}`
copyFileSync(pkgFile, pkgBackup)
let patchBackup = null
if (existsSync(patchFile)) {
  patchBackup = `${patchFile}.bak-${BACKUP_TAG}-${stamp}`
  copyFileSync(patchFile, patchBackup)
}
console.log(`[install] 已备份: ${pkgBackup}${patchBackup ? `\n[install] 已备份: ${patchBackup}` : ''}`)

// 2) 官方安装命令
const result = spawnSync('dsh', cmd, { stdio: 'inherit', shell: true })
if (result.status !== 0) {
  fail(`dsh ${cmd[0]} 失败（exit ${result.status}）`, `copy /Y "${pkgBackup}" "${pkgFile}"`)
}

if (uninstall) {
  console.log(`\n✅ 已卸载 ${PKG_NAME}。重启 DSH 后生效。`)
  process.exit(0)
}

// 3) 校验
let after
try {
  after = JSON.parse(readFileSync(pkgFile, 'utf8'))
} catch (error) {
  fail(`安装后 package.json 无法解析：${error.message}`, `copy /Y "${pkgBackup}" "${pkgFile}"`)
}

// 坑 1：BOM 会让 DSH 启动时 JSON.parse 直接挂。
const bytes = readFileSync(pkgFile).subarray(0, 3)
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
if (hasBom) {
  const text = readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, '')
  writeFileSync(pkgFile, text, 'utf8')
  console.log('[install] ⚠ 检测到 BOM 并已去除')
}

const bundles = after.dsh?.profile?.bundles ?? []
if (!bundles.includes(PKG_NAME)) {
  fail(`bundles 未包含 ${PKG_NAME}（package.json 是否声明了 dsh.bundle.patch？）`, `copy /Y "${pkgBackup}" "${pkgFile}"`)
}
console.log(`[install] ✅ bundles 已包含 ${PKG_NAME}，BOM=${hasBom ? '已清理' : '无'}`)

// 4) dump-config 复核
if (!skipVerify) {
  const dump = spawnSync('dsh', ['--profile', profile, '--dump-config'], { encoding: 'utf8', shell: true })
  if (dump.status !== 0) fail(`dump-config 失败（exit ${dump.status}）`, `copy /Y "${pkgBackup}" "${pkgFile}"`)
  if (!String(dump.stdout).includes(PKG_NAME)) {
    fail('合成树里没有本插件层', `copy /Y "${pkgBackup}" "${pkgFile}"`)
  }
  console.log('[install] ✅ dump-config 合成树包含本插件层')
}

console.log(`\n✅ 安装完成。重启 DSH 后：`)
console.log('   · 设置 → 插件 → 「更好的 DSH 文件夹」可配置与一键整理')
console.log('   · 侧边栏底部出现「📁 整理文件夹」快捷按钮')
console.log('   · 对话里可用 /folders status|plan|organize|unmerge')
console.log(`   卸载：dsh plugin --profile ${profile} remove ${PKG_NAME}`)
console.log(`   回滚：copy /Y "${pkgBackup}" "${pkgFile}"`)
