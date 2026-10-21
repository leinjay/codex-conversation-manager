import * as vscode from "vscode";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AccountManager } from "./accounts";
import { CodexAccountBackend } from "./accountBackend";
import { startSessionListAutoRefresh } from "./autoRefresh";
import { configuredCliPath, findChatGptBundledCli, findCliOnPath, resolveCliTarget, isRunnableFile } from "./cli";
import { CodexDataService, shortError } from "./dataService";
import { codexIdeThreadUri } from "./links";
import { ACCOUNT_USAGE_REFRESH_MINUTES, buildQuotaStatusBarContent } from "./quotaStatusBar";
import { SessionManager } from "./sessionManager";
import { StartupConversation } from "./startupConversation";
import { ManagerWebviewProvider } from "./view";
import type { CliStatus, ManagerSnapshot, SessionRecord } from "./types";

const MODERN_VIEW_ID = "sponge.sessions";
const LEGACY_VIEW_ID = "sponge.sessions.legacy";

interface Verification {
  path: string;
  verified?: boolean;
  version?: string;
  message: string;
  codexHome?: string;
}

let manager: SessionManager | undefined;
let dataService: CodexDataService | undefined;
let webviews: ManagerWebviewProvider | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let quotaStatusBar: vscode.StatusBarItem | undefined;
let chosenViewId: string | undefined;
let targetContainerId: string | undefined;
let verification: Verification | undefined;
let activeTabRequest = "sessions";
let fallbackWarningShown = false;
let lastUsageSnapshot: ManagerSnapshot["usage"];
let usageRefreshedAt: number | undefined;
let accounts: AccountManager | undefined;
let startupConversation: StartupConversation | undefined;

function managerSnapshot(): ManagerSnapshot {
  return { ...(manager?.snapshot() ?? emptySnapshot()), accounts: accounts?.snapshot() };
}

function ensureLocalAccountSwitch(): void {
  if (vscode.env.remoteName || vscode.workspace.getConfiguration("chatgpt").get<boolean>("runCodexInWindowsSubsystemForLinux", false)) {
    throw new Error("账户切换目前支持本机 Windows / Linux。当前 Codex 可能使用 WSL 或远程登录环境，请先在对应环境中管理账户。");
  }
}

function refreshSavedAccountQuotas(): Promise<void> {
  try { ensureLocalAccountSwitch(); }
  catch { return Promise.resolve(); }
  return accounts?.refreshQuotas() ?? Promise.resolve();
}

async function refreshAllUsage(): Promise<void> {
  await manager?.refreshUsage();
  await refreshSavedAccountQuotas();
}

async function pickAccount(): Promise<void> {
  if (!accounts) throw new Error("账户管理尚未初始化，请稍候。");
  await accounts.refreshIndex();
  const state = accounts.snapshot();
  type Choice = vscode.QuickPickItem & { action: string; id?: string };
  const choices: Choice[] = state.busy
    ? [{ label: state.canCancel ? "$(close) 取消添加账户" : "$(sync~spin) 正在处理账户…", action: state.canCancel ? "cancel" : "busy" }]
    : [
      ...state.items.map(item => ({
        label: item.email,
        description: [item.email.toLowerCase() === state.currentEmail?.toLowerCase() ? "当前邮箱" : "", item.planType ?? "", item.state === "reauth" ? "需重新授权" : item.state === "cacheMissing" ? "加密副本未读取" : "已保存"].filter(Boolean).join(" · "),
        detail: "切换会重载当前 VS Code 窗口；请先结束 Codex 正在执行的任务。",
        action: "switch", id: item.id
      })),
      { label: "$(save) 保存当前账户", action: "save" },
      { label: "$(add) 添加其他账户…", description: "仅首次或登录失效时需要网页授权", action: "add" },
      ...(state.phase === "reloadRequired" ? [{ label: "$(debug-restart) 重载窗口并核验 CLI 账户", action: "reload" }] : []),
      ...(state.phase === "confirmationRequired" || state.phase === "confirmed" ? [{ label: "$(verified) 核对 Codex 实际账户…", description: "核对 Codex 个人菜单中显示的邮箱", action: "confirm" }] : []),
      ...(state.items.length ? [{ label: "$(trash) 移除已保存账户…", description: "不会退出当前登录或删除会话", action: "remove" }] : [])
    ];
  const selected = await vscode.window.showQuickPick(choices, { title: "Codex 账户", placeHolder: state.message || "选择账户切换（会重载当前窗口），或添加、保存账户", matchOnDescription: true });
  if (!selected || selected.action === "busy") return;
  if (selected.action === "cancel") { accounts.cancelLogin(); return; }
  if (selected.action === "reload") { await vscode.commands.executeCommand("workbench.action.reloadWindow"); return; }
  if (selected.action === "confirm") {
    await vscode.commands.executeCommand("chatgpt.openSidebar");
    const email = await vscode.window.showInputBox({ title: "核对 Codex 实际账户", prompt: "打开 Codex 的个人菜单，输入其中实际显示的邮箱。不会读取你的密码。", placeHolder: "Codex 中显示的账户邮箱", ignoreFocusOut: true });
    if (email !== undefined) await accounts.confirmIde(email);
  } else if (selected.action === "remove") {
    const item = await vscode.window.showQuickPick(state.items.map(account => ({ label: account.email, id: account.id })), { title: "移除已保存账户", placeHolder: "只移除加密保存副本，保留当前登录与会话" });
    if (item && await vscode.window.showWarningMessage(`移除“${item.label}”的保存副本？之后再次使用它需要重新授权。`, { modal: true }, "移除") === "移除") await accounts.remove(item.id);
  } else {
    ensureLocalAccountSwitch();
    if (selected.action === "save") await accounts.saveCurrent();
    else if (selected.action === "add") {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "添加 Codex 账户：请在浏览器中授权", cancellable: true }, async (_progress, token) => {
        const abortController = new AbortController();
        const cancel = token.onCancellationRequested(() => abortController.abort());
        if (token.isCancellationRequested) abortController.abort();
        try { await accounts!.add(abortController.signal); } finally { cancel.dispose(); }
      });
    } else if (selected.action === "switch" && selected.id) {
      if (await accounts.switchTo(selected.id)) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        return;
      }
    }
  }
  await refreshAllUsage();
  void webviews?.sendAllStates();
}

function detectContainers(): { viewId?: string; containerId?: string; mode: "secondary" | "legacy" | "missing" } {
  const extension = vscode.extensions.getExtension("openai.chatgpt");
  const packageJSON = extension?.packageJSON as {
    contributes?: { viewsContainers?: Record<string, Array<{ id?: string; title?: string }>> };
  } | undefined;
  const containers = packageJSON?.contributes?.viewsContainers;
  const secondary = containers?.secondarySidebar?.find(item => item.id === "codexSecondaryViewContainer");
  if (secondary) return { viewId: MODERN_VIEW_ID, containerId: secondary.id, mode: "secondary" };
  const activity = containers?.activitybar?.find(item => item.id === "codexViewContainer");
  if (activity) return { viewId: LEGACY_VIEW_ID, containerId: activity.id, mode: "legacy" };

  // If Codex changes its id in a future version, retain a visible command fallback.
  for (const entries of Object.values(containers ?? {})) {
    const codex = entries.find(item => item.id && /codex/i.test(item.title ?? ""));
    if (codex) return { containerId: codex.id, mode: "missing" };
  }
  return { mode: "missing" };
}

function makeCliStatus(): CliStatus {
  const target = resolveCliTarget();
  const configuredPath = configuredCliPath();
  const path = target?.path;
  const remoteName = vscode.env.remoteName;
  const inWsl = Boolean(process.env.WSL_DISTRO_NAME) || remoteName === "wsl";
  const hostEnvironment = `${process.platform === "win32" ? "Windows" : process.platform} · ${process.arch}${remoteName ? ` · VS Code ${remoteName} 工作区` : " · 本机扩展宿主"}`;
  const remoteWarning = remoteName || inWsl
    ? "当前工作区连接到 WSL 或远程环境。管理器使用本机 UI 扩展宿主找到的 Codex CLI 和 Codex Home；远程工作目录与本机会话目录可能不同。"
    : undefined;
  const currentVerification = path && verification?.path.toLowerCase() === path.toLowerCase() ? verification : undefined;
  return {
    platform: process.platform,
    path,
    source: target?.source ?? "missing",
    configuredPath,
    verified: currentVerification?.verified,
    version: currentVerification?.version,
    verificationMessage: currentVerification?.message,
    codexHome: currentVerification?.codexHome ?? dataService?.codexHome(),
    hostEnvironment,
    remoteWarning
  };
}

function currentWorkspaceProjectPath(): string | undefined {
  if (vscode.env.remoteName || process.env.WSL_DISTRO_NAME
    || vscode.workspace.getConfiguration("chatgpt").get<boolean>("runCodexInWindowsSubsystemForLinux", false)) return undefined;
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  return (activeFolder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
}

function emptySnapshot(): ManagerSnapshot {
  return {
    records: [], projects: [], sourceFilter: "all", projectFilter: "", search: "",
    sortKey: "updated", sortDirection: "desc", pageIndex: 0, pageSize: 20,
    totalLoaded: 0, filteredCount: 0, hasMore: false, errors: {}, cli: makeCliStatus(), loading: true
  };
}

function updateQuotaStatusBar(snapshot: ManagerSnapshot): void {
  if (snapshot.usage !== lastUsageSnapshot) {
    lastUsageSnapshot = snapshot.usage;
    usageRefreshedAt = snapshot.usage ? Date.now() : undefined;
  }
  const content = buildQuotaStatusBarContent(snapshot.usage, usageRefreshedAt);
  if (quotaStatusBar) {
    quotaStatusBar.text = content.text;
    quotaStatusBar.tooltip = content.tooltip;
  }
  webviews?.setQuotaTitle(content.title);
  webviews?.setUsageRefreshedAt(usageRefreshedAt);
}

function sendMessage(text: string, error = false): void {
  void webviews?.postMessage({ type: "message", text, error });
}

function emitState(): void {
  if (manager) manager.emit();
  else void webviews?.sendAllStates();
}

async function openManager(tab = "sessions"): Promise<void> {
  activeTabRequest = tab;
  if (chosenViewId && targetContainerId) {
    try {
      await vscode.commands.executeCommand(`workbench.actions.view.show.${chosenViewId}`);
      await webviews?.postMessage({ type: "selectTab", tab });
      return;
    } catch {
      try {
        await vscode.commands.executeCommand(`workbench.view.extension.${targetContainerId}`);
        await vscode.commands.executeCommand(`workbench.actions.view.show.${chosenViewId}`);
        await webviews?.postMessage({ type: "selectTab", tab });
        return;
      } catch {
        // The custom view command can disappear when Codex changes its view registration.
      }
    }
  }
  await webviews?.openPanel();
  await webviews?.postMessage({ type: "selectTab", tab });
  if (!fallbackWarningShown) {
    fallbackWarningShown = true;
    void vscode.window.showWarningMessage("Codex 视图容器当前不可用，已在编辑器中打开管理器备用面板。后续可从命令面板运行“Sponge: 打开 Codex 对话管理器”。");
  }
}

async function verifyCli(showResult: boolean): Promise<boolean> {
  const target = resolveCliTarget();
  if (!target) {
    verification = undefined;
    emitState();
    await manager?.refresh();
    if (showResult) {
      const action = await vscode.window.showWarningMessage("未检测到 Codex CLI。请选择 Codex CLI 启动程序。", "配置路径");
      if (action) await vscode.commands.executeCommand("sponge.codex.configureCliPath");
    }
    return false;
  }
  if (!isRunnableFile(target.path)) {
    verification = { path: target.path, verified: false, message: `指定路径不存在或不是文件：${target.path}。请重新选择 Codex CLI 启动程序。` };
    emitState();
    await manager?.refresh();
    if (showResult) await vscode.window.showErrorMessage(verification.message);
    return false;
  }

  verification = { path: target.path, verified: false, message: "正在读取 CLI 版本并验证 App Server 支持…" };
  emitState();
  try {
    const result = await dataService!.verify(target);
    verification = {
      path: target.path,
      verified: true,
      version: result.version,
      message: "CLI 版本已读取，Codex App Server JSON-RPC 初始化成功。",
      codexHome: typeof result.metadata.codexHome === "string" ? result.metadata.codexHome : undefined
    };
    emitState();
    await manager?.refresh();
    if (showResult) await vscode.window.showInformationMessage(`Codex CLI 验证成功：${result.version}`);
    return true;
  } catch (error) {
    const message = `验证失败：${shortError(error)}\n请确认此文件是可运行的 Codex CLI（不是 ChatGPT 桌面应用），更新至支持 app-server 的版本，或重新选择 CLI 路径。`;
    verification = { path: target.path, verified: false, message };
    emitState();
    await manager?.refresh();
    if (showResult) await vscode.window.showErrorMessage(message);
    return false;
  }
}

async function configureCliPath(): Promise<void> {
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "选择 Codex CLI",
    title: "选择 Codex CLI 启动程序（不是 ChatGPT 桌面应用）",
    filters: process.platform === "win32"
      ? { "Codex CLI": ["exe", "cmd", "bat"], "所有文件": ["*"] }
      : { "Codex CLI": ["", "sh"], "所有文件": ["*"] }
  });
  if (!selection?.[0]) return;
  const path = selection[0].fsPath;
  await vscode.workspace.getConfiguration("sponge").update("codexCliPath", path, vscode.ConfigurationTarget.Global);
  dataService?.dispose();
  verification = undefined;
  emitState();
  await verifyCli(true);
}

async function clearCliPath(): Promise<void> {
  await vscode.workspace.getConfiguration("sponge").update("codexCliPath", "", vscode.ConfigurationTarget.Global);
  dataService?.dispose();
  verification = undefined;
  emitState();
  const target = resolveCliTarget();
  const source = target?.source === "chatgpt" ? "ChatGPT/Codex 扩展随附的 App Server CLI" : target?.source === "PATH" ? "PATH 中的 Codex CLI" : "已配置的 Codex CLI";
  await vscode.window.showInformationMessage(target
    ? `已清除路径覆盖，将使用${source}：${target.path}`
    : "已清除路径覆盖；未找到可用的 Codex App Server CLI。");
  await manager?.refresh();
}

async function detectCli(): Promise<void> {
  const configured = configuredCliPath();
  const bundled = findChatGptBundledCli();
  const detected = findCliOnPath();
  const target = resolveCliTarget();
  emitState();
  if (configured) {
    await vscode.window.showInformationMessage(`正在使用已配置的 Codex CLI：${configured}${detected ? `（PATH 中另检测到 ${detected}）` : ""}`);
  } else if (target?.source === "chatgpt") {
    await vscode.window.showInformationMessage(`已从已安装的 ChatGPT/Codex VS Code 扩展检测到 App Server CLI：${bundled}`);
  } else if (detected) {
    await vscode.window.showInformationMessage(`已从 PATH 检测到 Codex CLI：${detected}`);
  } else {
    const action = await vscode.window.showWarningMessage("未找到可用的 Codex App Server CLI。请安装 ChatGPT/Codex VS Code 扩展、将 Codex CLI（通常名为 codex）加入 PATH，或手动选择 CLI 启动程序。", "配置路径");
    if (action) await configureCliPath();
  }
}

async function handleWebviewMessage(message: Record<string, unknown>, webview: vscode.Webview): Promise<void> {
  if (!manager) return;
  const type = typeof message.type === "string" ? message.type : "";
  if (type !== "ready") startupConversation?.cancel();
  const reportFailure = (error: unknown) => {
    const text = shortError(error);
    void webview.postMessage({ type: "message", text, error: true });
    void vscode.window.showErrorMessage(text);
    if (type === "accounts" || type === "switchAccount") void manager?.refreshUsage();
  };
  try {
    if (type === "ready") {
      await webviews?.sendAllStates();
      await webview.postMessage({ type: "selectTab", tab: activeTabRequest });
    } else if (type === "accounts") {
      await pickAccount();
    } else if (type === "switchAccount") {
      ensureLocalAccountSwitch();
      const item = accounts?.snapshot().items.find(item => item.id === message.id);
      if (!item) throw new Error("账户已移除或不存在，请刷新后重试。");
      const choice = await vscode.window.showWarningMessage(`切换到“${item.email}”并重载当前窗口？请先结束 Codex 正在执行的任务。`, { modal: true }, "切换并重载");
      if (choice === "切换并重载" && await accounts!.switchTo(item.id)) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } else if (accounts?.snapshot().busy) {
      throw new Error("正在处理账户操作，请完成或取消后再操作会话。");
    } else if (type === "refresh") {
      await manager.refresh();
      await refreshSavedAccountQuotas();
    } else if (type === "refreshUsage") {
      await refreshAllUsage();
    } else if (type === "search") {
      void manager.setSearch(typeof message.value === "string" ? message.value : "");
    } else if (type === "source") {
      const value = message.value;
      if (value === "all" || value === "local" || value === "cloud") void manager.setSource(value);
    } else if (type === "project") {
      void manager.setProject(typeof message.value === "string" ? message.value : "");
    } else if (type === "sort") {
      const key = message.key;
      const direction = message.direction;
      if ((key === "created" || key === "updated" || key === "active") && (direction === "asc" || direction === "desc")) {
        void manager.setSort(key, direction);
      }
    } else if (type === "nextPage") {
      void manager.nextPage();
    } else if (type === "previousPage") {
      void manager.previousPage();
    } else if (type === "loadQuestions") {
      const key = typeof message.key === "string" ? message.key : "";
      const record = manager.findRecord(key);
      if (!record) throw new Error("此会话已不在当前列表中，请刷新后重试。");
      const questions = await manager.listQuestions(record);
      await webview.postMessage({ type: "questions", key, questions });
    } else if (type === "details" || type === "open" || type === "openInIde" || type === "rename" || type === "delete") {
      const key = typeof message.key === "string" ? message.key : "";
      const record = manager.findRecord(key);
      if (!record) throw new Error("此会话已不在当前列表中，请刷新后重试。");
      if (type === "details") {
        const payload = await manager.openDetails(record);
        await webview.postMessage({ type: "details", payload });
      } else if (type === "open") {
        await openRecord(record);
      } else if (type === "openInIde") {
        await openRecordInIde(record);
      } else if (type === "rename") {
        await manager.rename(record, typeof message.value === "string" ? message.value : "");
      } else {
        const choice = await vscode.window.showWarningMessage(
          `将通过 Codex App Server 永久删除“${record.title}”这条本地 Codex 对话记录。此操作不可撤销，并可能同时删除其派生子对话；它不代表删除服务端或其他位置的数据副本。`,
          { modal: true },
          "永久删除本地记录"
        );
        if (choice === "永久删除本地记录") await manager.delete(record);
      }
    } else if (type === "command") {
      const command = message.command;
      if (command === "detectCli") await detectCli();
      else if (command === "configureCli") await configureCliPath();
      else if (command === "verifyCli") await verifyCli(true);
      else if (command === "clearCli") await clearCliPath();
    }
  } catch (error) {
    if (type === "loadQuestions") {
      const key = typeof message.key === "string" ? message.key : "";
      void webview.postMessage({ type: "questionsError", key, text: shortError(error) });
    } else {
      reportFailure(error);
    }
  }
}

async function openRecord(record: SessionRecord): Promise<void> {
  if (record.source === "local") {
    if (!record.id) throw new Error("此本地对话没有有效的 thread ID。");
    if (process.platform === "linux") {
      await openRecordInIde(record);
      return;
    }
    const uri = vscode.Uri.parse(`codex://threads/${encodeURIComponent(record.id)}`);
    const opened = await vscode.env.openExternal(uri);
    if (!opened) throw new Error("系统未能打开 codex:// 深链。请确认已安装并注册 Codex 桌面应用，且该对话对当前用户可见。");
    return;
  }
  if (!record.url) throw new Error("Codex Cloud 列表没有提供此任务的打开链接；未使用云端 ID 构造本地深链。");
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error("Codex Cloud 返回的打开链接无效。");
  }
  if (url.protocol !== "https:") throw new Error("Codex Cloud 返回的链接不是 HTTPS；为避免打开错误目标，此会话未跳转。");
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  if (!opened) throw new Error("系统未能打开 Codex Cloud 会话链接。");
}

async function openRecordInIde(record: SessionRecord): Promise<void> {
  if (record.source !== "local") throw new Error("只有本地 Codex 对话可以在 VS Code Codex 扩展中打开；云端对话请使用其服务返回的链接。");
  if (!record.id) throw new Error("此本地对话没有有效的 thread ID。");
  const codexExtension = vscode.extensions.getExtension("openai.chatgpt");
  if (!codexExtension) throw new Error("未检测到 OpenAI Codex VS Code 扩展，请安装并启用 openai.chatgpt 后重试。");
  // The Codex extension's URI handler forwards /local/:conversationId to its webview router.
  const uri = vscode.Uri.parse(codexIdeThreadUri(codexExtension.id, record.id));
  const opened = await vscode.env.openExternal(uri);
  if (!opened) throw new Error("VS Code 未能将此对话路由到 Codex 扩展。");
}

export function activate(context: vscode.ExtensionContext): void {
  const containers = detectContainers();
  chosenViewId = containers.viewId;
  targetContainerId = containers.containerId;
  void vscode.commands.executeCommand("setContext", "sponge.codex.secondaryContainer", containers.mode === "secondary");
  void vscode.commands.executeCommand("setContext", "sponge.codex.legacyContainer", containers.mode === "legacy");

  dataService = new CodexDataService(resolveCliTarget);
  webviews = new ManagerWebviewProvider(context.extensionUri, managerSnapshot, handleWebviewMessage);
  accounts = new AccountManager(
    context.globalStorageUri.fsPath,
    resolve(process.env.CODEX_HOME || join(homedir(), ".codex")),
    context.secrets,
    new CodexAccountBackend(resolveCliTarget, async url => {
      if (!await vscode.env.openExternal(vscode.Uri.parse(url))) throw new Error("未能打开官方授权网页，请检查默认浏览器后重试。");
    }),
    () => { void webviews?.sendAllStates(); },
    async () => { dataService?.dispose(); }
  );
  context.subscriptions.push(accounts);
  const workspaceProject = currentWorkspaceProjectPath();
  startupConversation = new StartupConversation(Boolean(workspaceProject), async () => {
    const extension = vscode.extensions.getExtension("openai.chatgpt");
    if (!extension) throw new Error("未检测到 Codex 扩展，无法自动打开对话。");
    await extension.activate();
  }, openRecordInIde);
  manager = new SessionManager(dataService, makeCliStatus, snapshot => {
    accounts?.observeUsage(snapshot.usage);
    void webviews?.sendAllStates();
    updateQuotaStatusBar(snapshot);
  }, workspaceProject, context.workspaceState.get("sponge.sessionFilters"), filters => {
    void context.workspaceState.update("sponge.sessionFilters", filters).then(undefined, error => {
      void vscode.window.showWarningMessage(`会话筛选条件未能保存：${shortError(error)}`);
    });
  });

  quotaStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1000);
  quotaStatusBar.name = "Codex quota remaining";
  quotaStatusBar.command = "sponge.sessions.usage";
  quotaStatusBar.text = "$(sync~spin) Codex 用量";
  quotaStatusBar.tooltip = "正在读取 Codex 配额。点击查看账户用量。";
  quotaStatusBar.show();
  context.subscriptions.push(quotaStatusBar);

  const usageRefreshTimer = setInterval(() => { if (!accounts?.snapshot().busy) void refreshAllUsage(); }, ACCOUNT_USAGE_REFRESH_MINUTES * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(usageRefreshTimer) });
  // Recompute calendar-day reset suffixes even when the next account request fails.
  const titleRefreshTimer = setInterval(() => {
    if (manager) updateQuotaStatusBar(manager.snapshot());
    void webviews?.sendAllStates();
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(titleRefreshTimer) });

  const sessionListRefreshTimer = startSessionListAutoRefresh(
    () => accounts?.snapshot().busy ? Promise.resolve() : manager?.refreshList() ?? Promise.resolve(),
    error => console.error("Codex conversation list auto-refresh failed.", error)
  );
  context.subscriptions.push(sessionListRefreshTimer);

  if (chosenViewId) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(MODERN_VIEW_ID, webviews, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(LEGACY_VIEW_ID, webviews, { webviewOptions: { retainContextWhenHidden: true } }));
  } else {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -20);
    statusBar.text = "$(history) Codex 对话";
    statusBar.tooltip = "打开 Codex 对话管理器（Codex 视图容器不可用时的备用入口）";
    statusBar.command = "sponge.sessions.open";
    statusBar.show();
    context.subscriptions.push(statusBar);
    void vscode.window.showWarningMessage("未能定位 Codex 扩展的视图容器。Codex 对话管理器可从命令面板或状态栏备用入口打开。请确认 openai.chatgpt 扩展已安装并启用。");
    fallbackWarningShown = true;
  }

  const addCommand = (id: string, callback: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => {
    startupConversation?.cancel();
    return callback(...args);
  }));
  addCommand("sponge.sessions.open", () => openManager());
  addCommand("sponge.sessions.refresh", () => manager?.refresh());
  addCommand("sponge.codex.detectCli", () => detectCli());
  addCommand("sponge.codex.configureCliPath", () => configureCliPath());
  addCommand("sponge.codex.verifyCli", () => verifyCli(true));
  addCommand("sponge.codex.clearCliPath", () => clearCliPath());
  addCommand("sponge.sessions.usage", () => openManager("usage"));
  addCommand("sponge.accounts.pick", async () => {
    try { await pickAccount(); }
    catch (error) { await vscode.window.showErrorMessage(shortError(error)); await manager?.refreshUsage(); }
  });
  addCommand("sponge.sessions.filterSource", async () => {
    const selected = await vscode.window.showQuickPick([
      { label: "全部", value: "all" }, { label: "本地", value: "local" }, { label: "云端", value: "cloud" }
    ], { placeHolder: "按对话来源筛选" });
    if (selected) await manager?.setSource(selected.value as "all" | "local" | "cloud");
  });
  addCommand("sponge.sessions.filterProject", async () => {
    const projects = manager?.snapshot().projects ?? [];
    const selected = await vscode.window.showQuickPick([
      { label: "全部项目", value: "" }, ...projects.map(label => ({ label, value: label }))
    ], { placeHolder: "按本地工作目录或云端环境筛选" });
    if (selected) await manager?.setProject(selected.value);
  });
  addCommand("sponge.sessions.sort", async () => {
    const current = manager?.snapshot();
    const selected = await vscode.window.showQuickPick([
      { label: "最近更新时间（倒序）", key: "updated", direction: "desc" },
      { label: "最近更新时间（正序）", key: "updated", direction: "asc" },
      { label: "开始时间（倒序）", key: "created", direction: "desc" },
      { label: "开始时间（正序）", key: "created", direction: "asc" },
      { label: "最近活跃时间（倒序）", key: "active", direction: "desc" },
      { label: "最近活跃时间（正序）", key: "active", direction: "asc" }
    ], { placeHolder: `按时间排序（当前：${current?.sortKey ?? "updated"}）` });
    if (selected) await manager?.setSort(selected.key as "created" | "updated" | "active", selected.direction as "asc" | "desc");
  });

  const cliStatus = makeCliStatus();
  if (cliStatus.source !== "missing" && isRunnableFile(cliStatus.path!)) {
    verification = { path: cliStatus.path!, message: "CLI 已检测到；尚未完成版本和 App Server 验证。" };
  }
  void (async () => {
    await accounts!.initialize().catch(async error => { await vscode.window.showErrorMessage(shortError(error)); });
    await manager!.initialize();
    await startupConversation!.restore(() => manager!.snapshot()).catch(error => {
      void vscode.window.showWarningMessage(`自动打开首条对话未完成：${shortError(error)}`);
    });
    try {
      if (!vscode.env.remoteName && !vscode.workspace.getConfiguration("chatgpt").get<boolean>("runCodexInWindowsSubsystemForLinux", false)) {
        await accounts!.verifyAfterReload();
        void webviews?.sendAllStates();
      }
    } catch (error) {
      await vscode.window.showErrorMessage(shortError(error));
    }
    void refreshSavedAccountQuotas();
  })().catch(error => { void vscode.window.showErrorMessage(shortError(error)); });
}

export function deactivate(): void {
  startupConversation?.cancel();
  startupConversation = undefined;
  accounts?.dispose();
  accounts = undefined;
  manager?.dispose();
  quotaStatusBar?.dispose();
  statusBar?.dispose();
  manager = undefined;
  dataService = undefined;
  quotaStatusBar = undefined;
  statusBar = undefined;
}
