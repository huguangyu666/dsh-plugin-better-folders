/**
 * dsh-plugin-better-folders —— 更好的 DSH 文件夹（Client 端）。
 *
 * 两个注入点：
 * 1. `settings.section`：一个「更好的 DSH 文件夹」设置页，展示分组现状、配置开关、
 *    以及 预览 / 一键整理 / 还原 三个动作。数据走同源的 `/better-folders/api/*`。
 * 2. `sidebar.footer.action`：侧边栏底部的一键整理按钮，点一下 = 整理 + 切到树视图。
 *
 * 关于「切到树视图」：DSH 侧边栏自带「按工作区树」视图，它会把每个工作区挂到最近的
 * 已注册祖先工作区下面。整理只是把上级目录注册成工作区，真正的视觉汇合由这个内置
 * 视图完成，所以整理后需要把分组方式切到 workspace-tree。
 *   - 首选：`ctx.uiWorkspace.view.setGroupBy('workspace-tree')`（立即生效）；
 *   - 兜底：改写 localStorage 里的 `dsh.workspace.view.v5`（下次刷新生效）。
 */

const React = require("react");
const { useState, useEffect, useCallback } = React;

/** DSH 设计系统变量（自动适配明暗主题）。 */
const DSW = (v) => `var(--dsw-alias-${v})`;
/** 侧边栏分组方式持久化键（@deepseek-ai/dsh-client-ui-workspace 的 view store）。 */
const VIEW_STORE_KEY = "dsh.workspace.view.v5";
/** 目标分组方式：按工作区树。 */
const TREE_MODE = "workspace-tree";

/** apply() 时捕获的客户端 Context，供组件调用客户端服务。 */
let _ctx = null;
/** 客户端产物版本（用于诊断上报，确认页面加载的是哪一版 bundle）。 */
const BUNDLE_VERSION = "0.1.2";

// ── 诊断上报 ────────────────────────────────────────────────────────────────
//
// 客户端插件运行在浏览器沙箱里，出问题时宿主看不到任何东西。这里把「能力探测结果」
// 回传给宿主，宿主落到 ~/.dsh/better-folders/diag.json —— 排查「点了没反应」时
// 不用让用户开 DevTools。

/**
 * 探测当前客户端 Context 的能力边界。
 * @returns {{hasCtx:boolean,hasUiWorkspace:boolean,hasView:boolean,hasSetGroupBy:boolean}} 探测结果。
 */
function probeCapabilities() {
  const result = { hasCtx: Boolean(_ctx), hasUiWorkspace: false, hasView: false, hasSetGroupBy: false };
  try {
    result.hasUiWorkspace = Boolean(_ctx && _ctx.uiWorkspace);
  } catch {
    result.hasUiWorkspace = false;
  }
  try {
    result.hasView = Boolean(_ctx && _ctx.uiWorkspace && _ctx.uiWorkspace.view);
  } catch {
    result.hasView = false;
  }
  try {
    result.hasSetGroupBy = typeof _ctx?.uiWorkspace?.view?.setGroupBy === "function";
  } catch {
    result.hasSetGroupBy = false;
  }
  return result;
}

/**
 * 把一次诊断快照回传给宿主。
 * @param {object} [extra] 附加上下文（阶段名、切换结果等）。
 * @returns {void}
 */
function reportDiag(extra) {
  const payload = {
    version: BUNDLE_VERSION,
    at: new Date().toISOString(),
    origin: (() => {
      try {
        return String(globalThis.location?.origin || globalThis.location?.protocol || "?");
      } catch {
        return "?";
      }
    })(),
    viewMode: readViewMode(),
    ...probeCapabilities(),
    ...(extra || {}),
  };
  try {
    void fetch("/better-folders/api/diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* 诊断失败绝不影响功能 */
  }
}

// ── 侧边栏视图切换 ──────────────────────────────────────────────────────────

/** 读取当前分组方式（读不到返回 null）。 */
function readViewMode() {
  try {
    const raw = localStorage.getItem(VIEW_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.groupBy === "string" ? parsed.groupBy : null;
  } catch {
    return null;
  }
}

/** 兜底：直接改写持久化的分组方式（下次刷新生效）。 */
function writeViewMode(mode) {
  try {
    const raw = localStorage.getItem(VIEW_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed.groupBy = mode;
    localStorage.setItem(VIEW_STORE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把侧边栏切到「按工作区树」。
 *
 * 优先调用 ui-workspace 客户端服务里的视图写入口 `ctx.uiWorkspace.view.setGroupBy()`
 * （立即生效，并会同步落到 localStorage）；拿不到服务时退化为直接改写持久化值，
 * 下一次页面加载生效。
 *
 * @returns {'live' | 'reload' | 'failed'} live=已即时切换；reload=需刷新；failed=失败。
 */
function switchToTreeView() {
  const probe = probeCapabilities();
  if (probe.hasSetGroupBy) {
    try {
      _ctx.uiWorkspace.view.setGroupBy(TREE_MODE);
      const ok = readViewMode() === TREE_MODE;
      reportDiag({ stage: "switch", path: "service", result: ok ? "live" : "service-no-effect" });
      return ok ? "live" : (writeViewMode(TREE_MODE) ? "reload" : "failed");
    } catch (error) {
      reportDiag({ stage: "switch", path: "service", result: "threw", error: String(error?.message ?? error) });
    }
  }
  const fallback = writeViewMode(TREE_MODE);
  reportDiag({ stage: "switch", path: "localStorage", result: fallback ? "reload" : "failed" });
  return fallback ? "reload" : "failed";
}

/**
 * 启动时校准视图：只有在 `autoTreeView` 打开、且确实存在（或即将存在）文件夹节点时
 * 才切到「按工作区树」。没有可汇合的对象时不动用户的视图 —— 否则就是无意义地改偏好。
 *
 * 这一步是「整理能不能被看出来」的关键：整理只注册文件夹节点，真正的视觉汇合由内置
 * 树视图完成；不切视图的话，侧边栏只会平白多出几个条目，反而更乱。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function ensureTreeViewMode() {
  try {
    if (readViewMode() === TREE_MODE) {
      reportDiag({ stage: "boot", result: "already-tree" });
      return;
    }
    const data = await api("/status");
    if (data?.config?.autoTreeView === false) {
      reportDiag({ stage: "boot", result: "autoTreeView-off" });
      return;
    }
    const folderish = (data?.mergedCount || 0) + (data?.pendingCount || 0);
    if (folderish === 0) {
      reportDiag({ stage: "boot", result: "no-folder-node" });
      return;
    }
    const outcome = switchToTreeView();
    reportDiag({ stage: "boot", result: outcome, folderish });
  } catch (error) {
    reportDiag({ stage: "boot", result: "status-failed", error: String(error?.message ?? error) });
  }
}

/** 重试定时器句柄（模块级，便于卸载时清理）。 */
let _treeTimer = null;

/**
 * 等客户端服务就绪后做一次视图校准。
 * `ctx.uiWorkspace` 由 ui-workspace 客户端插件注册，可能晚于本插件，因此按固定间隔
 * 重试有限次；拿不到就安静放弃，不阻塞、不报错。
 * @param {object} ctx 客户端 Context。
 * @param {number} [tries] 剩余重试次数。
 * @returns {void}
 */
function scheduleTreeViewCheck(ctx, tries = 12) {
  if (_treeTimer !== null) {
    clearTimeout(_treeTimer);
    _treeTimer = null;
  }
  let ready = false;
  try {
    const actions = ctx?.uiWorkspace?.view;
    ready = Boolean(actions && typeof actions.setGroupBy === "function");
  } catch {
    ready = false;
  }
  if (ready) {
    void ensureTreeViewMode();
    return;
  }
  if (tries <= 0) {
    // 一直拿不到视图写入口 —— 这是「整理看不出效果」的头号原因，必须留下证据。
    reportDiag({ stage: "boot", result: "view-service-unreachable" });
    return;
  }
  _treeTimer = setTimeout(() => {
    _treeTimer = null;
    scheduleTreeViewCheck(ctx, tries - 1);
  }, 700);
}

// ── Host API ────────────────────────────────────────────────────────────────

async function api(path, options) {
  const response = await fetch(`/better-folders/api${path}`, {
    method: options?.method || "GET",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

// ── 样式 ────────────────────────────────────────────────────────────────────

const styles = {
  root: { fontSize: "13px", color: DSW("label-primary"), fontFamily: DSW("font-family") },
  lead: { color: DSW("label-secondary"), fontSize: "12.5px", lineHeight: 1.6, marginBottom: "14px" },
  statRow: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "14px" },
  stat: {
    background: DSW("bg-module-platform"), border: `1px solid ${DSW("border-l2")}`,
    borderRadius: "10px", padding: "10px 14px", minWidth: "104px",
  },
  statNum: { fontSize: "20px", fontWeight: 600, color: DSW("label-primary") },
  statLabel: { fontSize: "11.5px", color: DSW("label-tertiary"), marginTop: "2px" },
  box: {
    background: DSW("bg-module-platform"), border: `1px solid ${DSW("border-l2")}`,
    borderRadius: "10px", padding: "12px 14px", marginBottom: "12px",
  },
  boxTitle: { color: DSW("label-secondary"), fontSize: "12.5px", fontWeight: 600, marginBottom: "8px" },
  switchRow: { display: "flex", alignItems: "center", gap: "8px", margin: "7px 0" },
  switchLabel: { color: DSW("label-primary"), cursor: "pointer", fontSize: "12.5px" },
  hint: { color: DSW("label-tertiary"), fontSize: "11.5px", lineHeight: 1.5, marginTop: "4px" },
  numRow: { display: "flex", alignItems: "center", gap: "10px", margin: "9px 0" },
  numLabel: { color: DSW("label-secondary"), width: "190px", flex: "none", fontSize: "12.5px" },
  input: {
    width: "76px", background: DSW("bg-module-platform"), border: `1px solid ${DSW("border-l2")}`,
    color: DSW("label-primary"), borderRadius: "8px", padding: "6px 9px", fontSize: "13px", outline: "none",
  },
  btn: {
    border: "none", color: "#fff", borderRadius: "8px", padding: "8px 20px",
    fontSize: "13px", cursor: "pointer", fontWeight: 500, marginRight: "8px",
  },
  btnGhost: {
    background: "transparent", border: `1px solid ${DSW("border-l2")}`,
    color: DSW("label-primary"), borderRadius: "8px", padding: "7px 18px",
    fontSize: "13px", cursor: "pointer", marginRight: "8px",
  },
  msg: { color: DSW("label-secondary"), fontSize: "12px", marginTop: "10px", whiteSpace: "pre-wrap", lineHeight: 1.6 },
  group: {
    display: "flex", alignItems: "center", gap: "8px", padding: "6px 0",
    borderTop: `1px solid ${DSW("border-l2")}`, fontSize: "12.5px",
  },
  groupPath: { flex: 1, color: DSW("label-primary"), wordBreak: "break-all" },
  tag: { fontSize: "11px", padding: "2px 7px", borderRadius: "999px", flex: "none" },
  empty: { color: DSW("label-tertiary"), fontSize: "12.5px", padding: "10px 0" },
};

function Tag({ ok, text }) {
  return React.createElement("span", {
    style: {
      ...styles.tag,
      background: ok ? "rgba(46,160,67,0.14)" : "rgba(210,153,34,0.16)",
      color: ok ? "#2ea043" : "#bf8700",
    },
  }, text);
}

// ── 设置面板 ────────────────────────────────────────────────────────────────

function BetterFoldersPanel() {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [viewMode, setViewMode] = useState(() => readViewMode());

  const reload = useCallback(async () => {
    try {
      const data = await api("/status");
      setStatus(data);
      if (data?.config) setConfig(data.config);
    } catch (error) {
      setMessage(`读取状态失败：${error.message}`);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const patchConfig = async (patch) => {
    setConfig((current) => ({ ...(current || {}), ...patch }));
    try {
      const data = await api("/settings", { method: "POST", body: patch });
      if (data?.config) setConfig(data.config);
    } catch (error) {
      setMessage(`保存设置失败：${error.message}`);
    }
  };

  const run = async (kind) => {
    setBusy(kind);
    setMessage("");
    try {
      const data = await api(`/${kind}`, { method: "POST", body: {} });
      if (kind === "apply") {
        const lines = (data.actions || [])
          .filter((action) => action.action === "created" || action.action === "failed")
          .map((action) => `· ${action.action === "created" ? "新建" : "失败"} ${action.path}${action.error ? `（${action.error}）` : ""}`);
        setMessage([`已整理：新建 ${data.createdCount} 个文件夹节点，失败 ${data.failedCount} 个。`, ...lines].join("\n"));
        if (config?.autoTreeView !== false && data.createdCount > 0) {
          const outcome = switchToTreeView();
          setViewMode(TREE_MODE);
          if (outcome === "reload") setMessage((text) => `${text}\n分组方式已记录为「按工作区树」，刷新页面后生效。`);
          if (outcome === "failed") setMessage((text) => `${text}\n未能自动切换视图，请手动选择「视图选项 → 分组方式 → 按工作区树」。`);
        }
      } else if (kind === "preview") {
        const pending = (data.actions || []).filter((action) => action.action === "create");
        setMessage(pending.length === 0
          ? "没有需要新建的文件夹节点，工作区已经整理好了。"
          : `预览：将新建 ${pending.length} 个文件夹节点\n${pending.map((action) => `· ${action.path}（汇合 ${action.childCount} 个工作区）`).join("\n")}`);
      } else if (kind === "unmerge") {
        setMessage([`已还原：删除 ${data.removed?.length || 0} 个文件夹节点。`,
          ...(data.removed || []).map((item) => `· 已删除 ${item.path}`),
          ...(data.kept || []).map((item) => `· 保留 ${item.path}（${item.reason}）`),
          data.autoOrganizeDisabled ? "已同时关闭「自动整理」，避免刚还原就被自动重建。需要时可在上方重新打开。" : "",
        ].filter(Boolean).join("\n"));
      }
      await reload();
    } catch (error) {
      setMessage(`操作失败：${error.message}`);
    } finally {
      setBusy("");
    }
  };

  const switchView = () => {
    const outcome = switchToTreeView();
    setViewMode(TREE_MODE);
    if (outcome === "live") setMessage("已切换到「按工作区树」视图。");
    else if (outcome === "reload") setMessage("已记录为「按工作区树」，刷新页面后生效。");
    else setMessage("切换失败，请手动选择「视图选项 → 分组方式 → 按工作区树」。");
  };

  if (!status || !config) {
    return React.createElement("div", { style: styles.root },
      React.createElement("div", { style: styles.lead }, "加载中…"));
  }

  const cfg = config;
  const groups = status.groups || [];

  return React.createElement("div", { style: styles.root },
    React.createElement("div", { style: styles.lead },
      "DSH 侧边栏的工作区是按目录平铺的。本插件把同一个上级目录下的多个工作区汇合到一个可折叠的文件夹节点里",
      "（做法是把该上级目录注册成一个工作区，DSH 内置的「按工作区树」视图会自动把子工作区嵌进去）。",
      "整理只新增工作区注册，不会删除磁盘目录或会话历史。"),

    React.createElement("div", { style: styles.statRow },
      React.createElement("div", { style: styles.stat },
        React.createElement("div", { style: styles.statNum }, String(status.workspaceCount ?? 0)),
        React.createElement("div", { style: styles.statLabel }, "已注册工作区")),
      React.createElement("div", { style: styles.stat },
        React.createElement("div", { style: styles.statNum }, String(status.groupCount ?? 0)),
        React.createElement("div", { style: styles.statLabel }, "可汇合目录")),
      React.createElement("div", { style: styles.stat },
        React.createElement("div", { style: styles.statNum }, String(status.mergedCount ?? 0)),
        React.createElement("div", { style: styles.statLabel }, "已建文件夹节点")),
      React.createElement("div", { style: styles.stat },
        React.createElement("div", { style: styles.statNum }, String(status.pendingCount ?? 0)),
        React.createElement("div", { style: styles.statLabel }, "待建")),
      React.createElement("div", { style: styles.stat },
        React.createElement("div", { style: styles.statNum }, String(status.trackedFolders?.length ?? 0)),
        React.createElement("div", { style: styles.statLabel }, "本插件创建")),
    ),

    React.createElement("div", { style: styles.box },
      React.createElement("div", { style: styles.boxTitle }, "分组现状"),
      groups.length === 0
        ? React.createElement("div", { style: styles.empty }, "还没有可汇合的目录：至少需要 2 个工作区共享同一个上级目录。")
        : groups.map((group) => React.createElement("div", { key: group.path, style: styles.group },
          React.createElement(Tag, {
            ok: group.state === "merged",
            text: group.state === "merged" ? "已是工作区" : "待新建",
          }),
          React.createElement("span", { style: styles.groupPath }, group.path),
          React.createElement("span", { style: { color: DSW("label-tertiary") } }, `${group.childCount} 个子工作区`),
        )),
      React.createElement("div", { style: styles.hint },
        `当前侧边栏分组方式：${viewMode === TREE_MODE ? "按工作区树（已生效）" : (viewMode || "未读取到")}`),
      viewMode !== TREE_MODE && React.createElement("button", {
        style: { ...styles.btnGhost, marginTop: "8px" }, onClick: switchView,
      }, "切换到「按工作区树」"),
    ),

    (status.trackedFolders || []).length > 0 && React.createElement("div", { style: styles.box },
      React.createElement("div", { style: styles.boxTitle }, "本插件创建的文件夹节点（点「还原」可移除）"),
      (status.trackedFolders || []).map((item) => React.createElement("div", { key: item.id, style: styles.group },
        React.createElement(Tag, { ok: item.alive, text: item.alive ? "在用" : "已不在注册表" }),
        React.createElement("span", { style: styles.groupPath }, item.path || item.id),
      )),
      React.createElement("div", { style: styles.hint },
        "还原只删除这些节点，并且会跳过已经在里面开过会话的；不会动磁盘目录、会话历史或你自己建的工作区。"),
    ),

    React.createElement("div", { style: styles.box },
      React.createElement("div", { style: styles.boxTitle }, "整理规则"),
      React.createElement("div", { style: styles.switchRow },
        React.createElement("input", {
          type: "checkbox", id: "bf-enabled", checked: cfg.enabled !== false,
          onChange: (event) => void patchConfig({ enabled: event.target.checked }),
        }),
        React.createElement("label", { htmlFor: "bf-enabled", style: styles.switchLabel }, "启用「更好的 DSH 文件夹」")),
      React.createElement("div", { style: styles.switchRow },
        React.createElement("input", {
          type: "checkbox", id: "bf-auto", checked: cfg.autoOrganize !== false,
          onChange: (event) => void patchConfig({ autoOrganize: event.target.checked }),
        }),
        React.createElement("label", { htmlFor: "bf-auto", style: styles.switchLabel }, "自动整理：工作区列表变化后自动汇合")),
      React.createElement("div", { style: styles.switchRow },
        React.createElement("input", {
          type: "checkbox", id: "bf-tree", checked: cfg.autoTreeView !== false,
          onChange: (event) => void patchConfig({ autoTreeView: event.target.checked }),
        }),
        React.createElement("label", { htmlFor: "bf-tree", style: styles.switchLabel }, "整理后自动切换到「按工作区树」视图")),
      React.createElement("div", { style: styles.switchRow },
        React.createElement("input", {
          type: "checkbox", id: "bf-order", checked: cfg.keepOrder !== false,
          onChange: (event) => void patchConfig({ keepOrder: event.target.checked }),
        }),
        React.createElement("label", { htmlFor: "bf-order", style: styles.switchLabel }, "把文件夹节点排在它的第一个子工作区之前")),

      React.createElement("div", { style: styles.numRow },
        React.createElement("span", { style: styles.numLabel }, "最少同级工作区数量"),
        React.createElement("input", {
          style: styles.input, type: "number", min: 2, max: 64, value: cfg.minChildren ?? 2,
          onChange: (event) => void patchConfig({ minChildren: Number(event.target.value) }),
        })),
      React.createElement("div", { style: styles.hint }, "低于该数量的目录不会建文件夹节点（默认 2：只有一个子工作区时没有汇合的意义）。"),

      React.createElement("div", { style: styles.numRow },
        React.createElement("span", { style: styles.numLabel }, "向上追溯级数"),
        React.createElement("input", {
          style: styles.input, type: "number", min: 1, max: 8, value: cfg.maxDepth ?? 1,
          onChange: (event) => void patchConfig({ maxDepth: Number(event.target.value) }),
        })),
      React.createElement("div", { style: styles.hint }, "1 = 只看直接上级目录；调大后会为更上层的公共祖先也建文件夹节点。"),
    ),

    React.createElement("div", null,
      React.createElement("button", {
        style: { ...styles.btn, background: DSW("button-info-fill") },
        disabled: busy !== "", onClick: () => void run("apply"),
      }, busy === "apply" ? "整理中…" : "一键整理"),
      React.createElement("button", {
        style: styles.btnGhost, disabled: busy !== "", onClick: () => void run("preview"),
      }, busy === "preview" ? "预览中…" : "预览"),
      React.createElement("button", {
        style: { ...styles.btnGhost, color: DSW("label-secondary") },
        disabled: busy !== "", onClick: () => void run("unmerge"),
      }, busy === "unmerge" ? "还原中…" : "还原"),
    ),
    message ? React.createElement("div", { style: styles.msg }, message) : null,
  );
}

// ── 官方组件库（Module Loader 车道的隐式外部依赖）───────────────────────────
//
// ui-workspace 的文档明确：Module Loader 车道的客户端插件可以 require
// `@deepseek-ai/dsh-client-ui-primitives`，它是隐式基线外部依赖。用它拿官方图标与
// Tooltip，画风才能和侧边栏原生按钮完全一致；拿不到就退化为字符图标，功能不受影响。

let primitives = null;
try {
  primitives = require("@deepseek-ai/dsh-client-ui-primitives") || null;
} catch {
  primitives = null;
}

/** 渲染一个官方图标（拿不到组件库时返回 null）。 */
function OfficialIcon({ name, size = 14 }) {
  const Component = primitives?.[name];
  if (typeof Component !== "function") return null;
  return React.createElement(Component, { size });
}

/**
 * 官方图标优先，缺失时退化为字符图标 —— 组件库不可用也不该让按钮消失。
 * @param {string} name 图标导出名。
 * @param {string} fallback 字符兜底。
 * @param {number} [size] 尺寸。
 * @returns {object} React 元素。
 */
function iconOr(name, fallback, size = 14) {
  const Component = primitives?.[name];
  if (typeof Component === "function") return React.createElement(Component, { size });
  return React.createElement("span", { style: { fontSize: `${size}px`, lineHeight: 1 } }, fallback);
}

/** 图标按钮样式：逐字对齐 ui-workspace 的 searchButton（28×28 / radius-sm / 透明底）。 */
const HEADER_ICON_BUTTON = {
  width: "28px",
  height: "28px",
  borderRadius: "var(--dsw-radius-sm, 6px)",
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  flex: "none",
};

/** 注入一次悬停样式（官方按钮靠 CSS module，这里用等价的最小样式补齐）。 */
const HEADER_CSS = `
.bf-icon-btn:hover{background:var(--dsw-alias-bg-module-platform,#8882);}
.bf-icon-btn[data-active="true"]{background:var(--dsw-alias-bg-module-platform,#8882);color:var(--dsw-alias-label-primary);}
.bf-row:hover{background:var(--dsw-alias-bg-module-platform,#8882);}
`;

// ── 定位「工作区」标题行 ────────────────────────────────────────────────────
//
// 这一行没有对外槽位（搜索 / 视图选项 / 添加工作区都是 ui-workspace 内部写死的），
// 所以走「只读测量 + 浮层贴合」：找到那行的 DOM 取位置，把按钮浮在它左边，
// **不修改官方 DOM**，因此不会和 React 的协调打架。

/**
 * 找到左侧栏里的「工作区」标题行。
 * @returns {{ node: Element, rect: DOMRect } | null} 命中项。
 */
function findWorkspaceHeader() {
  try {
    const nodes = document.querySelectorAll('[class*="sectionHeader"]');
    let best = null;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left > 460) continue; // 必须在左侧栏内
      if (node.querySelectorAll("button").length < 2) continue; // 搜索 + 视图选项 + 添加
      if (best === null || rect.top < best.rect.top) best = { node, rect };
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 订阅标题行的位置（窗口尺寸 / 滚动 / 布局变化都会重测）。
 * @returns {{ rect: DOMRect | null, searchLeft: number | null }} 当前位置。
 */
function useHeaderAnchor() {
  const [anchor, setAnchor] = useState({ rect: null, searchLeft: null });
  useEffect(() => {
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const found = findWorkspaceHeader();
      if (found === null) {
        setAnchor((current) => (current.rect === null ? current : { rect: null, searchLeft: null }));
        return;
      }
      const firstButton = found.node.querySelector("button");
      const searchLeft = firstButton === null ? null : firstButton.getBoundingClientRect().left;
      setAnchor({ rect: found.rect, searchLeft });
    };
    measure();
    const timer = setInterval(measure, 600);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, []);
  return anchor;
}

// ── 「表」数据 ──────────────────────────────────────────────────────────────

async function loadTables() {
  return api("/collections");
}

async function mutateTables(action, payload) {
  return api("/collections", { method: "POST", body: { action, ...payload } });
}

// ── 「表」切换面板 ──────────────────────────────────────────────────────────

const PANEL_STYLE = {
  position: "fixed",
  zIndex: 60,
  width: "340px",
  maxHeight: "60vh",
  overflow: "auto",
  background: "var(--dsw-alias-bg-module-platform, #1c1c1e)",
  border: "1px solid var(--dsw-alias-border-l2, #ffffff22)",
  borderRadius: "var(--dsw-radius-md, 10px)",
  boxShadow: "0 12px 32px rgba(0,0,0,.35)",
  padding: "10px",
  fontSize: "12.5px",
  color: "var(--dsw-alias-label-primary, #fff)",
};

function Chip({ active, children, onClick, title }) {
  return React.createElement("button", {
    type: "button",
    onClick,
    title,
    style: {
      border: "1px solid var(--dsw-alias-border-l2, #ffffff22)",
      background: active ? "var(--dsw-alias-button-info-fill, #1f6feb)" : "transparent",
      color: active ? "#fff" : "var(--dsw-alias-label-secondary, #bbb)",
      borderRadius: "999px",
      padding: "3px 10px",
      fontSize: "12px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      flex: "none",
    },
  }, children);
}

/**
 * 「表」面板：切换 + 管理。
 * @param {{ onClose: Function, anchorLeft: number, anchorTop: number }} props 位置与关闭回调。
 * @returns {object} React 元素。
 */
function TablesPanel({ onClose, anchorLeft, anchorTop }) {
  const [data, setData] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [manage, setManage] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [note, setNote] = useState("");

  const refresh = useCallback(async (keepActive = true) => {
    try {
      const next = await loadTables();
      setData(next);
      setActiveId((current) => {
        if (!keepActive || current === null) return next.collections[0]?.id ?? null;
        return next.collections.some((entry) => entry.id === current) ? current : (next.collections[0]?.id ?? null);
      });
    } catch (error) {
      setNote(`读取失败：${error.message}`);
    }
  }, []);

  useEffect(() => { void refresh(false); }, [refresh]);

  const run = async (action, payload) => {
    setNote("");
    try {
      await mutateTables(action, payload);
      await refresh();
    } catch (error) {
      setNote(`操作失败：${error.message}`);
    }
  };

  const collections = data?.collections ?? [];
  const workspaces = data?.workspaces ?? [];
  const active = collections.find((entry) => entry.id === activeId) ?? null;
  const memberIds = new Set(active?.workspaceIds ?? []);
  const shown = manage ? workspaces : workspaces.filter((workspace) => memberIds.has(workspace.id));

  const openWorkspace = (workspaceId) => {
    try {
      _ctx?.uiWorkspace?.openWorkspace?.(workspaceId);
      onClose();
    } catch (error) {
      setNote(`打开失败：${error.message}`);
    }
  };

  const openSession = (sessionId) => {
    try {
      _ctx?.uiWorkspace?.openSession?.(sessionId);
      onClose();
    } catch (error) {
      setNote(`打开失败：${error.message}`);
    }
  };

  return React.createElement(React.Fragment, null,
    // 点击外部关闭
    React.createElement("div", {
      onClick: onClose,
      style: { position: "fixed", inset: 0, zIndex: 59, background: "transparent" },
    }),
    React.createElement("div", {
      style: { ...PANEL_STYLE, left: `${anchorLeft}px`, top: `${anchorTop}px` },
      onClick: (event) => event.stopPropagation(),
    },
    React.createElement("style", null, HEADER_CSS),

    // 表选择
    React.createElement("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" } },
      collections.map((entry) => React.createElement(Chip, {
        key: entry.id,
        active: entry.id === activeId,
        title: `${entry.workspaceIds.length} 个工作区`,
        onClick: () => setActiveId(entry.id),
      }, entry.name)),
      React.createElement("button", {
        type: "button",
        title: "新建表",
        style: { ...HEADER_ICON_BUTTON, width: "22px", height: "22px" },
        onClick: () => {
          const name = window.prompt("新表的名字", "新表");
          if (name !== null && name.trim().length > 0) void run("create", { name });
        },
      }, iconOr("IconAddOutlineRegular", "+", 13)),
    ),

    // 工具栏
    React.createElement("div", {
      style: { display: "flex", gap: "6px", alignItems: "center", margin: "8px 0 6px", color: "var(--dsw-alias-label-tertiary, #888)" },
    },
      React.createElement("span", null, active === null ? "还没有表" : `${active.name} · ${active.workspaceIds.length} 个工作区`),
      React.createElement("span", { style: { flex: 1 } }),
      active !== null && React.createElement(Chip, {
        active: manage,
        onClick: () => setManage((value) => !value),
        title: manage ? "回到切换视图" : "编辑这个表的成员",
      }, manage ? "完成" : "编辑"),
      active !== null && manage && React.createElement(Chip, {
        active: false,
        title: "重命名这个表",
        onClick: () => {
          const name = window.prompt("新的表名", active.name);
          if (name !== null && name.trim().length > 0) void run("rename", { id: active.id, name });
        },
      }, "改名"),
      active !== null && manage && React.createElement(Chip, {
        active: false,
        title: "删除这个表（不删任何工作区/目录/会话）",
        onClick: () => {
          if (window.confirm(`删除表「${active.name}」？表只是集合，工作区、目录、会话都不会动。`)) {
            void run("delete", { id: active.id });
          }
        },
      }, "删除"),
    ),

    // 工作区 / 会话列表
    React.createElement("div", null,
      shown.length === 0
        ? React.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary, #888)", padding: "10px 2px", lineHeight: 1.6 } },
          active === null
            ? "点上面的「＋」建一个表，再点「编辑」把工作区加进来。"
            : (manage ? "这个表还没有成员，勾选下面的工作区加入。" : "这个表还没有成员。点「编辑」加入工作区。"))
        : shown.map((workspace) => {
          const isMember = memberIds.has(workspace.id);
          const isOpen = expanded[workspace.id] === true;
          return React.createElement("div", { key: workspace.id },
            React.createElement("div", {
              className: "bf-row",
              style: { display: "flex", alignItems: "center", gap: "6px", padding: "6px", borderRadius: "var(--dsw-radius-sm, 6px)" },
            },
              manage && React.createElement("input", {
                type: "checkbox",
                checked: isMember,
                title: isMember ? "移出这个表" : "加入这个表",
                onChange: () => void run("toggleMember", { id: active.id, workspaceId: workspace.id }),
              }),
              React.createElement("span", {
                onClick: () => manage ? null : openWorkspace(workspace.id),
                title: workspace.path,
                style: { flex: 1, cursor: manage ? "default" : "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              }, workspace.title || workspace.path),
              React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary, #888)", flex: "none" } },
                `${workspace.sessionCount} 会话`),
              !manage && workspace.sessions.length > 0 && React.createElement("button", {
                type: "button",
                title: isOpen ? "收起会话" : "展开会话",
                style: { ...HEADER_ICON_BUTTON, width: "20px", height: "20px" },
                onClick: () => setExpanded((current) => ({ ...current, [workspace.id]: !isOpen })),
              }, iconOr(isOpen ? "IconChevronDownOutlineRegular" : "IconChevronRightOutlineRegular", isOpen ? "▾" : "▸", 12)),
            ),
            isOpen && React.createElement("div", { style: { margin: "0 0 4px 24px" } },
              workspace.sessions.map((session) => React.createElement("div", {
                key: session.id,
                className: "bf-row",
                title: session.id,
                onClick: () => openSession(session.id),
                style: {
                  padding: "4px 6px",
                  borderRadius: "var(--dsw-radius-sm, 6px)",
                  cursor: "pointer",
                  color: session.title ? "inherit" : "var(--dsw-alias-label-tertiary, #888)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                },
              }, session.title || (session.live ? "未命名会话" : "未加载的会话（点开即加载）"))),
            ),
          );
        }),
    ),

    note ? React.createElement("div", { style: { marginTop: "8px", color: "var(--dsw-alias-label-secondary, #bbb)" } }, note) : null,
    React.createElement("div", { style: { marginTop: "8px", color: "var(--dsw-alias-label-tertiary, #888)", lineHeight: 1.6 } },
      "表只是工作区的集合视图，不创建目录、不改工作目录、不碰会话历史。"),
    ),
  );
}

// ── 标题行图标按钮 ──────────────────────────────────────────────────────────

/** 标题行按钮是否已挂载（挂上后隐藏底部按钮，避免重复入口）。 */
let _headerMounted = false;
const _headerSubscribers = new Set();

/**
 * 广播标题行按钮的挂载状态。
 * @param {boolean} value 是否已挂载。
 * @returns {void}
 */
function setHeaderMounted(value) {
  if (_headerMounted === value) return;
  _headerMounted = value;
  for (const listener of _headerSubscribers) {
    try {
      listener(value);
    } catch { /* 单个订阅者出错不影响其它 */ }
  }
}

function WorkspaceHeaderActions() {
  const anchor = useHeaderAnchor();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const mounted = anchor.rect !== null;
  useEffect(() => {
    setHeaderMounted(mounted);
    return () => setHeaderMounted(false);
  }, [mounted]);

  if (!mounted) return null; // 定位不到标题行 -> 不渲染，交给底部按钮兜底

  const rowTop = anchor.rect.top + (anchor.rect.height - 28) / 2;
  const gap = 4;
  const clusterWidth = 28 * 2 + gap;
  const left = anchor.searchLeft === null
    ? anchor.rect.right - clusterWidth - 4
    : Math.max(anchor.rect.left + 4, anchor.searchLeft - clusterWidth - gap);

  const organize = async () => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const data = await api("/apply", { method: "POST", body: {} });
      if (data?.config?.autoTreeView !== false) switchToTreeView();
      const created = data?.createdCount || 0;
      setNote(created > 0 ? `已新建 ${created} 个文件夹节点` : "已是最新，无需整理");
    } catch (error) {
      setNote(`失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  return React.createElement(React.Fragment, null,
    React.createElement("style", null, HEADER_CSS),
    React.createElement("div", {
      style: {
        position: "fixed",
        left: `${left}px`,
        top: `${rowTop}px`,
        display: "flex",
        alignItems: "center",
        gap: `${gap}px`,
        zIndex: 58,
        color: "var(--dsw-alias-label-tertiary, #888)",
      },
    },
    React.createElement("button", {
      type: "button",
      className: "bf-icon-btn",
      style: HEADER_ICON_BUTTON,
      title: note || "整理工作区：把同一上级目录下的工作区汇合成文件夹节点",
      disabled: busy,
      onClick: organize,
    }, iconOr("IconFolderOpenOutlineRegular", "📁", 14)),

    React.createElement("button", {
      type: "button",
      className: "bf-icon-btn",
      "data-active": open ? "true" : "false",
      style: HEADER_ICON_BUTTON,
      title: "表：把任意几个工作区圈在一起，方便来回切换",
      onClick: () => setOpen((value) => !value),
    }, iconOr("IconFlatListOutlineRegular", "📋", 14)),
    ),

    open && React.createElement(TablesPanel, {
      onClose: () => setOpen(false),
      anchorLeft: left,
      anchorTop: rowTop + 34,
    }),
  );
}

// ── 侧边栏快捷按钮 ──────────────────────────────────────────────────────────

function SidebarQuickButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [headerMounted, setHeaderMountedState] = useState(_headerMounted);

  // 标题行按钮挂上后，这个底部按钮就让位（同一功能不重复摆两个入口）。
  useEffect(() => {
    const listener = (value) => setHeaderMountedState(value);
    _headerSubscribers.add(listener);
    return () => _headerSubscribers.delete(listener);
  }, []);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const data = await api("/apply", { method: "POST", body: {} });
      const created = data?.createdCount || 0;
      let outcome = "skipped";
      if (data?.config?.autoTreeView !== false) outcome = switchToTreeView();
      reportDiag({ stage: "click", result: outcome, created, viewModeAfter: readViewMode() });
      // 必须给出可见反馈：整理本身常常「无事可做」（节点已存在），
      // 若一声不吭，用户只会觉得按钮坏了。
      if (outcome === "live") setNote(created > 0 ? `已新建 ${created} 个节点，已切到树视图` : "已是最新，已切到树视图");
      else if (outcome === "reload") setNote("已记录视图偏好，请刷新页面（F5）生效");
      else if (created > 0) setNote(`已新建 ${created} 个文件夹节点`);
      else setNote("已是最新，无需整理");
    } catch (error) {
      reportDiag({ stage: "click", result: "api-failed", error: String(error?.message ?? error) });
      setNote(`失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const label = busy ? "整理中…" : (note || "整理文件夹");

  if (headerMounted) return null;

  return React.createElement("button", {
    onClick,
    disabled: busy,
    title: note
      ? `更好的 DSH 文件夹：${note}`
      : "更好的 DSH 文件夹：把同一上级目录下的工作区汇合到一起",
    style: {
      display: "flex", alignItems: "center", gap: "6px",
      background: "transparent", border: `1px solid ${DSW("border-l2")}`,
      color: note && note.startsWith("失败") ? "#d1242f" : DSW("label-secondary"),
      borderRadius: "6px", cursor: "pointer",
      padding: "6px 10px", fontSize: "12.5px", maxWidth: "220px",
    },
  },
  React.createElement("span", { style: { fontSize: "14px" } }, "📁"),
  React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label));
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

const name = "dsh-plugin-better-folders";
// uiWorkspace 必须声明：客户端插件的 Context 只暴露 inject 里列出的服务，
// 不声明就拿不到视图写入口，视图校准会静默失效（v0.1.1 的实测翻车点）。
const inject = ["slots", "uiWorkspace"];

function apply(ctx) {
  _ctx = ctx;

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      { name: "settings.section", id: "better-folders", order: 103, label: "更好的 DSH 文件夹" },
      BetterFoldersPanel,
    ));

  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      { name: "sidebar.footer.action", id: "better-folders", order: 60 },
      SidebarQuickButton,
    ));

  // 主入口：把图标按钮贴合到「工作区」标题行（那一行没有对外槽位，只能浮层贴合）。
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      { name: "shell.overlay", id: "better-folders.header", order: 40 },
      WorkspaceHeaderActions,
    ));

  // 启动后校准一次视图：整理建出的文件夹节点要靠内置「按工作区树」才看得出来。
  // 这里刻意不用 ctx.effect —— 客户端插件上下文不保证提供它，抛错会连带
  // 掐掉后面的初始化（同 profile 的其他客户端插件也都没用）。
  reportDiag({ stage: "apply" });
  const kick = setTimeout(() => scheduleTreeViewCheck(ctx), 900);
  if (typeof kick?.unref === "function") kick.unref();
}

module.exports = { name, inject, apply };
