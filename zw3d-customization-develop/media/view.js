/* global acquireVsCodeApi */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const createPage = document.body.dataset.page === 'create';
  const send = (action, data = {}) => vscode.postMessage({ action, ...data });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  if (!createPage) {
    let selectedAction;
    let runSession;
    let hostRunning = false;
    let pageBusy = false;
    const buildProfiles = ['Release', 'Debug'];
    let selectedBuildProfile;
    let profileRoot;
    let dashboardState;
    let switchBlockedUntil = 0;
    let switchHintTimer;
    let commandQuery = '';
    const clearSwitchNotice = () => {
      clearTimeout(switchHintTimer);
      switchHintTimer = undefined;
      switchBlockedUntil = 0;
    };
    const highlight = action => {
      for (const button of app.querySelectorAll('button[data-action]')) {
        const selected = button.dataset.action === action;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      }
    };
    const icons = {
      configure: '<path d="M4 7h7m4 0h5M4 17h2m4 0h10"/><circle cx="13" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
      reset: '<path d="M5 9a7 7 0 1 1 0 6M5 4v5h5"/>',
      detect: '<circle cx="10" cy="10" r="6"/><path d="m14.5 14.5 5.5 5.5M7 10l2 2 4-4"/>',
      clangd: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
      cmakeArgs: '<path d="M4 7h7m4 0h5M4 17h2m4 0h10"/><circle cx="13" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
      create: '<path d="M12 5v14M5 12h14"/>',
      build: '<path d="m14 6 4-3a6 6 0 0 1-7 8l-7 7a2 2 0 0 0 3 3l7-7a6 6 0 0 0 7-8l-4 4z"/>',
      rebuild: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
      run: '<path d="m8 5 11 7-11 7z"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
      restart: '<path d="M5 9a7 7 0 1 1 0 6M5 4v5h5"/>',
      debug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 3h6M12 3v4M3 10h4m10 0h4M3 15h4m10 0h4M5 21l3-3m8 0 3 3M12 11v6"/>'
    };
    const button = (action, title, description, disabled, icon = action) =>
      `<button class="action" data-action="${action}" ${disabled ? 'disabled' : ''}><svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[icon] || ''}</svg><span class="action-content"><strong>${title}</strong><small>${description}</small></span></button>`;
    const pluginRow = (entry, root, withIcon, busy) => {
      const ui = entry.ui;
      const icon = withIcon ? '<svg class="plugin-entry-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"/></svg>' : '';
      const identity = `${entry.library || '动态库未识别'}:${entry.command || '命令未识别'}`;
      return `<div class="plugin-entry">${icon}<code class="plugin-entry-command" title="${escape(identity)}">${escape(identity)}</code>${ui
        ? `<button type="button" class="ui-file-link" data-ui-file="${escape(ui.file)}" data-ui-root="${escape(root)}" title="用 Qt Designer 打开 ${escape(ui.relative || ui.file)}" ${busy ? 'disabled' : ''}>${escape(ui.file.split('/').pop())}</button>`
        : '<span class="plugin-entry-empty muted">未关联 UI</span>'}</div>`;
    };
    const projectRows = state => {
      const entries = state.projectCommands?.entries || [];
      const query = commandQuery.trim().toLocaleLowerCase();
      const ranked = entries.map((entry, index) => {
        const text = `${entry.library || ''} ${entry.command || ''} ${entry.ui?.relative || ''}`.toLocaleLowerCase();
        let score = 0;
        for (const token of query.split(/\s+/).filter(Boolean)) {
          const exact = text.indexOf(token);
          if (exact >= 0) { score += exact; continue; }
          let position = -1;
          for (const letter of token) {
            position = text.indexOf(letter, position + 1);
            if (position < 0) return undefined;
          }
          score += 1000 + position;
        }
        return { entry, index, score };
      }).filter(Boolean).sort((a, b) => a.score - b.score || a.index - b.index);
      return {
        html: ranked.length ? ranked.slice(0, 3).map(({ entry }) => pluginRow(entry, state.projectCommands?.root, true, state.busy)).join('')
          : `<span class="muted">${query ? '未找到匹配的命令' : '未识别到 ! / ~ 命令'}</span>`,
        count: entries.length > 3 ? `${query ? '匹配' : '共'} ${ranked.length} 条${ranked.length > 3 ? '，显示前 3 条，请搜索定位' : ''}` : ''
      };
    };
    const runDuration = session => {
      if (!session?.startedAt) return '00:00:00';
      const seconds = Math.max(0, Math.floor(((session.endedAt ?? Date.now()) - session.startedAt) / 1000));
      const pad = value => String(value).padStart(2, '0');
      return pad(Math.floor(seconds / 3600)) + ':' + pad(Math.floor(seconds / 60) % 60) + ':' + pad(seconds % 60);
    };
    const runDescription = '增量编译 · 部署并启动 ZW3D';
    const runControl = (profile, disabled) => {
      const session = runSession?.profile === profile ? runSession : undefined;
      const live = Boolean(session?.pid && !session.endedAt);
      const blockedByOther = hostRunning && !live;
      const pending = ['preparing', 'building', 'starting'].includes(session?.state);
      const locked = session?.controlling || session?.state === 'stopping';
      const labels = { preparing:'准备中', building:'编译中', starting:'启动中', running:'已启动', paused:'已暂停', stopping:'关闭中', exited:'未运行', failed: live ? '操作失败' : '未运行' };
      const canStart = !disabled && !locked && !pending && !live && !blockedByOther;
      const canStop = live && !locked && !pageBusy;
      const canRestart = live && !locked && !pageBusy && !blockedByOther;
      const tool = (verb, title, enabled) => `<button class="icon-button" data-action="${verb}${profile}" ${verb !== 'run' && session ? `data-run-id="${escape(session.id)}"` : ''} title="${title}" aria-label="${title}" ${enabled ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[verb]}</svg></button>`;
      return `<div class="action run-control" data-run-profile="${profile}" data-run-state="${session?.state || 'idle'}" role="group" aria-label="${profile} ZW3D 进程控制" title="${escape(session?.detail || '')}"><div class="run-control-top"><strong class="run-state">${labels[session?.state] || '未运行'}</strong><span class="run-control-tools">${live ? tool('stop', '停止并关闭 ZW3D', canStop) : tool('run', '增量编译并启动 ZW3D', canStart)}${tool('restart', '关闭 ZW3D 后重新编译运行', canRestart)}</span></div><div class="run-process-info"><span>PID <span class="run-pid">${escape(session?.pid || '--')}</span></span><span class="run-time" title="运行时长（小时:分钟:秒）"><span class="muted">时长</span> <span data-run-elapsed="${profile}">${runDuration(session)}</span></span></div><small class="run-description">${runDescription}</small></div>`;
    };
    setInterval(() => {
      for (const element of app.querySelectorAll('[data-run-elapsed]')) {
        element.textContent = runDuration(runSession?.profile === element.dataset.runElapsed ? runSession : undefined);
      }
    }, 1000);
    const buildSection = (state, disabled) => {
      const profile = selectedBuildProfile;
      const directory = state.buildDirectories?.[profile] || `build_${profile.toLowerCase()}`;
      const cmakeArgument = state.project?.cmakeArgsByProfile?.[profile];
      const cmakeAction = `configureCmake${profile}`;
      const cmakeLabel = `设置 ${profile} CMake 参数${cmakeArgument ? `：${cmakeArgument}` : ''}`;
      const orderedProfiles = [profile, ...buildProfiles.filter(value => value !== profile)];
      const tabs = orderedProfiles.map(value => {
        const running = runSession?.profile === value && runSession.pid && !runSession.endedAt;
        return `<span class="build-profile" role="tab" id="build-tab-${value}" data-build-profile="${value}" aria-controls="build-panel-${value}" aria-selected="${value === profile}" tabindex="${value === profile ? '0' : '-1'}" title="${value}${running ? ' · ZW3D 已启动' : ''}">${value}</span>`;
      }).join('<span class="build-profile-separator" aria-hidden="true">/</span>');
      const runningProfile = runSession?.pid && !runSession.endedAt ? runSession.profile : state.hostProfile;
      const runningStatus = runningProfile ? `ZW3D 已通过 ${runningProfile} 启动` : 'ZW3D 已启动';
      const runningHint = !hostRunning ? '' : switchBlockedUntil > Date.now()
        ? `${runningStatus}，无法切换构建类型，请先关闭 ZW3D。` : `${runningStatus}。`;
      const panels = buildProfiles.map(value => `<div class="build-panel" id="build-panel-${value}" role="tabpanel" aria-labelledby="build-tab-${value}" ${value === profile ? '' : 'hidden'}><div class="split build-actions">${button(`build${value}`, '编译', '增量构建', disabled, 'build')}${button(`rebuild${value}`, '重新生成', '清理后完整编译', disabled, 'rebuild')}${runControl(value, disabled)}</div></div>`).join('');
      return `<section aria-labelledby="build-heading"><div class="section-heading build-heading"><div class="build-title"><h2 class="section-label" id="build-heading">构建</h2><span class="build-profiles" role="tablist" aria-label="构建类型">${tabs}</span></div><span class="build-directory" title="相对项目根目录：${escape(directory)}">${escape(directory)}</span>${iconButton(cmakeAction, escape(cmakeLabel), disabled)}</div>
        <div class="section-card">${runningHint ? `<p class="build-running-hint" role="status">${escape(runningHint)}</p>` : ''}${panels}</div>
      </section>`;
    };
    const iconButton = (action, label, disabled = false) =>
      `<button class="icon-button" data-action="${action}" title="${label}" aria-label="${label}" ${disabled ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[action] || icons.cmakeArgs}</svg></button>`;
    const render = state => {
      const searchSelection = document.activeElement?.id === 'project-command-search'
        ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : undefined;
      const p = state.project;
      const context = state.fileContext;
      const related = context?.candidates?.[0];
      const rows = projectRows(state);
      const projectCommands = `<div class="project-commands" aria-label="本项目可能提供的命令"><span class="muted">可能提供的命令</span>${state.projectCommands?.entries?.length > 3
        ? `<input type="search" id="project-command-search" class="command-search" aria-label="模糊搜索库名、命令或 UI" placeholder="搜索库名、命令或 UI…" value="${escape(commandQuery)}">` : ''}<div class="project-command-list" id="project-command-list">${rows.html}</div><small class="muted" id="project-command-count" role="status">${rows.count}</small>${state.projectCommands?.truncated ? '<small class="muted">扫描范围受限，可能还有其他命令。</small>' : ''}</div>`;
      const disabled = state.busy || !p;
      const issues = state.environmentIssues || [];
      const statusRows = issues.map(issue => `<div class="status environment-status" role="status"><span class="dot ${issue.severity === 'error' ? 'error' : 'warning'}"></span><span class="status-text" title="${escape(issue.message)}">${escape(issue.message)}</span><button class="tool-button status-action" data-action="${issue.action === 'addLibraryPath' ? 'addLibraryPath' : 'environmentConfigure'}" ${state.busy ? 'disabled' : ''}>${issue.action === 'addLibraryPath' ? '添加到环境变量' : '编辑项目配置'}</button></div>`).join('');
      app.innerHTML = `<header class="workbench-header"><div class="brand"><span class="badge" aria-hidden="true">ZW</span><div><h1>ZW3D</h1><p class="brand-subtitle muted">二次开发工作台</p></div></div>
        ${state.status !== '准备就绪' || !issues.length ? `<div class="status" role="status"><span class="dot ${state.busy || !Array.isArray(state.environmentIssues) ? 'working' : issues.some(issue => issue.severity === 'error') ? 'error' : issues.length ? 'warning' : ''}"></span><span>${escape(state.status)}</span></div>` : ''}${statusRows}</header>
        <section aria-labelledby="project-heading"><div class="section-heading"><h2 class="section-label" id="project-heading">当前项目</h2><div class="section-tools" role="group" aria-label="项目操作">${state.multiple ? '<button class="text-button" data-action="select">切换项目</button>' : ''}${iconButton('configure', '编辑项目配置', disabled)}${iconButton('reset', '重新配置项目：重建 .zw3d，可选择重载当前窗口', disabled)}${iconButton('detect', '检测项目与开发环境', state.busy)}</div></div>
          ${p ? `<div class="project"><div class="project-header"><div class="project-title"><strong>${escape(p.name)}</strong></div></div>${projectCommands}</div>` :
            `<div class="empty"><strong>${state.configError ? '项目配置需要修复' : state.detectionError ? '项目自动初始化未完成' : '尚未识别到 ZW3D 项目'}</strong><p>${escape(state.configError || state.detectionError || '中望 CMake 工程会自动识别并生成 .zw3d/project.json。也可点击“检测项目”重新检测，或手动接入现有工程。')}</p>${state.configError ? '<button data-action="configure">编辑配置</button>' : `<button data-action="import" ${state.busy ? 'disabled' : ''}>接入现有项目</button>`}${projectCommands}</div>`}
        </section>
        <section class="file-context" aria-labelledby="file-heading">
          <div class="section-heading file-context-heading"><h2 class="section-label" id="file-heading">${context?.isDirectory ? '当前文件夹' : '当前文件'}</h2></div>
          <div class="file-context-card">
          <p class="path file-context-path" title="${escape(context?.file)}">${escape(context?.file || '打开工程文件，或在资源管理器右键选择文件夹。')}</p>
          ${related?.warnings?.length ? `<p class="association-warning">${escape(related.warnings.join('；'))}</p>` : ''}
          <div class="plugin-hints" aria-labelledby="plugin-hints-heading"><h3 class="context-label" id="plugin-hints-heading">可能提供插件</h3><div class="plugin-hint-values">${context?.entries?.length ? context.entries.map(entry => pluginRow(entry, context.root, false, state.busy)).join('') : '<span class="muted">未识别到动态库或命令</span>'}</div></div>
          ${context?.truncated ? '<p class="hint">工程资源较多，仅显示扫描范围内的候选；可右键选择更具体的文件夹。</p>' : ''}</div>
        </section>
        ${buildSection(state, disabled)}
        <section aria-labelledby="navigation-heading"><div class="section-heading"><h2 class="section-label" id="navigation-heading">代码跳转</h2><span class="build-directory" title="相对项目根目录">${escape(state.clangdBuildDirectory || 'build_clangd')}</span></div>
          <div class="section-card navigation-card"><div class="compile-options-row"><label class="compile-option"><input type="checkbox" id="auto-compile-commands" ${state.autoRefreshCompileCommands ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-describedby="compile-option-hint"><span>新增源码文件时自动更新编译数据库</span></label>${iconButton('clangd', '配置 clangd 与编译数据库', disabled)}</div>
          <p class="hint compile-option-hint" id="compile-option-hint">仅在新增源码文件参与插件构建时更新 compile_commands.json。</p></div>
        </section>
        ${state.busy ? '<button class="cancel" data-action="cancel">取消当前操作</button>' : ''}

        `;
      highlight(selectedAction);
      if (searchSelection) {
        const search = app.querySelector('#project-command-search');
        if (search) { search.focus(); search.setSelectionRange(...searchSelection); }
      }
    };
    window.addEventListener('message', event => {
      const state = event.data;
      if (state.type !== 'state') return;
      dashboardState = state;
      const root = state.project?.root || '';
      if (root !== profileRoot || (state.projectCommands?.entries?.length || 0) <= 3) commandQuery = '';
      if (root !== profileRoot || state.runSession?.id !== runSession?.id || !state.hostRunning) clearSwitchNotice();
      if (!selectedBuildProfile || root !== profileRoot) {
        const saved = vscode.getState() || {};
        selectedBuildProfile = saved.profileRoot === root && buildProfiles.includes(saved.buildProfile) ? saved.buildProfile
          : state.runSession?.profile || state.project?.buildProfile || 'Debug';
        if (!buildProfiles.includes(selectedBuildProfile)) selectedBuildProfile = 'Debug';
        profileRoot = root;
      }
      const actionProfile = state.selectedAction !== selectedAction && /^(?:build|rebuild|run|stop|restart|configureCmake)(Release|Debug)$/.exec(state.selectedAction || '');
      const liveProfile = state.hostRunning && state.runSession?.pid && !state.runSession.endedAt && state.runSession.profile;
      if (buildProfiles.includes(liveProfile) || (actionProfile && !state.hostRunning)) {
        selectedBuildProfile = liveProfile || actionProfile[1];
        vscode.setState({ ...vscode.getState(), profileRoot, buildProfile: selectedBuildProfile });
      }
      selectedAction = state.selectedAction ?? selectedAction;
      runSession = state.runSession;
      hostRunning = Boolean(state.hostRunning);
      pageBusy = Boolean(state.busy);
      render(state);
    });
    const switchBuildProfile = profile => {
      if (!dashboardState || !buildProfiles.includes(profile)) return;
      if (hostRunning && profile !== selectedBuildProfile) {
        clearSwitchNotice();
        switchBlockedUntil = Date.now() + 10000;
        switchHintTimer = setTimeout(() => {
          clearSwitchNotice();
          if (dashboardState) render(dashboardState);
        }, 10000);
        render(dashboardState);
        app.querySelector(`#build-tab-${selectedBuildProfile}`)?.focus();
        return;
      }
      selectedBuildProfile = profile;
      vscode.setState({ ...vscode.getState(), profileRoot, buildProfile: profile });
      render(dashboardState);
      app.querySelector(`#build-tab-${profile}`)?.focus();
    };
    app.addEventListener('click', event => {
      const uiLink = event.target.closest('button[data-ui-file]');
      if (uiLink) {
        if (!uiLink.disabled) send('openUiDesigner', { file: uiLink.dataset.uiFile, root: uiLink.dataset.uiRoot });
        return;
      }
      const tab = event.target.closest('[data-build-profile]');
      if (tab) { switchBuildProfile(tab.dataset.buildProfile); return; }
      const button = event.target.closest('button[data-action]');
      if (button && !button.disabled) {
        selectedAction = button.dataset.action;
        highlight(selectedAction);
        send(selectedAction, button.dataset.runId ? { runId: button.dataset.runId } : {});
      }
    });
    app.addEventListener('keydown', event => {
      const tab = event.target.closest('[data-build-profile]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      const other = selectedBuildProfile === 'Release' ? 'Debug' : 'Release';
      const profile = ['Enter', ' '].includes(event.key) ? tab.dataset.buildProfile
        : event.key === 'Home' ? selectedBuildProfile : event.key === 'End' ? other
          : tab.dataset.buildProfile === 'Release' ? 'Debug' : 'Release';
      switchBuildProfile(profile);
    });
    app.addEventListener('change', event => {
      if (event.target.id === 'auto-compile-commands') send('autoCompileCommands', { enabled: event.target.checked });
    });
    app.addEventListener('input', event => {
      if (event.target.id !== 'project-command-search' || !dashboardState) return;
      commandQuery = event.target.value;
      const rows = projectRows(dashboardState);
      app.querySelector('#project-command-list').innerHTML = rows.html;
      app.querySelector('#project-command-count').textContent = rows.count;
    });
  } else {
    const fields = [
      ['parent', '存放文件夹', '/path/to/projects', true, '选择一个已有文件夹，确认后才创建项目子目录。'],
      ['projectName', '项目名称', 'HelloZW3D', false, '以英文字母开头，支持字母、数字和下划线。'],
      ['libraryName', '动态库名称', '默认与项目名称一致', false, '生成 Name.so，并导出 NameInit / NameExit。'],
      ['cmakePath', 'CMake', '自动检测 CMake 可执行文件', true, ''],
      ['cxxPath', 'g++', '自动检测 C++ 编译器', true, ''],
      ['zw3dRoot', 'ZW3D 安装位置', '安装根目录或 files 目录', true, '需要包含 api/inc、libZW3D.so 和 zw3d。'],
      ['gdbPath', 'GDB', '可选；调试时需要', true, ''],
      ['remote', 'Git 远程仓库', '可选，例如 git@server:team/project.git', false, '填写后会创建首次提交并推送 main；留空只初始化本地仓库。']
    ];
    const saved = vscode.getState() || {};
    app.innerHTML = `<div class="form-container"><div class="eyebrow">ZW3D / NEW PROJECT</div><h1>初始化二次开发项目</h1>
      <p class="intro">从可编辑的 apiDemo 模板开始，创建一个能编译、加载和调试的 C++ 插件。</p>
      <form id="create-form"><fieldset id="fields"><legend class="sr-only">项目信息和工具链</legend>
      ${fields.map(([id, label, placeholder, browse, hint], index) => `${index === 3 ? '<div class="form-heading"><h2>开发环境</h2><button type="button" id="detect" class="text-button">重新检测</button></div>' : ''}${index === 7 ? '<h2>版本管理</h2>' : ''}
        <div class="form-field"><label for="${id}">${label}${id === 'gdbPath' || id === 'remote' ? ' <span class="muted">（可选）</span>' : ''}</label><div class="input-row"><input id="${id}" name="${id}" type="text" value="${escape(saved[id] || '')}" placeholder="${escape(placeholder)}" ${id !== 'gdbPath' && id !== 'remote' ? 'required' : ''} ${id === 'projectName' || id === 'libraryName' ? 'pattern="[A-Za-z][A-Za-z0-9_]*"' : ''} ${['cmakePath', 'cxxPath', 'zw3dRoot', 'gdbPath'].includes(id) ? `aria-describedby="version-${id}"` : ''} autocomplete="off" spellcheck="false">${browse ? `<button type="button" class="secondary browse" data-field="${id}" aria-label="选择${label}">浏览…</button>` : ''}</div>${['cmakePath', 'cxxPath', 'zw3dRoot', 'gdbPath'].includes(id) ? `<small class="version-info" id="version-${id}" role="status">版本：等待检测</small>` : ''}${hint ? `<small class="muted">${hint}</small>` : ''}</div>`).join('')}
      <div class="preview"><span class="section-label">将创建于</span><code id="destination">请选择文件夹并填写名称</code></div>
      <div class="structure"><code>src/main.cpp · CMakeLists.txt · .clangd · cmake/ · resources/ · tests/ · .zw3d/</code></div>
      <p class="hint">默认 Debug 构建，生成简单的问候命令和 clangd 配置。首次编译后生成 compile_commands.json。可以在左侧“编辑模板”中调整 CMake、目录和文件内容。</p>
      <div class="form-actions"><button type="submit" id="submit">确认并创建项目</button><span id="progress" role="status"></span></div>
      </fieldset></form><div id="result" role="status"></div></div>`;
    const form = document.getElementById('create-form');
    let libraryEdited = Boolean(saved.libraryName);
    let creating = false;
    let initialized = false;
    let versionTimer;
    let versionSignature = '';
    let versionRequest = 0;
    const toolKeys = ['cmakePath', 'cxxPath', 'gdbPath', 'zw3dRoot'];
    function queryVersions(force = false) {
      const tools = Object.fromEntries(toolKeys.map(key => [key, document.getElementById(key).value.trim()]));
      const signature = JSON.stringify(tools);
      if (!force && signature === versionSignature) return;
      versionSignature = signature;
      clearTimeout(versionTimer);
      const requestId = ++versionRequest;
      for (const key of toolKeys) document.getElementById(`version-${key}`).textContent = '版本：正在检测…';
      versionTimer = setTimeout(() => send('versions', { requestId, values: tools }), 350);
    }
    const values = () => Object.fromEntries(fields.map(([id]) => [id, document.getElementById(id).value.trim()]));
    function changed() {
      const data = values();
      vscode.setState(data);
      document.getElementById('destination').textContent = data.parent && data.projectName ? `${data.parent.replace(/\/$/, '')}/${data.projectName}` : '请选择文件夹并填写名称';
      queryVersions();
    }
    form.addEventListener('input', event => {
      if (event.target.id === 'libraryName') libraryEdited = Boolean(event.target.value);
      if (event.target.id === 'projectName' && !libraryEdited) document.getElementById('libraryName').value = event.target.value;
      changed();
    });
    form.addEventListener('click', event => {
      const browse = event.target.closest('[data-field]');
      if (browse) send('browse', { field: browse.dataset.field });
    });
    document.getElementById('detect').addEventListener('click', () => {
      document.getElementById('progress').textContent = '正在检测…';
      send('detect');
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (creating || !form.reportValidity()) return;
      creating = true;
      document.getElementById('fields').disabled = true;
      document.getElementById('result').textContent = '';
      document.getElementById('progress').textContent = '正在生成项目和初始化 Git…';
      send('create', { values: values() });
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'defaults') {
        for (const [id, value] of Object.entries(message.values)) {
          const input = document.getElementById(id);
          if (input && (!input.value || initialized) && value) input.value = value;
        }
        initialized = true;
        document.getElementById('progress').textContent = '';
        changed();
        queryVersions(true);
      } else if (message.type === 'field') {
        const input = document.getElementById(message.field);
        if (input) { input.value = message.value; changed(); }
      } else if (message.type === 'versions') {
        if (message.requestId !== versionRequest) return;
        for (const key of toolKeys) document.getElementById(`version-${key}`).textContent = `版本：${message.versions[key]}`;
      } else if (message.type === 'error') {
        creating = false;
        document.getElementById('fields').disabled = false;
        document.getElementById('progress').textContent = '';
        const result = document.getElementById('result');
        result.className = 'error'; result.textContent = message.message;
      } else if (message.type === 'created') {
        document.getElementById('progress').textContent = '创建完成';
        const result = document.getElementById('result');
        result.className = 'success';
        result.innerHTML = `<strong>项目已创建</strong><p class="path">${escape(message.root)}</p>${message.warning ? `<p class="warning">Git 尚未全部完成：${escape(message.warning)}</p>` : ''}<button id="open-project">在新窗口打开项目</button>`;
        document.getElementById('open-project').addEventListener('click', () => send('open'));
        vscode.setState({});
      }
    });
    changed();
  }
  send('ready');
})();
