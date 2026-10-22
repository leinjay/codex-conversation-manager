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
      debug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 3h6M12 3v4M3 10h4m10 0h4M3 15h4m10 0h4M5 21l3-3m8 0 3 3M12 11v6"/>'
    };
    const button = (action, title, description, disabled, icon = action) =>
      `<button class="action" data-action="${action}" ${disabled ? 'disabled' : ''}><svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[icon] || ''}</svg><span class="action-content"><strong>${title}</strong><small>${description}</small></span></button>`;
    const buildSection = (profile, directory, cmakeArgument, disabled) => {
      const heading = `${profile.toLowerCase()}-heading`;
      const cmakeAction = `configureCmake${profile}`;
      const cmakeLabel = `设置 ${profile} CMake 参数${cmakeArgument ? `：${cmakeArgument}` : ''}`;
      return `<section aria-labelledby="${heading}"><div class="section-heading build-heading"><h2 class="section-label" id="${heading}">${profile} 构建</h2><span class="build-directory" title="相对项目根目录：${escape(directory)}">${escape(directory)}</span>${iconButton(cmakeAction, escape(cmakeLabel), disabled)}</div>
        <div class="section-card"><div class="split build-actions">${button(`build${profile}`, '编译', '增量构建', disabled, 'build')}${button(`run${profile}`, '编译并运行', '增量编译 · 部署并启动 ZW3D', disabled, 'run')}${button(`rebuild${profile}`, '重新生成', '清理后完整编译', disabled, 'rebuild')}</div></div>
      </section>`;
    };
    const iconButton = (action, label, disabled = false) =>
      `<button class="icon-button" data-action="${action}" title="${label}" aria-label="${label}" ${disabled ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[action] || icons.cmakeArgs}</svg></button>`;
    window.addEventListener('message', event => {
      const state = event.data;
      if (state.type !== 'state') return;
      selectedAction = state.selectedAction ?? selectedAction;
      const p = state.project;
      const context = state.fileContext;
      const related = context?.candidates?.[0];
      const libraryHints = related?.libraries?.length ? related.libraries : context?.libraries || [];
      const commandHints = related?.commands?.length ? related.commands : context?.commands || [];
      const projectCommands = `<div class="project-commands" aria-label="本项目可能提供的命令"><span class="muted">可能提供的命令</span><div class="project-command-list">${state.projectCommands?.commands?.length
        ? state.projectCommands.commands.map(command => `<code>${escape(command)}</code>`).join('')
        : '<span class="muted">未识别到 ! / ~ 命令</span>'}</div>${state.projectCommands?.truncated ? '<small class="muted">扫描范围受限，可能还有其他命令。</small>' : ''}</div>`;
      const disabled = state.busy || !p;
      app.innerHTML = `<header class="workbench-header"><div class="brand"><span class="badge" aria-hidden="true">ZW</span><div><h1>ZW3D</h1><p class="brand-subtitle muted">二次开发工作台</p></div></div>
        <div class="status" role="status"><span class="dot ${state.busy ? 'working' : ''}"></span><span>${escape(state.status)}</span></div></header>
        <section aria-labelledby="project-heading"><div class="section-heading"><h2 class="section-label" id="project-heading">当前项目</h2><div class="section-tools" role="group" aria-label="项目操作">${state.multiple ? '<button class="text-button" data-action="select">切换项目</button>' : ''}${iconButton('configure', '编辑项目配置', disabled)}${iconButton('reset', '重新配置项目：重建 .zw3d，可选择重载当前窗口', disabled)}${iconButton('detect', '检测项目与开发环境', state.busy)}</div></div>
          ${p ? `<div class="project"><div class="project-header"><div class="project-title"><strong>${escape(p.name)}</strong></div></div>${projectCommands}</div>` :
            `<div class="empty"><strong>${state.configError ? '项目配置需要修复' : state.detectionError ? '项目自动初始化未完成' : '尚未识别到 ZW3D 项目'}</strong><p>${escape(state.configError || state.detectionError || '中望 CMake 工程会自动识别并生成 .zw3d/project.json。也可点击“检测项目”重新检测，或手动接入现有工程。')}</p>${state.configError ? '<button data-action="configure">编辑配置</button>' : `<button data-action="import" ${state.busy ? 'disabled' : ''}>接入现有项目</button>`}${projectCommands}</div>`}
        </section>
        <section class="file-context" aria-labelledby="file-heading">
          <div class="section-heading file-context-heading"><h2 class="section-label" id="file-heading">${context?.isDirectory ? '当前文件夹' : '当前文件'}</h2></div>
          <div class="file-context-card"><strong class="file-name" title="${escape(context?.file)}">${escape(context?.file?.split('/').pop() || '未选择文件')}</strong>
          <p class="path file-context-path" title="${escape(context?.file)}">${escape(context?.file || '打开工程文件，或在资源管理器右键选择文件夹。')}</p>
          <div class="related-ui" aria-labelledby="related-ui-heading"><h3 class="context-label" id="related-ui-heading">可能关联 UI</h3><div class="related-ui-row"><span class="related-ui-name" title="${escape(related ? related.file + '\n' + related.reasons.join('；') : '')}">${escape(related ? related.relative + (context.candidates.length > 1 ? `（共 ${context.candidates.length} 个，点击选择）` : '') : '未找到')}</span><button class="tool-button designer-button" data-action="designer" ${!related || state.busy ? 'disabled' : ''}>在 Qt Designer 打开</button></div></div>
          ${related?.warnings?.length ? `<p class="association-warning">${escape(related.warnings.join('；'))}</p>` : ''}
          <div class="plugin-hints" aria-labelledby="plugin-hints-heading"><h3 class="context-label" id="plugin-hints-heading">可能提供插件</h3><div class="plugin-hint-values">${libraryHints.length || commandHints.length ? [...libraryHints, ...commandHints].map(hint => `<code>${escape(hint)}</code>`).join('') : '<span class="muted">未识别到动态库或命令</span>'}</div></div>
          ${context?.truncated ? '<p class="hint">工程资源较多，仅显示扫描范围内的候选；可右键选择更具体的文件夹。</p>' : ''}</div>
        </section>
        ${buildSection('Release', state.buildDirectories?.Release || 'build_release', p?.cmakeArgsByProfile?.Release, disabled)}
        ${buildSection('Debug', state.buildDirectories?.Debug || 'build_debug', p?.cmakeArgsByProfile?.Debug, disabled)}
        <section aria-labelledby="navigation-heading"><div class="section-heading"><h2 class="section-label" id="navigation-heading">代码跳转</h2><span class="build-directory" title="相对项目根目录">${escape(state.clangdBuildDirectory || 'build_clangd')}</span></div>
          <div class="section-card navigation-card"><div class="compile-options-row"><label class="compile-option"><input type="checkbox" id="auto-compile-commands" ${state.autoRefreshCompileCommands ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-describedby="compile-option-hint"><span>新增源码文件时自动更新编译数据库</span></label>${iconButton('clangd', '配置 clangd 与编译数据库', disabled)}</div>
          <p class="hint compile-option-hint" id="compile-option-hint">仅在新增源码文件参与插件构建时更新 compile_commands.json。</p></div>
        </section>
        ${state.busy ? '<button class="cancel" data-action="cancel">取消当前操作</button>' : ''}

        `;
      highlight(selectedAction);
    });
    app.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (button && !button.disabled) {
        selectedAction = button.dataset.action;
        highlight(selectedAction);
        send(selectedAction);
      }
    });
    app.addEventListener('change', event => {
      if (event.target.id === 'auto-compile-commands') send('autoCompileCommands', { enabled: event.target.checked });
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
