import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ManagerSnapshot } from "./types";
import { buildQuotaStatusBarContent, formatManagerViewTitle } from "./quotaStatusBar";

export interface WebviewMessageHandler {
  (message: Record<string, unknown>, webview: vscode.Webview): void | Promise<void>;
}

export class ManagerWebviewProvider implements vscode.WebviewViewProvider {
  private readonly webviews = new Set<vscode.Webview>();
  private readonly views = new Set<vscode.WebviewView>();
  private quotaTitle = buildQuotaStatusBarContent().title;
  private listRefreshedAt?: number;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getSnapshot: () => ManagerSnapshot,
    private readonly onMessage: WebviewMessageHandler
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.views.add(view);
    view.title = this.getViewTitle();
    this.attach(view.webview);
    view.onDidDispose(() => {
      this.views.delete(view);
      this.webviews.delete(view.webview);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.sendState(view.webview);
    });
  }

  setQuotaTitle(title: string): void {
    this.quotaTitle = title;
    for (const view of this.views) view.title = this.getViewTitle();
  }

  setListRefreshedAt(value?: number): void {
    this.listRefreshedAt = value;
    for (const view of this.views) view.title = this.getViewTitle();
  }

  private getViewTitle(): string {
    return formatManagerViewTitle(this.quotaTitle, this.listRefreshedAt);
  }

  async openPanel(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "sponge.codexManager",
      "Codex 对话管理器",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.attach(panel.webview);
    panel.onDidDispose(() => this.webviews.delete(panel.webview));
  }

  async postMessage(message: Record<string, unknown>): Promise<void> {
    await Promise.all([...this.webviews].map(webview => webview.postMessage(message).then(delivered => {
      if (!delivered) this.webviews.delete(webview);
    })));
  }

  async sendAllStates(): Promise<void> {
    await Promise.all([...this.webviews].map(webview => this.sendState(webview)));
  }

  private attach(webview: vscode.Webview): void {
    webview.options = { enableScripts: true };
    const nonce = createNonce();
    webview.html = getHtml(nonce, webview.cspSource);
    this.webviews.add(webview);
    webview.onDidReceiveMessage(message => {
      if (message && typeof message === "object") void this.onMessage(message as Record<string, unknown>, webview);
    });
    void this.sendState(webview);
  }

  private async sendState(webview: vscode.Webview): Promise<void> {
    await webview.postMessage({ type: "state", snapshot: this.getSnapshot() });
  }
}

function createNonce(): string {
  return randomBytes(18).toString("base64url");
}

function getHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
  <title>Codex 对话管理器</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { padding: 0 12px 18px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    h1 { font-size: 17px; margin: 14px 0 4px; font-weight: 600; }
    h2 { font-size: 15px; margin: 18px 0 8px; }
    h3 { font-size: 13px; margin: 0 0 6px; }
    p { line-height: 1.5; }
    .muted { color: var(--vscode-descriptionForeground); }
    .subtle { font-size: 11px; }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .header-main { min-width: 0; flex: 1; }
    .account-button { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; border: 0; font-size: 11px; line-height: 16px; background: transparent; color: var(--vscode-descriptionForeground); text-align: left; }
    .account-list { display: grid; gap: 3px; margin-top: 8px; }
    .account-row { display: flex; align-items: baseline; gap: 6px; width: 100%; padding: 5px 6px; border: 0; background: transparent; color: #999; font-size: 12px; text-align: left; }
    .account-row.current { color: #fff; font-size: 14px; font-weight: 600; background: #292929; }
    .account-row:disabled { opacity: 1; cursor: default; }
    .account-indicator { flex: 0 0 12px; }
    .account-row-content { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; min-width: 0; }
    .account-email { overflow-wrap: anywhere; }
    .account-quota { font-variant-numeric: tabular-nums; }
    .tabs { display: flex; gap: 3px; border-bottom: 1px solid var(--vscode-panel-border); margin: 12px -2px 12px; }
    button, select, input { font: inherit; color: inherit; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 3px; padding: 4px 8px; cursor: pointer; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.danger { color: var(--vscode-errorForeground); }
    button:disabled { opacity: .55; cursor: default; }
    .tab { border: 0; background: transparent; border-radius: 0; padding: 7px 8px; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; }
    .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .toolbar { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin: 9px 0; }
    .toolbar .wide { grid-column: 1 / -1; }
    input, select { width: 100%; min-width: 0; padding: 5px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 3px; }
    input:focus, select:focus, button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    label { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
    .field { min-width: 0; }
    .project-picker { position: relative; }
    .project-options { position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 20; max-height: 240px; overflow-y: auto; border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); box-shadow: 0 4px 12px #0005; }
    .project-option { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; padding: 6px 8px; background: transparent; color: inherit; overflow-wrap: anywhere; white-space: normal; }
    .project-option:hover, .project-option:focus { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .project-option[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
    .project-empty { padding: 7px 8px; color: var(--vscode-descriptionForeground); }
    .notice { border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-editorWarning-background, transparent); padding: 7px 9px; margin: 9px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .notice.error { border-color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); }
    .notice.success { border-color: var(--vscode-testing-iconPassed); }
    .summary-line { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin: 9px 0; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 9px; margin: 8px 0; background: var(--vscode-editor-background); }
    .card-head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .title { overflow-wrap: anywhere; font-weight: 600; line-height: 1.35; }
    .tag { flex: 0 0 auto; border-radius: 9px; padding: 1px 7px; font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .preview { margin: 7px 0; color: var(--vscode-descriptionForeground); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 4.5em; overflow: hidden; }
    .metadata { display: grid; gap: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .actions button { padding: 3px 7px; font-size: 11px; }
    .question-picker { position: relative; margin-top: 9px; }
    .question-picker label { margin-bottom: 4px; }
    .question-picker-state { min-height: 16px; margin-top: 4px; line-height: 1.4; }
    .question-options { position: absolute; top: 42px; left: 0; right: 0; z-index: 5; max-height: 220px; overflow-y: auto; border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); box-shadow: 0 4px 12px #0005; }
    .question-option { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; padding: 7px 8px; background: transparent; color: inherit; white-space: normal; }
    .question-option:hover, .question-option:focus { background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
    .question-option[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
    .question-option-head { display: flex; justify-content: space-between; gap: 6px; margin-bottom: 3px; font-size: 10px; opacity: .8; }
    .question-option-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 11px; line-height: 1.4; }
    .question-options-empty { padding: 9px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; }
    .pager { display: flex; justify-content: space-between; gap: 8px; margin: 12px 0; }
    .empty { border: 1px dashed var(--vscode-panel-border); border-radius: 4px; padding: 16px 10px; text-align: center; color: var(--vscode-descriptionForeground); }
    .section { padding: 8px 0 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    .metric { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 4px 0; }
    .metric > div { min-width: 120px; }
    .bar { height: 6px; background: var(--vscode-panel-border); border-radius: 4px; margin: 5px 0 8px; overflow: hidden; }
    .bar > span { display: block; height: 100%; background: var(--vscode-charts-blue); }
    .quota-row { margin: 8px 0 12px; }
    .token-view-toggle { display: flex; gap: 6px; margin: 7px 0; }
    .token-view-toggle button[aria-pressed="true"] { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
    .token-chart { display: block; width: 100%; height: auto; margin: 6px 0; }
    .token-chart-grid { stroke: var(--vscode-panel-border); stroke-width: 1; }
    .token-chart-axis { fill: var(--vscode-descriptionForeground); font-size: 11px; }
    .token-chart-line { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .token-chart-point { fill: var(--vscode-charts-blue); stroke: var(--vscode-sideBar-background); stroke-width: 2; }
    .quota-line { display: flex; justify-content: space-between; gap: 8px; }
    .setting-buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 9px 0; }
    .path { overflow-wrap: anywhere; word-break: break-all; padding: 7px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; }
    .modal-backdrop { position: fixed; inset: 0; z-index: 10; display: none; align-items: center; justify-content: center; padding: 12px; background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent); }
    .modal { width: min(560px, 100%); max-height: 90vh; overflow: auto; padding: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); box-shadow: 0 8px 30px #0005; }
    .conversation-modal { width: min(1040px, 100%); height: min(860px, 90vh); display: flex; flex-direction: column; overflow: hidden; }
    .conversation-modal > .modal-head, .conversation-meta, .conversation-summary, .conversation-actions { flex: 0 0 auto; }
    .conversation-modal > .modal-head h2 { min-width: 0; overflow-wrap: anywhere; }
    .conversation-meta { max-height: 82px; overflow-y: auto; margin: 4px 0 8px; }
    .conversation-summary { margin: 0 0 8px; }
    .conversation-summary summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 11px; }
    .conversation-summary pre { max-height: 110px; overflow: auto; margin: 6px 0 0; }
    .transcript-panel { flex: 1 1 auto; min-height: 0; overflow-y: auto; scroll-behavior: smooth; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-sideBar-background); }
    .transcript-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 6px; position: sticky; top: -12px; z-index: 1; padding: 2px 0 8px; background: var(--vscode-sideBar-background); }
    .transcript-toolbar button { font-size: 10px; padding: 3px 6px; }
    .transcript-toolbar span { text-align: center; }
    .transcript-messages { min-height: 100%; }
    .transcript-message { scroll-margin: 12px; padding: 10px 11px; margin: 0 0 10px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-editor-background); }
    .transcript-message.user { border-left: 3px solid var(--vscode-charts-blue); }
    .transcript-message.assistant { border-left: 3px solid var(--vscode-charts-green); }
    .transcript-message-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .transcript-message-content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
    .transcript-empty { padding: 20px 12px; text-align: center; color: var(--vscode-descriptionForeground); }
    .conversation-actions { padding-top: 7px; }
    mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; }
    .modal pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
    .modal-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .loading { color: var(--vscode-descriptionForeground); }
    .small-note { font-size: 11px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
    @media (max-width: 620px) {
      .conversation-modal { height: 92vh; }
    }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="header"><div class="header-main"><h1>Codex 对话管理器</h1><button id="accountMenu" class="account-button" type="button" aria-haspopup="dialog" aria-label="选择或管理 Codex 账户" title="添加、保存或切换 Codex 账户">账户 ▾</button></div><button id="refresh" title="刷新会话和用量">刷新</button></div>
  <section id="accountList" class="account-list" aria-label="所有 Codex 账户"></section>
  <div id="notices"></div>
  <nav class="tabs" aria-label="管理器页面">
    <button class="tab active" data-tab="sessions">对话</button>
    <button class="tab" data-tab="usage">账户用量</button>
    <button class="tab" data-tab="cli">CLI / 环境</button>
  </nav>
  <main id="sessionsView">
    <div class="toolbar">
      <div class="field wide"><label for="search">按标题搜索</label><input id="search" type="search" placeholder="搜索已加载及后续分页中的标题"></div>
      <div class="field"><label for="source">来源</label><select id="source"><option value="all">全部</option><option value="local">本地</option><option value="cloud">云端</option></select></div>
      <div class="field"><label for="projectSearch">项目 / 环境</label><div class="project-picker"><input id="projectSearch" type="search" role="combobox" aria-autocomplete="list" aria-controls="projectOptions" aria-expanded="false" autocomplete="off" placeholder="搜索项目或路径"><div id="projectOptions" class="project-options" role="listbox" hidden></div></div><div id="projectFilterHint" class="small-note" hidden>云端来源不应用项目 / 环境筛选；切回“全部”或“本地”后会恢复此前选择。</div></div>
      <div class="field"><label for="sort">排序字段</label><select id="sort"><option value="updated">最近更新时间</option><option value="active">最近活跃时间</option><option value="created">开始时间</option></select></div>
      <div class="field"><label for="direction">顺序</label><select id="direction"><option value="desc">倒序</option><option value="asc">正序</option></select></div>
    </div>
    <div class="summary-line"><span id="count" class="muted subtle"></span><span id="loading" class="loading subtle" hidden>正在读取…</span></div>
    <div id="results"></div>
    <div class="pager"><button id="previous">上一页</button><span id="pageLabel" class="muted subtle"></span><button id="next">下一页 / 继续扫描</button></div>
    <p class="small-note">搜索与项目选项依据已加载的会话元数据；翻页会继续加载。删除仅作用于本地 Codex 对话记录，且可能同时删除派生子对话。云端仅展示 CLI 实际返回的摘要与环境字段。</p>
  </main>
  <main id="usageView" hidden></main>
  <main id="cliView" hidden></main>
  <div id="modalRoot" class="modal-backdrop" role="presentation"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let snapshot;
    let activeTab = 'sessions';
    let searchTimer;
    let projectOptionsOpen = false;
    let conversationMessages = [];
    let conversationTurnCount = 0;
    let visibleTurnStart = 0;
    let visibleTurnEnd = 0;
    let detailsReturnFocus;
    let dailyTokenViewMode = 'chart';
    const questionStates = new Map();
    let activeQuestionPickerKey = '';
    const $ = (selector) => document.querySelector(selector);
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const send = (type, data = {}) => vscode.postMessage({ type, ...data });
    const formatDate = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(typeof value === 'number' && value < 100000000000 ? value * 1000 : value)) : '未提供';
    const percentText = (value) => (Math.round(value * 10) / 10) + '%';
    const resetCountdown = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '服务未提供';
      const remainingMinutes = Math.ceil((value - Date.now()) / 60000);
      if (remainingMinutes <= 0) return '已到重置时间，等待刷新用量';
      const days = Math.floor(remainingMinutes / 1440);
      const hours = Math.floor((remainingMinutes % 1440) / 60);
      const minutes = remainingMinutes % 60;
      if (days) return '约 ' + days + ' 天 ' + hours + ' 小时';
      if (hours) return minutes ? '约 ' + hours + ' 小时 ' + minutes + ' 分钟' : '约 ' + hours + ' 小时';
      return '约 ' + minutes + ' 分钟';
    };
    const duration = (minutes) => !Number.isFinite(minutes) ? '未提供' : minutes >= 1440 ? (minutes / 1440) + ' 天' : minutes >= 60 ? (minutes / 60) + ' 小时' : minutes + ' 分钟';
    const planName = (value) => ({plus:'Plus', pro:'Pro', team:'Team', business:'Business', enterprise:'Enterprise', free:'Free'}[String(value || '').toLowerCase()] || value || '未提供');
    const showStatus = (value) => ({active:'进行中', idle:'空闲', notLoaded:'未加载', systemError:'系统错误', completed:'已完成', failed:'失败', queued:'排队中', running:'运行中', cancelled:'已取消', canceled:'已取消'}[String(value || '')] || value || '未提供');
    function setTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
      $('#sessionsView').hidden = tab !== 'sessions';
      $('#usageView').hidden = tab !== 'usage';
      $('#cliView').hidden = tab !== 'cli';
    }
    function formatBeijingDate(value) {
      const dateText = String(value || '').trim();
      if (!dateText) return '日期未提供';
      const dateOnly = dateText.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/);
      if (dateOnly) return dateOnly[0];
      const datePrefix = dateText.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})T/);
      const hasTimeZone = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(dateText);
      if (datePrefix && !hasTimeZone) return datePrefix[1];
      const timestamp = Date.parse(dateText);
      if (!Number.isFinite(timestamp)) return dateText;
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(timestamp));
      const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return values.year + '-' + values.month + '-' + values.day;
    }
    function recordTime(record, key) {
      if (key === 'created') return record.createdAt;
      if (key === 'active') return record.recencyAt || record.updatedAt;
      return record.updatedAt;
    }
    function renderNotices() {
      const parts = [];
      if (snapshot.message) parts.push('<div class="notice success">' + escapeHtml(snapshot.message) + '</div>');
      if (snapshot.cli.source === 'missing') parts.push('<div class="notice error">未找到可用的 Codex App Server CLI。会话、账户与用量功能暂不可用。请安装 ChatGPT/Codex VS Code 扩展、将 Codex CLI 加入 PATH，或配置启动程序。</div>');
      if (snapshot.errors.local) parts.push('<div class="notice error"><b>本地来源不可用：</b> ' + escapeHtml(snapshot.errors.local) + '</div>');
      if (snapshot.errors.cloud) parts.push('<div class="notice error"><b>云端来源不可用：</b> ' + escapeHtml(snapshot.errors.cloud) + '</div>');
      if (snapshot.cli.remoteWarning) parts.push('<div class="notice">' + escapeHtml(snapshot.cli.remoteWarning) + '</div>');
      if (snapshot.loading) parts.push('<div class="notice">正在读取 Codex 数据；本地与云端来源独立加载。</div>');
      $('#notices').innerHTML = parts.join('');
    }
    function updateProjectOptions(open = projectOptionsOpen) {
      const input = $('#projectSearch');
      const optionsRoot = $('#projectOptions');
      if (input.disabled) {
        optionsRoot.innerHTML = '';
        projectOptionsOpen = false;
        optionsRoot.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        return;
      }
      const current = snapshot.projectFilter;
      const query = (input.value || '').trim().toLocaleLowerCase();
      const projects = (snapshot.projects || []).filter(project => !query || project.toLocaleLowerCase().includes(query));
      if (!query && current && !projects.includes(current)) projects.unshift(current);
      const options = [];
      if (!query) options.push('<button class="project-option" type="button" role="option" data-project="" aria-selected="' + (!current) + '">全部项目</button>');
      options.push(...projects.map(project => '<button class="project-option" type="button" role="option" data-project="' + escapeHtml(project) + '" aria-selected="' + (project === current) + '">' + escapeHtml(project) + '</button>'));
      if (query && !projects.length) options.push('<div class="project-empty" role="option" aria-disabled="true">没有匹配项目</div>');
      optionsRoot.innerHTML = options.join('');
      projectOptionsOpen = open;
      optionsRoot.hidden = !open;
      input.setAttribute('aria-expanded', String(open));
    }
    function renderSessions() {
      if (document.activeElement !== $('#search')) $('#search').value = snapshot.search || '';
      $('#source').value = snapshot.sourceFilter;
      $('#sort').value = snapshot.sortKey;
      $('#direction').value = snapshot.sortDirection;
      const projectSearch = $('#projectSearch');
      const cloudOnly = snapshot.sourceFilter === 'cloud';
      projectSearch.disabled = cloudOnly;
      projectSearch.placeholder = cloudOnly ? '云端会话不应用项目筛选' : '搜索项目或路径';
      projectSearch.title = cloudOnly ? '云端来源会忽略项目 / 环境筛选条件。' : '';
      $('#projectFilterHint').hidden = !cloudOnly;
      if (cloudOnly) {
        projectOptionsOpen = false;
        projectSearch.value = '';
      } else if (document.activeElement !== projectSearch) {
        projectSearch.value = snapshot.projectFilter || '';
      }
      updateProjectOptions(projectOptionsOpen);
      $('#loading').hidden = !snapshot.loading;
      $('#count').textContent = '已加载 ' + snapshot.totalLoaded + ' 条 · 已加载结果中命中 ' + snapshot.filteredCount + ' 条';
      $('#pageLabel').textContent = '第 ' + (snapshot.pageIndex + 1) + ' 页';
      $('#previous').disabled = snapshot.pageIndex <= 0 || snapshot.loading;
      $('#next').disabled = !snapshot.hasMore || snapshot.loading;
      const container = $('#results');
      if (!snapshot.records.length) {
        const anyError = snapshot.errors.local || snapshot.errors.cloud;
        const emptyText = anyError
          ? '当前没有可显示的会话。请检查上方来源状态。'
          : snapshot.loading
            ? '正在读取会话…'
            : snapshot.sourceFilter === 'cloud' && !(snapshot.search || '').trim()
              ? 'Codex Cloud 当前没有返回可显示的任务。请确认当前 Codex CLI 登录的账户和云端任务来源。'
              : '此筛选条件下没有会话。';
        container.innerHTML = '<div class="empty">' + escapeHtml(emptyText) + '</div>';
        return;
      }
      container.innerHTML = snapshot.records.map(record => {
        const source = record.source === 'local' ? '本地' : '云端';
        const timeText = record.source === 'local'
          ? '开始 ' + formatDate(record.createdAt) + ' · 更新 ' + formatDate(record.updatedAt)
          : '开始 ' + formatDate(record.createdAt) + ' · 更新 ' + formatDate(record.updatedAt);
        const status = record.source === 'local' && record.status === 'active' ? '进行中' : showStatus(record.status);
        const projectLabel = record.source === 'local' ? '工作目录' : '环境';
        const actions = record.source === 'local'
          ? (snapshot.cli.platform === 'linux'
            ? '<button class="primary" data-action="openInIde" data-key="' + escapeHtml(record.key) + '" title="打开整条会话">在 VS Code Codex 中打开</button>'
            : '<button class="primary" data-action="open" data-key="' + escapeHtml(record.key) + '" title="打开整条会话">在 ChatGPT Windows 中打开</button><button data-action="openInIde" data-key="' + escapeHtml(record.key) + '" title="打开整条会话">在 VS Code Codex 中打开</button>')
            + '<button data-action="rename" data-key="' + escapeHtml(record.key) + '">修改名称</button><button class="danger" data-action="delete" data-key="' + escapeHtml(record.key) + '">删除本地记录</button>'
          : '<button class="primary" data-action="open" data-key="' + escapeHtml(record.key) + '">打开云端会话</button><button data-action="details" data-key="' + escapeHtml(record.key) + '">详情</button>';
      const questionPicker = record.source === 'local'
          ? questionPickerMarkup(record)
          : '<div class="small-note" style="margin-top:8px">Codex Cloud 列表未提供完整问题目录。</div>';
        const endText = record.status === 'active' ? ' · 最近一轮：进行中' : record.lastTurnEndedAt ? ' · 最近一轮结束：' + formatDate(record.lastTurnEndedAt) : '';
        return '<article class="card"><div class="card-head"><div class="title">' + escapeHtml(record.title) + '</div><span class="tag">' + source + '</span></div>'
          + (record.preview ? '<div class="preview">' + escapeHtml(record.preview) + '</div>' : '')
          + '<div class="metadata"><div>' + projectLabel + '：' + escapeHtml(record.projectLabel) + '</div><div>' + escapeHtml(timeText) + escapeHtml(endText) + '</div><div>状态：' + escapeHtml(status) + (record.sourceLabel ? ' · 来源类型：' + escapeHtml(record.sourceLabel) : '') + '</div></div>'
          + questionPicker + '<div class="actions">' + actions + '</div></article>';
      }).join('');
      for (const record of snapshot.records) if (record.source === 'local') renderQuestionPicker(record.key);
    }
    function renderDailyTokenChart(rows) {
      const entries = (Array.isArray(rows) ? rows : []).map((row, index) => ({
        row,
        index,
        date: String(row.startDate || '')
      })).sort((left, right) => {
        const leftBeijingDate = formatBeijingDate(left.date);
        const rightBeijingDate = formatBeijingDate(right.date);
        return leftBeijingDate.localeCompare(rightBeijingDate)
          || left.date.localeCompare(right.date)
          || left.index - right.index;
      }).slice(-30).map(entry => entry.row);
      const validTokens = entries.filter(row => Number.isFinite(row.tokens) && row.tokens >= 0);
      if (!validTokens.length) return '<div class="empty">服务未提供可绘制的每日 token 数值。</div>';

      const width = 720;
      const height = 220;
      const left = 64;
      const right = 16;
      const top = 12;
      const bottom = 176;
      const plotWidth = width - left - right;
      const plotHeight = bottom - top;
      const maximum = Math.max(...validTokens.map(row => row.tokens));
      const scaleMaximum = Math.max(4, Math.ceil(maximum / 4) * 4);
      const xPosition = index => entries.length === 1 ? left + plotWidth / 2 : left + index * plotWidth / (entries.length - 1);
      const grid = Array.from({ length: 5 }, (_, index) => {
        const y = top + index * plotHeight / 4;
        const value = Math.round(scaleMaximum * (4 - index) / 4);
        return '<line class="token-chart-grid" x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (width - right) + '" y2="' + y.toFixed(1) + '"></line>'
          + '<text class="token-chart-axis" x="' + (left - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + value.toLocaleString() + '</text>';
      }).join('');
      const labelCount = Math.min(5, entries.length);
      const labelIndices = new Set(Array.from({ length: labelCount }, (_, index) => labelCount === 1 ? 0 : Math.round(index * (entries.length - 1) / (labelCount - 1))));
      const xLabels = [...labelIndices].map(index => {
        const label = formatBeijingDate(entries[index].startDate);
        const anchor = index === 0 ? 'start' : index === entries.length - 1 ? 'end' : 'middle';
        return '<text class="token-chart-axis" x="' + xPosition(index).toFixed(1) + '" y="204" text-anchor="' + anchor + '">' + escapeHtml(label) + '</text>';
      }).join('');
      const pathCommands = [];
      const points = [];
      let previousIndex = -2;
      entries.forEach((row, index) => {
        if (!Number.isFinite(row.tokens) || row.tokens < 0) {
          previousIndex = -2;
          return;
        }
        const x = xPosition(index);
        const y = bottom - row.tokens / scaleMaximum * plotHeight;
        pathCommands.push((previousIndex === index - 1 ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1));
        previousIndex = index;
        const date = formatBeijingDate(row.startDate);
        const tokenText = Number(row.tokens).toLocaleString();
        points.push('<circle class="token-chart-point" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.8"><title>' + escapeHtml(date + '：' + tokenText + ' tokens') + '</title></circle>');
      });
      const description = '每日 token 活动折线图，共 ' + entries.length + ' 天，日期按北京时间显示，纵轴为每日 token 数。';
      return '<svg class="token-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeHtml(description) + '">'
        + '<title>每日 token 活动折线图</title><desc>' + escapeHtml(description) + '</desc>'
        + grid + xLabels + '<path class="token-chart-line" d="' + pathCommands.join(' ') + '"></path>' + points.join('') + '</svg>';
    }
    function renderDailyTokenList(rows) {
      return rows.slice(-30).reverse().map(row => '<div class="quota-line subtle"><span>' + escapeHtml(row.startDate || '日期未提供') + '</span><span>' + (Number.isFinite(row.tokens) ? Number(row.tokens).toLocaleString() : '服务未提供') + '</span></div>').join('');
    }
    function renderResetCreditDetails(credits, availableCount) {
      if (Array.isArray(credits) && credits.length) {
        return '<div class="reset-credit-list">' + credits.map((credit, index) => '<div class="quota-line small-note"><span>第 ' + (index + 1) + ' 次重置</span><span>过期时间：' + escapeHtml(formatDate(credit.expiresAt)) + '</span></div>').join('') + '</div>';
      }
      return availableCount === 0
        ? '<p class="small-note">当前没有可用的重置次数。</p>'
        : '<p class="small-note">服务未提供每次重置额度的过期时间。</p>';
    }
    function renderUsage() {
      const usage = snapshot.usage;
      if (!usage) {
        $('#usageView').innerHTML = '<div class="empty">' + (snapshot.loading ? '正在读取账户信息…' : '尚未读取账户信息。') + '</div>';
        return;
      }
      const account = usage.accountStatus === 'available'
        ? '<div>账户：' + escapeHtml(usage.email || '服务未提供账户标识') + '</div><div>计划：' + escapeHtml(planName(usage.planType)) + '</div><div>认证方式：' + escapeHtml(usage.authType || '服务未提供') + '</div>'
        : '<div class="notice ' + (usage.accountStatus === 'error' ? 'error' : '') + '">' + escapeHtml(usage.accountMessage || '服务未提供账户信息。') + '</div>';
      const resetCount = Number.isInteger(usage.availableResetCount) && usage.availableResetCount >= 0
        ? Number(usage.availableResetCount).toLocaleString() + ' 次'
        : '服务未提供';
      const resetCreditDetails = renderResetCreditDetails(usage.resetCredits, usage.availableResetCount);
      let quota = '';
      if (usage.quotaStatus !== 'available') {
        quota = '<div class="notice ' + (usage.quotaStatus === 'error' ? 'error' : '') + '">' + escapeHtml(usage.quotaMessage || '服务未提供配额信息。') + '</div>';
      } else {
        quota = (usage.buckets || []).map(bucket => {
          const windows = ['primary','secondary'].map(key => {
            const window = bucket[key];
            if (!window) return '';
            const hasPercent = Number.isFinite(window.usedPercent);
            const usedPercent = hasPercent ? Math.max(0, Math.min(100, window.usedPercent)) : 0;
            const remainingPercent = 100 - usedPercent;
            const heading = key === 'primary' ? '5小时剩余' : '周剩余';
            const resetAt = Number.isFinite(window.resetsAt) ? window.resetsAt : '';
            return '<div class="quota-row"><div class="quota-line"><b>' + heading + '</b><span>' + (hasPercent ? escapeHtml(percentText(remainingPercent)) : '服务未提供剩余比例') + '</span></div>'
              + (hasPercent ? '<div class="bar"><span style="width:' + remainingPercent + '%"></span></div>' : '')
              + '<div class="muted subtle">已用：' + (hasPercent ? escapeHtml(percentText(usedPercent)) : '服务未提供') + ' · 窗口时长：' + escapeHtml(duration(window.windowDurationMins)) + ' · 重置时间：' + escapeHtml(formatDate(window.resetsAt)) + ' · 距重置：<span data-reset-countdown="' + resetAt + '">' + escapeHtml(resetCountdown(window.resetsAt)) + '</span></div></div>';
          }).join('');
          return '<section class="section"><h3>' + escapeHtml(bucket.label) + '</h3>' + (windows || '<div class="muted">服务未提供此配额桶的窗口数据。</div>') + '</section>';
        }).join('');
      }
      let tokenContent = '';
      let dailyTokenRows = [];
      if (usage.tokenStatus !== 'available') {
        tokenContent = '<div class="notice ' + (usage.tokenStatus === 'error' ? 'error' : '') + '">' + escapeHtml(usage.tokenMessage || '服务未提供 token 活动统计。') + '</div>';
      } else {
        const labels = {lifetimeTokens:'累计 token',peakDailyTokens:'单日峰值 token',longestRunningTurnSec:'最长运行轮次（秒）',currentStreakDays:'当前连续使用天数',longestStreakDays:'最长连续使用天数'};
        tokenContent = '<div class="metric">' + Object.entries(labels).map(([key,label]) => {
          const value = usage.tokenSummary && usage.tokenSummary[key];
          return '<div><div class="muted subtle">' + label + '</div><b>' + (Number.isFinite(value) ? Number(value).toLocaleString() : '服务未提供') + '</b></div>';
        }).join('') + '</div>';
        if (usage.dailyUsageBuckets && usage.dailyUsageBuckets.length) {
          dailyTokenRows = usage.dailyUsageBuckets.slice();
          tokenContent += '<h3>每日 token 活动</h3><p class="small-note">折线图日期按北京时间（Asia/Shanghai）显示；图表不代表配额或费用。</p>'
            + '<div class="token-view-toggle" role="group" aria-label="每日 token 活动视图"><button type="button" id="dailyTokenChartButton" aria-pressed="' + (dailyTokenViewMode === 'chart') + '">折线图</button><button type="button" id="dailyTokenListButton" aria-pressed="' + (dailyTokenViewMode === 'list') + '">数据列表</button></div>'
            + '<div id="dailyTokenView"></div>';
        }
      }
      $('#usageView').innerHTML = '<section class="section"><h2>账户</h2><div class="metric">' + account + '</div></section>'
        + '<section class="section"><h2>重置次数</h2><div class="quota-line"><span>可用重置次数</span><b>' + escapeHtml(resetCount) + '</b></div>' + resetCreditDetails + '<p class="small-note">次数与过期时间来自 Codex 服务；过期时间按本机时区显示。</p></section>'
        + '<section class="section"><div class="header"><h2>配额使用比例</h2><button id="usageRefresh">刷新用量</button></div><p class="small-note">显示窗口配额、服务返回的下次重置时间和倒计时；倒计时每分钟更新，不代表美元账单或逐对话费用。</p>' + quota + '</section>'
        + '<section class="section"><h2>Token 活动统计</h2><p class="small-note">此区域仅展示服务提供的活动摘要，与配额窗口分开显示。</p>' + tokenContent + '</section>';
      $('#usageRefresh').addEventListener('click', () => send('refreshUsage'));
      if (dailyTokenRows.length) {
        const renderDailyTokens = () => {
          $('#dailyTokenView').innerHTML = dailyTokenViewMode === 'chart'
            ? renderDailyTokenChart(dailyTokenRows)
            : renderDailyTokenList(dailyTokenRows);
          $('#dailyTokenChartButton').setAttribute('aria-pressed', String(dailyTokenViewMode === 'chart'));
          $('#dailyTokenListButton').setAttribute('aria-pressed', String(dailyTokenViewMode === 'list'));
        };
        $('#dailyTokenChartButton').addEventListener('click', () => { dailyTokenViewMode = 'chart'; renderDailyTokens(); });
        $('#dailyTokenListButton').addEventListener('click', () => { dailyTokenViewMode = 'list'; renderDailyTokens(); });
        renderDailyTokens();
      }
    }
    function renderCli() {
      const cli = snapshot.cli;
      const source = cli.source === 'configured' ? '本机用户配置' : cli.source === 'chatgpt' ? 'ChatGPT/Codex 扩展随附' : cli.source === 'PATH' ? 'PATH 自动检测' : '未检测到';
      const verification = cli.verified === true ? '已验证' : cli.verified === false ? '验证失败' : '尚未验证';
      const remote = cli.remoteWarning ? '<div class="notice">' + escapeHtml(cli.remoteWarning) + '</div>' : '';
      $('#cliView').innerHTML = '<section class="section"><h2>Codex App Server / CLI</h2><p class="small-note">默认使用已安装的 ChatGPT/Codex VS Code 扩展随附 CLI；也可配置其他 Codex CLI 启动程序。此处不是 ChatGPT 桌面应用主程序。</p><label>当前路径</label><div class="path">' + escapeHtml(cli.path || '未检测到 Codex CLI') + '</div>'
        + '<div class="metric"><div><div class="muted subtle">来源</div><b>' + source + '</b></div><div><div class="muted subtle">验证</div><b>' + verification + '</b></div><div><div class="muted subtle">版本</div><b>' + escapeHtml(cli.version || '未提供') + '</b></div></div>'
        + (cli.verificationMessage ? '<div class="notice ' + (cli.verified === false ? 'error' : '') + '">' + escapeHtml(cli.verificationMessage) + '</div>' : '')
        + '<div class="setting-buttons"><button data-command="detectCli">重新检测</button><button class="primary" data-command="configureCli">配置路径</button><button data-command="verifyCli">验证</button><button class="danger" data-command="clearCli">清除路径覆盖</button></div></section>'
        + '<section class="section"><h2>运行环境</h2>' + remote + '<div><span class="muted">扩展宿主：</span>' + escapeHtml(cli.hostEnvironment) + '</div><div class="path" style="margin-top:6px"><span class="muted">Codex Home：</span>' + escapeHtml(cli.codexHome || '尚未读取') + '</div>'
        + '<p class="small-note">本扩展通过本机 Codex CLI 启动 App Server，以 stdio JSONL 读取对话。若 VS Code 在 WSL 或远程主机运行，其 Codex Home 可能与本机桌面应用不同。</p></section>';
    }
    function renderState() {
      renderAccountMenu();
      renderAccountList();
      renderNotices();
      renderSessions();
      renderUsage();
      renderCli();
    }
    function renderAccountMenu() {
      const state = snapshot.accounts;
      const button = $('#accountMenu');
      const email = state?.currentEmail || (snapshot.usage?.accountStatus === 'available' ? snapshot.usage.email : '') || '账户';
      const status = state?.busy ? (state.canCancel ? '授权中，可取消' : '处理中')
        : state?.phase === 'reloadRequired' ? '需重载 Codex'
        : state?.phase === 'confirmationRequired' ? 'CLI 已核验，Codex 待确认'
        : state?.phase === 'confirmed' ? '已核对' : '切换 / 管理';
      button.textContent = email + ' · ' + status + ' ▾';
      button.title = email + ' · ' + (state?.message || '保存当前账户、添加账户或切换；切换会重载当前窗口。');
      button.setAttribute('aria-label', '管理 Codex 账户：' + email + '，' + status);
    }
    function renderAccountList() {
      const state = snapshot.accounts;
      const rows = [...(state?.items || [])];
      if (state?.currentEmail && !state.currentId) {
        rows.unshift({ id: '', email: state.currentEmail, quota: state.currentQuota });
      }
      const quotaLabel = (quota, row) => quota?.status === 'available' ? quota.text || '服务未提供额度'
        : quota?.status === 'reauth' || (!quota && row.state === 'reauth') ? '需重新授权'
        : quota?.status === 'loading' || (!quota && state?.refreshingQuotas) ? '额度读取中…'
        : quota?.status === 'error' ? '额度读取失败，点击刷新重试'
        : quota?.status === 'unavailable' ? '服务未提供额度' : '额度尚未读取';
      $('#accountList').innerHTML = rows.length ? rows.map(row => {
        const current = row.id ? row.id === state?.currentId : true;
        const quota = quotaLabel(row.quota, row);
        const title = row.email + ' · ' + quota
          + (row.quota?.checkedAt ? ' · 上次更新：' + formatDate(row.quota.checkedAt) : '')
          + (current ? ' · 当前 CLI 账户' : ' · 切换会重载窗口，请先结束正在执行的任务');
        return '<button type="button" class="account-row' + (current ? ' current' : '') + '"'
          + (current ? ' aria-current="true"' : '')
          + ' data-switch-account="' + escapeHtml(row.id) + '" title="' + escapeHtml(title) + '"'
          + (current || state?.busy ? ' disabled' : '') + '><span class="account-indicator" aria-hidden="true">'
          + (current ? '▶' : '') + '</span><span class="account-row-content"><span class="account-email">'
          + escapeHtml(row.email) + '</span><span class="account-quota">' + escapeHtml(quota) + '</span></span></button>';
      }).join('') : '<div class="small-note">尚未保存账户；点击上方账户入口保存或添加。</div>';
    }
    function questionExcerpt(text, query) {
      const compact = String(text || '').replace(/\\s+/g, ' ').trim();
      if (compact.length <= 180) return compact;
      if (!query) return compact.slice(0, 177) + '…';
      const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (index < 0) return compact.slice(0, 177) + '…';
      const start = Math.max(0, index - 50);
      const end = Math.min(compact.length, Math.max(start + 160, index + query.length + 70));
      return (start ? '…' : '') + compact.slice(start, end) + (end < compact.length ? '…' : '');
    }
    function highlightMatches(text, query) {
      if (!query) return escapeHtml(text);
      const foldedText = text.toLocaleLowerCase();
      const foldedQuery = query.toLocaleLowerCase();
      let offset = 0;
      let result = '';
      let index = foldedText.indexOf(foldedQuery, offset);
      while (index >= 0) {
        result += escapeHtml(text.slice(offset, index)) + '<mark>' + escapeHtml(text.slice(index, index + query.length)) + '</mark>';
        offset = index + query.length;
        index = foldedText.indexOf(foldedQuery, offset);
      }
      return result + escapeHtml(text.slice(offset));
    }
    function questionPickerMarkup(record) {
      const key = escapeHtml(record.key);
      const optionsId = 'question-options-' + key;
      return '<div class="question-picker" data-key="' + key + '"><label>我问过的问题</label>'
        + '<input class="question-search-input" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' + optionsId + '" autocomplete="off" data-key="' + key + '" aria-label="搜索“' + escapeHtml(record.title || '此会话') + '”中的问题" placeholder="点击后搜索此会话的问题">'
        + '<div id="' + optionsId + '" class="question-options" role="listbox" hidden></div>'
        + '<div class="question-picker-state small-note" aria-live="polite">点击后读取问题；选中后使用打开按钮打开整条会话。</div></div>';
    }
    function questionStateFor(key) {
      let state = questionStates.get(key);
      if (!state) {
        state = { status: 'idle', questions: [], query: '', selectedIndex: null, open: false, error: '' };
        questionStates.set(key, state);
      }
      return state;
    }
    function renderQuestionPicker(key) {
      const root = [...document.querySelectorAll('.question-picker')].find(item => item.dataset.key === key);
      if (!root) return;
      const state = questionStateFor(key);
      const input = root.querySelector('.question-search-input');
      const list = root.querySelector('.question-options');
      const hint = root.querySelector('.question-picker-state');
      const selected = state.questions.find(question => question.index === state.selectedIndex);
      if (document.activeElement !== input) input.value = state.open ? state.query : selected ? questionExcerpt(selected.text, '') : '';
      input.setAttribute('aria-expanded', String(state.open));
      list.hidden = !state.open;
      if (!state.open) {
        list.innerHTML = '';
      } else if (state.status === 'loading') {
        list.innerHTML = '<div class="question-options-empty">正在读取此会话的问题…</div>';
      } else if (state.status === 'error') {
        list.innerHTML = '<div class="question-options-empty">' + escapeHtml(state.error || '读取问题失败；再次点击搜索框可重试。') + '</div>';
      } else if (state.status !== 'loaded') {
        list.innerHTML = '<div class="question-options-empty">正在读取此会话的问题…</div>';
      } else {
        const query = state.query.trim();
        const foldedQuery = query.toLocaleLowerCase();
        const matches = state.questions.filter(question => !foldedQuery || question.text.toLocaleLowerCase().includes(foldedQuery));
        if (!matches.length) {
          list.innerHTML = '<div class="question-options-empty">' + (state.questions.length ? '没有匹配的问题。试试更短的关键词。' : '此会话尚无可显示的问题。') + '</div>';
        } else {
          list.innerHTML = matches.map(question => {
            const time = question.startedAt ? formatDate(question.startedAt) : '时间未提供';
            const excerpt = questionExcerpt(question.text, query);
            return '<button type="button" class="question-option" role="option" data-action="selectQuestion" data-key="' + escapeHtml(key) + '" data-question-index="' + question.index + '" aria-selected="' + (question.index === state.selectedIndex) + '" title="' + escapeHtml(question.text) + '">'
              + '<span class="question-option-head"><span>问题 ' + (question.index + 1) + '</span><span>' + escapeHtml(time) + '</span></span>'
              + '<span class="question-option-text">' + highlightMatches(excerpt, query) + '</span></button>';
          }).join('');
        }
      }
      if (selected) {
        hint.textContent = '已选问题 ' + (selected.index + 1) + '；打开按钮会进入整条会话。';
      } else if (state.status === 'loaded') {
        hint.textContent = state.questions.length + ' 个问题；选中后可使用打开按钮进入整条会话。';
      } else if (state.status === 'loading') {
        hint.textContent = '正在读取问题…';
      } else if (state.status === 'error') {
        hint.textContent = '读取问题失败；再次点击搜索框可重试。';
      } else {
        hint.textContent = '点击后读取问题；选中后使用打开按钮打开整条会话。';
      }
    }
    function requestQuestionList(key) {
      const state = questionStateFor(key);
      if (state.status === 'loading' || state.status === 'loaded') return;
      state.status = 'loading';
      state.error = '';
      renderQuestionPicker(key);
      send('loadQuestions', { key });
    }
    function openQuestionPicker(key) {
      if (activeQuestionPickerKey && activeQuestionPickerKey !== key) {
        const previous = questionStateFor(activeQuestionPickerKey);
        previous.open = false;
        renderQuestionPicker(activeQuestionPickerKey);
      }
      activeQuestionPickerKey = key;
      const state = questionStateFor(key);
      if (!state.open) {
        state.query = '';
        const root = [...document.querySelectorAll('.question-picker')].find(item => item.dataset.key === key);
        const input = root && root.querySelector('.question-search-input');
        if (input && document.activeElement === input) input.value = '';
      }
      state.open = true;
      requestQuestionList(key);
      renderQuestionPicker(key);
    }
    function closeQuestionPicker(key) {
      const state = questionStateFor(key);
      state.open = false;
      if (activeQuestionPickerKey === key) activeQuestionPickerKey = '';
      renderQuestionPicker(key);
    }
    function selectQuestion(key, index) {
      const state = questionStateFor(key);
      const question = state.questions.find(item => item.index === index);
      if (!question) return;
      state.selectedIndex = index;
      state.query = '';
      closeQuestionPicker(key);
    }
    function renderTranscriptWindow() {
      const messageRoot = $('#transcriptMessages');
      if (!messageRoot) return;
      const start = Math.max(0, visibleTurnStart);
      const end = Math.min(conversationTurnCount, visibleTurnEnd);
      $('#transcriptRange').textContent = conversationTurnCount ? '第 ' + (start + 1) + '–' + end + ' / ' + conversationTurnCount + ' 轮' : '没有可显示的轮次';
      $('#loadEarlier').disabled = start <= 0;
      $('#loadLater').disabled = end >= conversationTurnCount;
      const messages = conversationMessages.filter(message => message.turnIndex >= start && message.turnIndex < end);
      messageRoot.innerHTML = messages.length
        ? messages.map(message => '<article class="transcript-message ' + message.role + '"><div class="transcript-message-head"><b>' + (message.role === 'user' ? '你 · 问题 ' + (message.questionIndex + 1) : 'Codex') + '</b><span>' + (message.startedAt ? escapeHtml(formatDate(message.startedAt)) : '') + '</span></div><div class="transcript-message-content">' + escapeHtml(message.text) + '</div></article>').join('')
        : '<div class="transcript-empty">此范围内没有可显示的消息。</div>';
    }
    function closeDetails() {
      $('#modalRoot').style.display = 'none';
      if (detailsReturnFocus && detailsReturnFocus.isConnected) detailsReturnFocus.focus();
    }
    function openDetails(payload) {
      const record = payload.record || {};
      const isLocal = record.source === 'local';
      const detail = payload.detail || {};
      const endedAt = record.lastTurnEndedAt || detail.lastTurnEndedAt || detail.lastTurnCompletedAt;
      const endValue = isLocal && record.status === 'active' ? '进行中' : isLocal && endedAt ? formatDate(endedAt) : '未提供';
      let detailHtml = '<div class="modal-head"><h2>' + escapeHtml(record.title || '对话详情') + '</h2><button data-action="closeModal">关闭</button></div>'
        + '<div class="metadata conversation-meta"><div>来源：' + (isLocal ? '本地 Codex' : 'Codex Cloud') + '</div><div>会话 ID：' + escapeHtml(record.id || '') + '</div>'
        + '<div>开始时间：' + formatDate(record.createdAt) + '</div><div>最近更新时间：' + formatDate(record.updatedAt) + '</div><div>最近一轮结束：' + endValue + '</div>'
        + '<div>' + (isLocal ? '工作目录：' : '环境：') + escapeHtml(record.projectLabel || '未知') + '</div><div>状态：' + escapeHtml(showStatus(record.status)) + '</div></div>';
      if (isLocal) {
        const preview = detail.preview || record.preview;
        const transcriptAvailable = Array.isArray(detail.turns);
        conversationMessages = [];
        let transcriptQuestionIndex = 0;
        conversationTurnCount = transcriptAvailable ? detail.turns.length : 0;
        visibleTurnEnd = conversationTurnCount;
        visibleTurnStart = Math.max(0, visibleTurnEnd - 10);
        if (transcriptAvailable) {
          detail.turns.forEach((turn, turnIndex) => {
            (Array.isArray(turn.messages) ? turn.messages : []).forEach(message => {
              if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string') return;
              const entry = { role: message.role, text: message.text, turnIndex, startedAt: turn.startedAt };
              if (message.role === 'user') {
                entry.questionIndex = transcriptQuestionIndex++;
              }
              conversationMessages.push(entry);
            });
          });
        }
        const summary = '<details class="conversation-summary"><summary>查看会话摘要</summary><pre>' + escapeHtml(preview || '服务未提供摘要。') + '</pre></details>';
        const browser = transcriptAvailable
          ? '<section id="transcriptPanel" class="transcript-panel" aria-label="会话内容"><div class="transcript-toolbar"><button type="button" data-action="loadEarlier">更早 10 轮</button><span id="transcriptRange" class="muted subtle" aria-live="polite"></span><button type="button" data-action="loadLater">更新 10 轮</button></div><div id="transcriptMessages" class="transcript-messages"></div></section>'
          : '<div class="empty">App Server 未返回此会话的轮次内容。</div>';
        const openActions = snapshot.cli.platform === 'linux'
          ? '<button class="primary" data-action="openInIde" data-key="' + escapeHtml(record.key || '') + '">在 VS Code Codex 中打开</button>'
          : '<button class="primary" data-action="open" data-key="' + escapeHtml(record.key || '') + '">在 ChatGPT Windows 中打开</button><button data-action="openInIde" data-key="' + escapeHtml(record.key || '') + '">在 VS Code Codex 中打开</button>';
        detailHtml += summary + browser + '<div class="actions conversation-actions">' + openActions + '</div>';
      } else {
        detailHtml += '<h3 style="margin-top:14px">云端摘要</h3><pre>' + escapeHtml(record.preview || '服务未提供摘要。') + '</pre><p class="small-note">CLI 云端列表未提供受支持的完整会话详情接口，本页仅展示列表返回的字段。</p>';
      }
      $('#modalRoot').innerHTML = '<div class="modal' + (isLocal ? ' conversation-modal' : '') + '" role="dialog" aria-modal="true" aria-label="' + escapeHtml(record.title || '对话详情') + '">' + detailHtml + '</div>';
      $('#modalRoot').style.display = 'flex';
      if (isLocal && Array.isArray(detail.turns)) {
        renderTranscriptWindow();
      }
    }
    document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
    $('#refresh').addEventListener('click', () => send('refresh'));
    $('#accountMenu').addEventListener('click', () => send('accounts'));
    $('#accountList').addEventListener('click', event => {
      const row = event.target.closest('button[data-switch-account]');
      if (row && !row.disabled && row.dataset.switchAccount) send('switchAccount', { id: row.dataset.switchAccount });
    });
    $('#search').addEventListener('input', event => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = setTimeout(() => send('search', { value }), 300);
    });
    $('#source').addEventListener('change', event => send('source', { value: event.target.value }));
    $('#projectSearch').addEventListener('focus', () => updateProjectOptions(true));
    $('#projectSearch').addEventListener('input', () => updateProjectOptions(true));
    $('#projectSearch').addEventListener('keydown', event => {
      if (event.key === 'Escape') updateProjectOptions(false);
      else if (event.key === 'ArrowDown' && projectOptionsOpen) {
        const first = $('#projectOptions').querySelector('button[role="option"]');
        if (first) { event.preventDefault(); first.focus(); }
      }
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.project-picker')) updateProjectOptions(false);
      if (!event.target.closest('.question-picker') && activeQuestionPickerKey) closeQuestionPicker(activeQuestionPickerKey);
    });
    $('#sort').addEventListener('change', event => send('sort', { key: event.target.value, direction: $('#direction').value }));
    $('#direction').addEventListener('change', event => send('sort', { key: $('#sort').value, direction: event.target.value }));
    $('#previous').addEventListener('click', () => send('previousPage'));
    $('#next').addEventListener('click', () => send('nextPage'));
    document.body.addEventListener('focusin', event => {
      const input = event.target.closest('.question-search-input');
      if (input) openQuestionPicker(input.dataset.key);
    });
    document.body.addEventListener('click', event => {
      const input = event.target.closest('.question-search-input');
      if (input) openQuestionPicker(input.dataset.key);
    });
    document.body.addEventListener('input', event => {
      const input = event.target.closest('.question-search-input');
      if (!input) return;
      const state = questionStateFor(input.dataset.key);
      state.query = input.value;
      state.open = true;
      activeQuestionPickerKey = input.dataset.key;
      requestQuestionList(input.dataset.key);
      renderQuestionPicker(input.dataset.key);
    });
    document.body.addEventListener('keydown', event => {
      if (event.target.matches('.question-search-input')) {
        const key = event.target.dataset.key;
        if (event.key === 'ArrowDown') {
          const first = event.target.closest('.question-picker').querySelector('.question-option');
          if (first) { event.preventDefault(); first.focus(); }
        } else if (event.key === 'Enter') {
          const first = event.target.closest('.question-picker').querySelector('.question-option');
          if (first) { event.preventDefault(); first.click(); }
        } else if (event.key === 'Escape') {
          if (questionStateFor(key).open) { closeQuestionPicker(key); event.preventDefault(); }
        }
      } else if (event.target.matches('.question-option')) {
        const items = [...event.target.closest('.question-options').querySelectorAll('.question-option')];
        const current = items.indexOf(event.target);
        const next = event.key === 'ArrowDown' ? current + 1 : event.key === 'ArrowUp' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
        if (next >= 0 && next < items.length) { event.preventDefault(); items[next].focus(); }
        else if (event.key === 'Escape') {
          const root = event.target.closest('.question-picker');
          closeQuestionPicker(root.dataset.key);
          root.querySelector('.question-search-input').focus();
        }
      } else if (event.key === 'Escape' && $('#modalRoot').style.display === 'flex') {
        closeDetails();
      }
    });
    $('#modalRoot').addEventListener('click', event => {
      if (event.target === $('#modalRoot')) closeDetails();
    });
    document.body.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.project !== undefined) {
        const value = button.dataset.project;
        $('#projectSearch').value = value;
        updateProjectOptions(false);
        $('#projectSearch').focus();
        send('project', { value });
        return;
      }
      if (button.dataset.command) { send('command', { command: button.dataset.command }); return; }
      if (button.dataset.action === 'closeModal') { closeDetails(); return; }
      if (button.dataset.action === 'selectQuestion') { selectQuestion(button.dataset.key, Number(button.dataset.questionIndex)); return; }
      if (button.dataset.action === 'loadEarlier') {
        visibleTurnEnd = visibleTurnStart;
        visibleTurnStart = Math.max(0, visibleTurnEnd - 10);
        renderTranscriptWindow();
        $('#transcriptPanel').scrollTop = 0;
        return;
      }
      if (button.dataset.action === 'loadLater') {
        visibleTurnStart = visibleTurnEnd;
        visibleTurnEnd = Math.min(conversationTurnCount, visibleTurnStart + 10);
        renderTranscriptWindow();
        $('#transcriptPanel').scrollTop = 0;
        return;
      }
      if (button.dataset.action && button.dataset.key) {
        if (button.dataset.action === 'rename') {
          const record = snapshot.records.find(item => item.key === button.dataset.key);
          const name = prompt('输入新的对话名称：', record ? record.title : '');
          if (name === null) return;
          send('rename', { key: button.dataset.key, value: name });
          return;
        }
        if (button.dataset.action === 'details') detailsReturnFocus = button;
        send(button.dataset.action, { key: button.dataset.key });
      }
    });
    window.addEventListener('message', event => {
      const message = event.data || {};
      if (message.type === 'state') {
        snapshot = message.snapshot;
        renderState();
      } else if (message.type === 'questions') {
        const key = typeof message.key === 'string' ? message.key : '';
        const state = questionStateFor(key);
        state.questions = Array.isArray(message.questions) ? message.questions : [];
        state.status = 'loaded';
        state.error = '';
        renderQuestionPicker(key);
      } else if (message.type === 'questionsError') {
        const key = typeof message.key === 'string' ? message.key : '';
        const state = questionStateFor(key);
        state.status = 'error';
        state.error = typeof message.text === 'string' ? message.text : '读取问题失败；再次点击搜索框可重试。';
        renderQuestionPicker(key);
      } else if (message.type === 'details') {
        openDetails(message.payload || {});
      } else if (message.type === 'message') {
        const root = $('#notices');
        root.innerHTML = '<div class="notice ' + (message.error ? 'error' : 'success') + '">' + escapeHtml(message.text || '') + '</div>' + root.innerHTML;
      } else if (message.type === 'selectTab') {
        if (['sessions','usage','cli'].includes(message.tab)) setTab(message.tab);
      }
    });
    setInterval(() => {
      document.querySelectorAll('[data-reset-countdown]').forEach(element => {
        const raw = element.dataset.resetCountdown;
        element.textContent = raw ? resetCountdown(Number(raw)) : '服务未提供';
      });
    }, 60_000);
    send('ready');
  </script>
</body>
</html>`;
}
