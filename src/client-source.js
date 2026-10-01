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

// ── 侧边栏快捷按钮 ──────────────────────────────────────────────────────────

function SidebarQuickButton() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

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

  // 启动后校准一次视图：整理建出的文件夹节点要靠内置「按工作区树」才看得出来。
  // 这里刻意不用 ctx.effect —— 客户端插件上下文不保证提供它，抛错会连带
  // 掐掉后面的初始化（同 profile 的其他客户端插件也都没用）。
  reportDiag({ stage: "apply" });
  const kick = setTimeout(() => scheduleTreeViewCheck(ctx), 900);
  if (typeof kick?.unref === "function") kick.unref();
}

module.exports = { name, inject, apply };
