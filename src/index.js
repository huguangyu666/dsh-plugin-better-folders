/**
 * dsh-plugin-better-folders —— 更好的 DSH 文件夹（Host 端）。
 *
 * ## 它解决什么
 * DSH 的工作区（Workspace）是「一个项目目录 + 跑在它下面的会话」。真实使用中这些
 * 目录往往成堆地躺在同一个父目录里，例如：
 *
 *   C:\Users\me\Documents\MyProjects\plugin-workspace
 *   C:\Users\me\Documents\MyProjects\dsh-plugin-memory
 *   C:\Users\me\Documents\MyProjects\demo-app
 *   C:\Users\me\code\sandbox
 *
 * 侧边栏默认的「按工作区」是平铺的，十几个同级目录排成一大列，找起来很累。
 *
 * ## 怎么实现「汇合」
 * DSH 侧边栏自带「按工作区树」视图（groupBy = "workspace-tree"），它把每个工作区
 * 挂到**最近的已注册祖先工作区**下面。于是「把相同上一级目录的工作区汇合在一起」
 * 在本插件里等价于：**把那个共同的上级目录本身注册成一个工作区**（文件夹节点）。
 * 注册完，内置树视图自动把子工作区嵌进去，本插件不需要重画侧边栏。
 *
 * 默认规则（都可在设置里改）：
 *   - minChildren = 2：至少 2 个同级工作区才建文件夹节点（单个没必要）；
 *   - maxDepth = 1：只看直接上级目录（不会一路建到 C:\ 去）；
 *   - keepOrder = true：新节点排在它的第一个子工作区之前；
 *   - autoOrganize = true：工作区列表变化后自动整理；
 *   - autoTreeView = true：整理后把侧边栏切到「按工作区树」。
 *
 * ## 安全边界
 * 本插件**只增不删**：整理只调用 `workspaceRegistry.create()`。还原（unmerge）也
 * 只删除**本插件自己创建过、且没有任何会话**的文件夹节点，用户手动建的工作区和
 * 已经在用的目录一律不碰。删除工作区注册从来不会删除磁盘目录或会话历史。
 *
 * @module dsh-plugin-better-folders
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONFIG,
  createOrganizer,
  normalizeConfig,
} from './plan.js'

export const name = 'dsh-plugin-better-folders'
/** 唯一的硬依赖：没有工作区注册表这个插件就没有意义。其余能力按需注入。 */
export const inject = ['workspaceRegistry']

/** 原生设置的命名空间。 */
const SETTINGS_NS = 'better-folders'
/** HTTP API 前缀（同源，供 Web 面板使用）。 */
const API_PREFIX = '/better-folders/api'

// ── 模块级运行时状态（Cordis 单例插件，重载时整体重建）─────────────────────

/** 插件自己的 settings scope，拿到后才读得到用户配置。 */
let _scope = null
/** 最近一次自动整理的运行结果，供面板/指令展示。 */
let _lastRun = { at: 0, ok: true, error: '', created: 0, failed: 0 }
/** 自动整理防抖定时器。 */
let _autoTimer = null
/** 自动整理重入保护。 */
let _autoRunning = false
/** schemastery 懒加载缓存：`undefined` 未加载，`null` 不可用。 */
let _schemaLib

/** 统一日志前缀。 */
function log(...args) {
  console.log('[better-folders]', ...args)
}

/**
 * 懒加载 schemastery：DSH 运行时会提供，但本地裸跑测试时可能不存在。
 * 加载失败只降级为「没有原生设置表单」，不影响整理能力。
 * @returns {Promise<object | null>} schemastery 的 `z` 对象。
 */
async function schemaLib() {
  if (_schemaLib !== undefined) return _schemaLib
  try {
    const mod = await import('@deepseek-ai/schemastery')
    _schemaLib = mod?.default ?? mod
  } catch (error) {
    _schemaLib = null
    log('schemastery 不可用，跳过原生设置注册:', error?.message ?? error)
  }
  return _schemaLib
}

// ── 配置读取 ────────────────────────────────────────────────────────────────

/**
 * 读取当前配置（settings 未就绪时回退默认值）。
 * @returns {typeof DEFAULT_CONFIG} 规范化配置。
 */
function loadConfig() {
  if (_scope === null) return normalizeConfig(DEFAULT_CONFIG)
  try {
    const value = _scope.get()
    return normalizeConfig(value && typeof value === 'object' ? value : DEFAULT_CONFIG)
  } catch (error) {
    log('读取设置失败，回退默认:', error?.message ?? error)
    return normalizeConfig(DEFAULT_CONFIG)
  }
}

/**
 * 写入部分配置。
 * @param {object} patch 要合并的字段。
 * @returns {Promise<boolean>} 是否写入成功。
 */
async function saveConfig(patch) {
  if (_scope === null || typeof _scope.update !== 'function') return false
  try {
    await _scope.update(patch)
    return true
  } catch (error) {
    log('写入设置失败:', error?.message ?? error)
    return false
  }
}

// ── 插件状态持久化（记录「哪些文件夹节点是本插件建的」）─────────────────────

/** DSH 数据根目录。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 插件状态文件路径。 */
function stateFile() {
  return path.join(dshHome(), 'better-folders', 'state.json')
}

/**
 * 读取插件状态。
 * @returns {{ createdIds: string[], lastResult?: object }} 状态（缺失/损坏时为空状态）。
 */
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return {
      createdIds: Array.isArray(parsed?.createdIds)
        ? parsed.createdIds.filter((id) => typeof id === 'string' && id.length > 0)
        : [],
      lastResult: parsed?.lastResult,
    }
  } catch {
    return { createdIds: [] }
  }
}

/**
 * 写入插件状态。显式用 utf8 且不加 BOM —— DSH 的 JSON.parse 会被 BOM 打挂。
 * @param {{ createdIds: string[], lastResult?: object }} next 新状态。
 * @returns {boolean} 是否写入成功。
 */
function saveState(next) {
  try {
    const file = stateFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    return true
  } catch (error) {
    log('状态写入失败:', error?.message ?? error)
    return false
  }
}

// ── 整理器实例（每次 apply 时按当前 ctx 重建）───────────────────────────────

let _organizer = null

/**
 * 构造整理器。
 * @param {object} ctx Cordis 上下文。
 * @returns {ReturnType<typeof createOrganizer>} 整理器。
 */
function buildOrganizer(ctx) {
  return createOrganizer({
    registry: ctx?.workspaceRegistry,
    readConfig: loadConfig,
    loadState,
    saveState,
    log,
    record: (event) => {
      _lastRun = {
        at: event.at,
        ok: event.ok !== false,
        error: event.error ?? '',
        created: event.created ?? 0,
        failed: event.failed ?? 0,
      }
    },
  })
}

/**
 * 记录一条来自客户端半的诊断快照。
 *
 * 客户端插件跑在浏览器沙箱里，宿主看不到它的任何输出；「点了没反应」这类问题
 * 只能靠回传证据来定位。写到 `~/.dsh/better-folders/diag.json`，保留最近 20 条。
 *
 * @param {object} entry 客户端上报的诊断对象。
 * @returns {void}
 */
function writeDiag(entry) {
  try {
    const file = path.join(path.dirname(stateFile()), 'diag.json')
    let history = []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(parsed?.history)) history = parsed.history
    } catch { /* 首次写入或文件损坏 */ }
    history.push({ ...entry, receivedAt: new Date().toISOString() })
    if (history.length > 20) history = history.slice(-20)
    fs.writeFileSync(file, JSON.stringify({ history }, null, 2), 'utf8')
  } catch (error) {
    log('诊断写入失败:', error?.message ?? error)
  }
}

/**
 * 还原，并顺手关掉自动整理。
 *
 * 还原会删除文件夹节点，而删除本身又会触发 `domain/changed` —— 如果自动整理还开着，
 * 下一次自动整理会立刻把刚删掉的节点重新建出来，用户永远还原不掉。所以这里显式
 * 把 `autoOrganize` 关掉，把「要不要继续自动整理」的决定权交回用户。
 *
 * @returns {Promise<object>} 还原结果（额外带 `autoOrganizeDisabled`）。
 */
async function doUnmerge() {
  const result = await _organizer.unmerge()
  let disabled = false
  if (loadConfig().autoOrganize) disabled = await saveConfig({ autoOrganize: false })
  return { ...result, autoOrganizeDisabled: disabled }
}

// ── 自动整理 ────────────────────────────────────────────────────────────────

/**
 * 防抖调度一次自动整理。
 * @param {object} ctx Cordis 上下文。
 * @param {number} [delay] 延迟毫秒。
 * @returns {void}
 */
function scheduleAuto(ctx, delay = 2000) {
  if (_autoTimer !== null) clearTimeout(_autoTimer)
  _autoTimer = setTimeout(() => {
    _autoTimer = null
    void runAuto(ctx)
  }, delay)
  // 定时器不应阻止进程退出。
  if (typeof _autoTimer?.unref === 'function') _autoTimer.unref()
}

/**
 * 执行一次自动整理。整理本身是幂等的：没有新的可汇合目录时不会产生任何写入，
 * 因此由 `domain/changed` 触发的自反馈链会自然终止。
 * @param {object} ctx Cordis 上下文。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function runAuto(ctx) {
  if (_autoRunning) return
  const config = loadConfig()
  if (!config.enabled || !config.autoOrganize) return
  _autoRunning = true
  try {
    const result = await _organizer.organize({ apply: true })
    if (result.ok === false && result.error) {
      _lastRun = { at: Date.now(), ok: false, error: String(result.error), created: 0, failed: 0 }
    }
    if (result.createdCount > 0) log(`自动整理：新建 ${result.createdCount} 个文件夹节点`)
  } catch (error) {
    _lastRun = { at: Date.now(), ok: false, error: String(error?.message ?? error), created: 0, failed: 0 }
    log('自动整理失败:', _lastRun.error)
  } finally {
    _autoRunning = false
  }
}

// ── HTTP API（同源，供 Web 面板 / 侧边栏按钮调用）───────────────────────────

/**
 * 读取请求体并解析 JSON。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<object>} 解析后的对象（空体返回 `{}`）。
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 输出 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} code HTTP 状态码。
 * @param {object} payload 响应体。
 * @returns {void}
 */
function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 处理一个 API 请求。
 * @param {object} ctx Cordis 上下文。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {import('node:http').ServerResponse} res 响应。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function handleApi(ctx, req, res) {
  let pathname = API_PREFIX
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    pathname = API_PREFIX
  }
  const route = pathname.slice(API_PREFIX.length) || '/status'
  const method = req.method ?? 'GET'

  try {
    if (route === '/diag' && method === 'POST') {
      const body = await readBody(req)
      writeDiag(body)
      sendJson(res, 200, { ok: true })
      return
    }
    if (route === '/status' && method === 'GET') {
      sendJson(res, 200, { ..._organizer.status(), lastRun: _lastRun })
      return
    }
    if (route === '/settings' && method === 'GET') {
      sendJson(res, 200, { ok: true, config: loadConfig(), hasNativeForm: _scope !== null })
      return
    }
    if (route === '/settings' && method === 'POST') {
      const body = await readBody(req)
      const patch = {}
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (typeof body.autoOrganize === 'boolean') patch.autoOrganize = body.autoOrganize
      if (typeof body.autoTreeView === 'boolean') patch.autoTreeView = body.autoTreeView
      if (typeof body.keepOrder === 'boolean') patch.keepOrder = body.keepOrder
      if (body.minChildren !== undefined) patch.minChildren = normalizeConfig({ minChildren: body.minChildren }).minChildren
      if (body.maxDepth !== undefined) patch.maxDepth = normalizeConfig({ maxDepth: body.maxDepth }).maxDepth
      const written = await saveConfig(patch)
      sendJson(res, 200, { ok: written, config: loadConfig(), hasNativeForm: _scope !== null })
      return
    }
    if (route === '/preview' && method === 'POST') {
      sendJson(res, 200, await _organizer.organize({ apply: false }))
      return
    }
    if (route === '/apply' && method === 'POST') {
      const result = await _organizer.organize({ apply: true })
      sendJson(res, 200, { ...result, lastRun: _lastRun })
      return
    }
    if (route === '/unmerge' && method === 'POST') {
      const result = await doUnmerge()
      sendJson(res, 200, { ...result, lastRun: _lastRun })
      return
    }
    sendJson(res, 404, { ok: false, error: `未知路由: ${route}` })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

// ── Agent 工具 ──────────────────────────────────────────────────────────────

/** 通用工具输出呈现：保持裸 JSON。 */
const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const TOOL_DEFINITION = {
  name: 'organize_workspaces',
  description:
    '整理 DSH 工作区列表：把同一个上级目录下的多个工作区汇合成一个可折叠的文件夹节点。'
    + '做法是把该上级目录注册成一个工作区，DSH 内置的「按工作区树」视图会自动把子工作区嵌进去。'
    + 'action=status 查看当前分组与已建节点；plan 只预览不写入；apply 执行整理；unmerge 还原（只删除本插件创建且没有会话的节点）。'
    + '当用户抱怨侧边栏工作区太多太乱、或要求「把同一目录下的工作区合到一起」时使用。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'plan', 'apply', 'unmerge'],
        description: 'status=查看现状（默认）；plan=预览将要新建的文件夹节点；apply=执行整理；unmerge=还原。',
      },
    },
    required: [],
  },
  output: TOOL_OUTPUT,
  isConcurrencySafe: () => true,
  timeoutMs: 30_000,
  execute: async (args) => {
    const action = typeof args?.action === 'string' ? args.action : 'status'
    if (action === 'unmerge') return await doUnmerge()
    if (action === 'apply') return await _organizer.organize({ apply: true })
    if (action === 'plan') return await _organizer.organize({ apply: false })
    return { ..._organizer.status(), lastRun: _lastRun }
  },
}

// ── 用户指令 ────────────────────────────────────────────────────────────────

const COMMAND_DEFINITION = {
  name: 'folders',
  description: '更好的 DSH 文件夹：整理 / 预览 / 还原工作区分组',
  input: { hint: 'status | plan | organize | unmerge' },
  handler: async (invocation) => {
    const raw = String(invocation?.rawInput ?? '').trim().toLowerCase()
    const config = loadConfig()

    if (raw === 'organize' || raw === 'apply') {
      const result = await _organizer.organize({ apply: true })
      const lines = result.actions
        .filter((action) => action.action !== 'existing')
        .map((action) => `· ${action.action === 'created' ? '新建' : '失败'} ${action.path}${action.error ? ` (${action.error})` : ''}`)
      return {
        kind: 'success',
        text: [
          `已整理：新建 ${result.createdCount} 个文件夹节点，失败 ${result.failedCount} 个。`,
          ...lines,
          config.autoTreeView ? '提示：把侧边栏「视图选项 → 分组方式」切到「按工作区树」即可看到汇合效果（面板里的开关也能一键切换）。' : '',
        ].filter(Boolean).join('\n'),
      }
    }

    if (raw === 'unmerge') {
      const result = await doUnmerge()
      return {
        kind: 'success',
        text: [
          `已还原：删除 ${result.removed.length} 个文件夹节点。`,
          ...result.removed.map((item) => `· 已删除 ${item.path}`),
          ...result.kept.map((item) => `· 保留 ${item.path}（${item.reason}）`),
          result.autoOrganizeDisabled ? '已同时关闭「自动整理」，避免刚还原就被自动重建。需要时可在设置里重新打开。' : '',
        ].filter(Boolean).join('\n'),
      }
    }

    if (raw === 'plan') {
      const result = await _organizer.organize({ apply: false })
      const pending = result.actions.filter((action) => action.action === 'create')
      return {
        kind: 'success',
        text: pending.length === 0
          ? '没有需要新建的文件夹节点，工作区已经整理好了。'
          : `预览：将新建 ${pending.length} 个文件夹节点\n${pending.map((action) => `· ${action.path}（汇合 ${action.childCount} 个工作区）`).join('\n')}`,
      }
    }

    const status = _organizer.status()
    return {
      kind: 'success',
      text: [
        '📁 更好的 DSH 文件夹',
        `工作区 ${status.workspaceCount} 个 · 可汇合目录 ${status.groupCount} 个（已建 ${status.mergedCount} / 待建 ${status.pendingCount}）`,
        `配置：自动整理 ${config.autoOrganize ? '开' : '关'} · 最少同级 ${config.minChildren} 个 · 向上 ${config.maxDepth} 级`,
        ...status.groups.map((group) => `· ${group.state === 'merged' ? '✅' : '⏳'} ${group.path}（${group.childCount} 个子工作区）`),
        '用法：/folders organize 执行整理 · /folders plan 预览 · /folders unmerge 还原',
      ].join('\n'),
    }
  },
}

// ── 系统提示词 ──────────────────────────────────────────────────────────────

const PROMPT_SECTION = {
  name: 'better-folders:discipline',
  order: 855,
  text: `
# 工作区整理（更好的 DSH 文件夹）
DSH 侧边栏的工作区是按目录平铺的。当同一上级目录下堆积了多个工作区、用户抱怨
「侧边栏太乱 / 找不到项目 / 把同一个文件夹里的项目合到一起」时，调用
\`organize_workspaces\` 工具（action=plan 先预览，action=apply 执行整理）。
整理会把共同的上级目录注册成一个工作区，DSH 内置的「按工作区树」视图会自动把
同级工作区嵌进去。整理只新增工作区注册，不会删除目录或会话历史；
\`action=unmerge\` 可以还原（只删除本插件创建且没有会话的节点）。
`.trim(),
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

/**
 * 在指定服务就绪后再执行注册；服务缺失时静默跳过（而不是让整个插件挂掉）。
 * @param {object} ctx Cordis 上下文。
 * @param {string[]} services 依赖的服务名。
 * @param {(scopedCtx: object) => void} run 就绪后的回调。
 * @returns {void}
 */
function withServices(ctx, services, run) {
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(services, run)
      return
    } catch (error) {
      log(`inject ${services.join(',')} 失败:`, error?.message ?? error)
    }
  }
  run(ctx)
}

/**
 * 注册原生设置表单（schemastery 就绪时）。
 * @param {object} ctx Cordis 上下文。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function registerSettings(ctx) {
  const z = await schemaLib()
  if (z === null || typeof ctx?.settings?.register !== 'function') return
  try {
    _scope = ctx.settings.register(SETTINGS_NS, z.object({
      enabled: z.boolean().default(true).description('启用「更好的 DSH 文件夹」'),
      autoOrganize: z.boolean().default(true).description('自动整理：工作区列表变化后自动汇合同级工作区'),
      minChildren: z.number().default(2).description('至少多少个同级工作区才汇合出一个文件夹节点'),
      maxDepth: z.number().default(1).description('向上追溯几级目录寻找共同上级（1 = 只看直接上级）'),
      autoTreeView: z.boolean().default(true).description('整理后把侧边栏切到「按工作区树」视图'),
      keepOrder: z.boolean().default(true).description('把文件夹节点排在它的第一个子工作区之前'),
    }), { title: '更好的 DSH 文件夹', applies: 'live' })
    if (typeof _scope?.watch === 'function') _scope.watch(() => scheduleAuto(ctx, 400))
    log('已注册原生设置（设置界面可配置 better-folders）')
  } catch (error) {
    log('设置注册失败，使用默认配置:', error?.message ?? error)
    _scope = null
  }
}

/**
 * 插件入口。
 * @param {object} ctx Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  _organizer = buildOrganizer(ctx)
  _scope = null
  _lastRun = { at: 0, ok: true, error: '', created: 0, failed: 0 }

  // 1) 原生设置（异步：schemastery 可能不可用）。
  withServices(ctx, ['settings'], (scopedCtx) => {
    void registerSettings(scopedCtx)
  })

  // 2) 监听工作区域变化 -> 自动整理（含启动首扫）。
  ctx.effect(() => {
    const off = typeof ctx.on === 'function'
      ? ctx.on('domain/changed', (change) => {
        if (change?.domain === 'workspace') scheduleAuto(ctx, 2500)
      })
      : undefined
    const boot = setTimeout(() => void runAuto(ctx), 4000)
    if (typeof boot?.unref === 'function') boot.unref()
    return () => {
      if (typeof off === 'function') {
        try {
          off()
        } catch { /* 忽略重复释放 */ }
      }
      clearTimeout(boot)
      if (_autoTimer !== null) {
        clearTimeout(_autoTimer)
        _autoTimer = null
      }
    }
  }, 'better-folders: workspace change watch')

  // 3) HTTP API（Web 面板 / 侧边栏按钮）。
  withServices(ctx, ['webServer'], (scopedCtx) => {
    scopedCtx.effect(() => {
      try {
        return scopedCtx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => handleApi(ctx, req, res),
        })
      } catch (error) {
        log('HTTP 路由注册失败:', error?.message ?? error)
        return undefined
      }
    }, 'better-folders: http routes')
  })

  // 4) Agent 工具。
  withServices(ctx, ['tools'], (scopedCtx) => {
    scopedCtx.effect(
      () => scopedCtx.tools.register(TOOL_DEFINITION),
      'better-folders: organize tool',
    )
  })

  // 5) 用户指令。
  withServices(ctx, ['commands'], (scopedCtx) => {
    scopedCtx.effect(
      () => scopedCtx.commands.register(COMMAND_DEFINITION),
      'better-folders: folders command',
    )
  })

  // 6) 系统提示词。
  withServices(ctx, ['systemPrompt'], (scopedCtx) => {
    scopedCtx.effect(
      () => scopedCtx.systemPrompt.section(PROMPT_SECTION),
      'better-folders: prompt section',
    )
  })

  log('已加载：工作区自动整理就绪')
}

export { DEFAULT_CONFIG, computePlan, createOrganizer, normalizeConfig } from './plan.js'
