const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { CDP } = require('./cdp.cjs');

exports.run = async () => {
  const extension = vscode.extensions.getExtension('sponge.zw3d-customization-develop');
  assert.ok(extension);
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['createProject', 'importProject', 'detectProject', 'reconfigureProject', 'configureClangd', 'build', 'rebuild', 'run', 'debug', 'editTemplate', 'openRelatedUi', 'inspectUiContext']) assert.ok(commands.includes(`zw3d.${name}`));
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const configPath = path.join(root, '.zw3d/project.json');
  const original = await fs.readFile(process.env.ZW3D_TEST_ORIGINAL_CONFIG, 'utf8');
  let initialized;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { initialized = JSON.parse(await fs.readFile(configPath, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(initialized?.projectName, 'DebugSmoke');
  assert.equal(initialized.libraryName, 'DebugPlugin');
  assert.deepEqual(initialized.args, []);
  await fs.writeFile(configPath, original);
  await vscode.commands.executeCommand('zw3d.configureClangd');
  assert.ok((await fs.lstat(path.join(root, 'compile_commands.json'))).isSymbolicLink());
  assert.match(await fs.readFile(path.join(root, '.clangd'), 'utf8'), /CompilationDatabase: ./);
  assert.equal(vscode.workspace.getConfiguration('C_Cpp').get('intelliSenseEngine'), 'disabled');
  assert.ok(vscode.workspace.getConfiguration('clangd').get('arguments').some(arg => arg.startsWith('--query-driver=')));
  console.log('PASS: clangd workspace settings, project config and compilation database are configured');
  console.log('PASS: opening a ZW3D CMake workspace automatically initializes missing project.json');
  await vscode.commands.executeCommand('workbench.view.extension.zw3d');
  const cdp = await CDP.connect(process.env.ZW3D_CDP_PORT);
  try {
    const dashboard = await cdp.webview('dashboard');
    await cdp.until(dashboard, 'document.querySelector(".project strong")?.textContent === "DebugSmoke"');
    await cdp.until(dashboard, 'document.querySelector(".project-commands").textContent.includes("~DebugSmoke")');
    console.log('PASS: project command list scans existing saved source when opening a project');
    assert.equal(await cdp.evaluate(dashboard, 'Boolean(document.querySelector("footer, [data-action=template], [data-action=output], [data-action=scan]"))'), false);
    assert.deepEqual(await cdp.evaluate(dashboard, '[...document.querySelectorAll(".section-tools button")].map(button => button.dataset.action)'), ['configure', 'reset', 'detect']);
    assert.equal(await cdp.evaluate(dashboard, 'Boolean(document.querySelector(".compile-options-row [data-action=clangd]"))'), true);
    assert.equal(await cdp.evaluate(dashboard, 'document.querySelector("#project-heading").closest("section").parentElement === document.querySelector("#file-heading").closest("section").parentElement'), true);
    console.log('PASS: project/file peer sections, contextual icon actions and no footer tool row');
    const inheritedLibraries = process.env.LD_LIBRARY_PATH;
    const healthSdk = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'zw3d-health-ui-'));
    const healthFiles = path.join(healthSdk, 'files');
    await fs.mkdir(path.join(healthFiles, 'api/inc'), { recursive: true });
    await fs.mkdir(path.join(healthFiles, 'ZWMold/Bin'), { recursive: true });
    await fs.writeFile(path.join(healthFiles, 'api/inc/zwapi_command.h'), '');
    await fs.writeFile(path.join(healthFiles, 'libZW3D.so'), '');
    await fs.writeFile(path.join(healthFiles, 'zw3d'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const healthPlugin = path.join(root, 'build_debug/plugin/EnvironmentProbe.so');
    await fs.mkdir(path.dirname(healthPlugin), { recursive: true });
    const probeSource = path.join(healthSdk, 'probe.cpp');
    await fs.writeFile(probeSource, 'extern "C" int environment_probe(){return 0;}\n');
    await require('../dist/process').runProcess(JSON.parse(original).cxxPath, ['-shared', '-fPIC', probeSource, '-o', healthPlugin]);
    const hostSource = path.join(healthSdk, 'host.cpp');
    await fs.writeFile(hostSource, 'int main(){return 0;}\n');
    try {
      process.env.LD_LIBRARY_PATH = '';
      await fs.writeFile(configPath, JSON.stringify({ ...JSON.parse(original), zw3dRoot: healthSdk, cmakePath: '/missing/cmake', cxxPath: '/missing/g++', gdbPath: '/missing/gdb', executable: '/missing/zw3d', designerPath: '/missing/designer' }));
      await vscode.commands.executeCommand('zw3d.detect');
      await cdp.until(dashboard, 'document.querySelectorAll(".environment-status .dot.error").length === 2');
      const messages = await cdp.evaluate(dashboard, '[...document.querySelectorAll(".environment-status .status-text")].map(node => node.textContent)');
      assert.deepEqual(messages, ['缺少编译工具 CMake、g++、GDB', '缺少客户端工具 ZW3D、Qt Designer']);
      await cdp.evaluate(dashboard, 'document.querySelector(".environment-status [data-action=environmentConfigure]").click()');
      for (let attempt = 0; attempt < 100 && vscode.window.activeTextEditor?.document.uri.fsPath !== configPath; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, configPath);
      process.env.LD_LIBRARY_PATH = '';
      await require('../dist/process').runProcess(JSON.parse(original).cxxPath, [hostSource, '-o', path.join(healthFiles, 'zw3d')]);
      await fs.writeFile(configPath, JSON.stringify({ ...JSON.parse(original), libraryName:'EnvironmentProbe', buildDirectory:'build_debug', apilibs:path.join(healthFiles,'apilibs'), zw3dRoot: healthSdk, executable: path.join(healthFiles, 'zw3d'), designerPath: process.execPath }));
      await vscode.commands.executeCommand('zw3d.detect');
      await cdp.until(dashboard, 'document.querySelector(".status").textContent === "准备就绪" && document.querySelectorAll(".environment-status").length === 0');
      assert.equal(process.env.LD_LIBRARY_PATH, '', 'An absent inherited variable must not fail a healthy actual runtime');
      console.log('PASS: successful environment checks show 准备就绪 and clear all problem rows');
    } finally {
      if (inheritedLibraries === undefined) delete process.env.LD_LIBRARY_PATH; else process.env.LD_LIBRARY_PATH = inheritedLibraries;
      await fs.writeFile(configPath, original);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(healthSdk, { recursive: true, force: true });
      await fs.rm(healthPlugin, { force: true });
    }
    await vscode.commands.executeCommand('zw3d.detect');
    await vscode.commands.executeCommand('zw3d.configureClangd');
    console.log('PASS: missing compiler/client status, configuration repair and actual runtime dependency checks independent of inherited LD_LIBRARY_PATH');
    assert.equal(await cdp.evaluate(dashboard, 'document.querySelector("[data-action=buildDebug]").disabled'), false);
    assert.equal(await cdp.evaluate(dashboard, 'document.querySelector("[data-action=clangd]").getAttribute("aria-pressed")'), 'true');
    await cdp.evaluate(dashboard, 'document.querySelector("[data-build-profile=Debug]").click(); document.querySelector("[data-action=buildDebug]").click()');
    await cdp.until(dashboard, 'document.querySelector("[data-action=buildDebug]").classList.contains("is-selected") && !document.querySelector("[data-action=buildDebug]").disabled && document.querySelector(".status").textContent.includes("编译完成")');
    assert.equal(await cdp.evaluate(dashboard, 'document.querySelector("[data-action=runDebug]").classList.contains("is-selected")'), false);
    assert.deepEqual(await cdp.evaluate(dashboard, '[...document.querySelectorAll(".build-heading")].map(node => [node.querySelector("h2").textContent, node.querySelector(".build-directory").textContent])'),
      [['构建', 'build_debug']]);
    assert.deepEqual(await cdp.evaluate(dashboard, '[...document.querySelectorAll("[role=tab]")].map(node => node.textContent)'), ['Debug', 'Release']);
    assert.equal(await cdp.evaluate(dashboard, 'Boolean(document.querySelector("[aria-labelledby=launch-heading], [data-action=debug]"))'), false);
    const navigationDatabase = path.join(root, 'build_clangd/compile_commands.json');
    const navigationBefore = await fs.readFile(navigationDatabase, 'utf8');
    const navigationStamp = (await fs.stat(navigationDatabase)).mtimeMs;
    for (const profile of ['Release', 'Debug']) {
      await cdp.evaluate(dashboard, `document.querySelector('[data-build-profile=${profile}]').click()`);
      for (const action of ['build', 'run', 'rebuild']) {
        const selector = `[data-action=${action}${profile}]`;
        await cdp.until(dashboard, `!document.querySelector('${selector}').disabled`);
        await cdp.evaluate(dashboard, `document.querySelector('${selector}').click()`);
        await cdp.until(dashboard, `document.querySelector('${selector}').classList.contains('is-selected') && !document.querySelector('${selector}').disabled && document.querySelector('.status').textContent.includes('${profile} ${{build:'编译',run:'编译并运行',rebuild:'重新生成'}[action]}完成')`);
        const selected = JSON.parse(await fs.readFile(configPath, 'utf8'));
        assert.equal(selected.buildType, profile);
        assert.equal(selected.buildDirectory, `build_${profile.toLowerCase()}`);
        assert.equal(await fs.readlink(path.join(root, 'compile_commands.json')), 'build_clangd/compile_commands.json');
        assert.equal(await fs.readFile(navigationDatabase, 'utf8'), navigationBefore);
        assert.equal((await fs.stat(navigationDatabase)).mtimeMs, navigationStamp);
        if (action === 'run') {
          assert.deepEqual(await fs.readFile(path.join(selected.apilibs, 'DebugPlugin.so')),
            await fs.readFile(path.join(root, selected.buildDirectory, 'plugin/DebugPlugin.so')));
        }
      }
    }
    assert.equal(await fs.stat(path.join(root, 'build_clangd/plugin/DebugPlugin.so')).then(() => true, () => false), false);
    console.log('PASS: six profile buttons configure isolated directories, run matching plugins and preserve the independent clangd database');
    await cdp.evaluate(dashboard, 'document.querySelector("[data-action=detect]").click()');
    await cdp.until(dashboard, 'document.querySelector(".status").textContent.includes("开发环境检测") || document.querySelector(".status").textContent === "准备就绪"');
    assert.equal(await cdp.evaluate(dashboard, 'document.querySelector("[data-action=detect]").getAttribute("aria-pressed")'), 'true');
    assert.equal(await cdp.evaluate(dashboard, 'Boolean(document.querySelector(".environment, [aria-labelledby=launch-heading] .hint"))'), false);
    console.log('PASS: action highlighting and detection work without the removed environment panel or command hint');
    const fixture = await fs.mkdtemp(path.join(root, 'ui-context-'));
    const fixtureSource = path.join(fixture, 'FilletBox.cpp');
    const fixtureUi = path.join(fixture, 'FilletBox.ui');
    const capture = path.join(fixture, 'opened.json');
    const designer = path.join(fixture, 'designer-launcher');
    const contextSettings = () => vscode.workspace.getConfiguration('zw3d', vscode.Uri.file(root));
    const oldDesigner = contextSettings().inspect('designerPath').workspaceFolderValue;
    const waitCapture = async expected => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if (JSON.parse(await fs.readFile(capture, 'utf8'))[0] === expected) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Designer did not receive ${expected}`);
    };
    try {
      await fs.writeFile(fixtureSource, 'void show() { ZwCommandSend("!FilletBox"); }\nZwCommandFunctionLoad("ShowFilletBox", show, 0);\n');
      await fs.writeFile(fixtureUi, '<ui><class>FilletBox</class><widget class="ZsCc::Form" name="FilletBox"/></ui>');
      await fs.writeFile(path.join(fixture, 'Other.ui'), '<ui><class>Other</class><widget class="ZsCc::Form" name="Other"/></ui>');
      await fs.writeFile(path.join(fixture, 'FilletBox.tcmd'), '<templates><template name="FilletBox"/></templates>');
      // Use a recording launcher in this test so it never touches personal Designer windows.
      await fs.writeFile(designer, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
      await contextSettings().update('designerPath', designer, vscode.ConfigurationTarget.WorkspaceFolder);
      await vscode.window.showTextDocument(vscode.Uri.file(fixtureSource));
      await cdp.until(dashboard, 'document.querySelector(".file-context-path")?.textContent.endsWith("/FilletBox.cpp") && document.querySelector(".plugin-hints").textContent.includes("FilletBox.ui")');
      assert.equal(await cdp.evaluate(dashboard, 'Boolean(document.querySelector(".file-name, .related-ui"))'), false);
      assert.match(await cdp.evaluate(dashboard, 'document.querySelector(".plugin-hints").textContent'), /DebugPlugin\.so.*!FilletBox.*~ShowFilletBox/);
      await cdp.until(dashboard, 'document.querySelector(".project-commands").textContent.includes("!FilletBox") && document.querySelector(".project-commands").textContent.includes("~ShowFilletBox")');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fixtureSource));
      const change = new vscode.WorkspaceEdit();
      change.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        'void show() { ZwCommandSend("!FilletBox"); }\nZwCommandFunctionLoad("ShowFilletBoxSaved", show, 0);\n');
      assert.equal(await vscode.workspace.applyEdit(change), true);
      await new Promise(resolve => setTimeout(resolve, 650));
      assert.equal(await cdp.evaluate(dashboard, 'document.querySelector(".project-commands").textContent.includes("~ShowFilletBoxSaved")'), false);
      assert.equal(await document.save(), true);
      await cdp.until(dashboard, 'document.querySelector(".project-commands").textContent.includes("~ShowFilletBoxSaved") && ![...document.querySelectorAll(".project-command-list code")].some(node => node.textContent.endsWith(":~ShowFilletBox"))');
      console.log('PASS: project-level !/~ list refreshes after source save, excludes unsaved changes, and removes stale command names');
      await cdp.evaluate(dashboard, 'document.querySelector(".plugin-hints [data-ui-file]").click()');
      await waitCapture(fixtureUi);
      // Selecting a different candidate must launch that file, rather than always the first one.
      const opening = vscode.commands.executeCommand('zw3d.openRelatedUi');
      for (let attempt = 0; attempt < 100; attempt++) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector(".quick-input-widget")?.textContent', returnByValue: true }, cdp.pageSession);
        if (result.value?.includes('选择关联 UI')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await cdp.send('Runtime.evaluate', { expression: 'document.querySelector(".quick-input-widget input").focus()' }, cdp.pageSession);
      await cdp.send('Input.insertText', { text: 'Other.ui' }, cdp.pageSession);
      for (let attempt = 0; attempt < 100; attempt++) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector(".quick-input-widget .monaco-list-row.focused")?.textContent', returnByValue: true }, cdp.pageSession);
        if (result.value?.includes('Other.ui')) break;
        if (attempt === 99) throw new Error('Other.ui picker entry did not receive focus');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await opening;
      await waitCapture(path.join(fixture, 'Other.ui'));
      await vscode.commands.executeCommand('zw3d.inspectUiContext', vscode.Uri.file(fixture));
      await cdp.until(dashboard, 'document.querySelector(".file-context-heading h2").textContent === "当前文件夹"');
      await vscode.window.showTextDocument(vscode.Uri.file(fixtureUi));
      await cdp.until(dashboard, 'document.querySelector(".file-context-path").textContent.endsWith("/FilletBox.ui")');
      await fs.writeFile(path.resolve(__dirname, '../.test-artifacts/ui-context-dashboard.png'), Buffer.from(await cdp.screenshot(), 'base64'));
      console.log('PASS: active-file/folder UI card, ranked candidate picker, chosen UI passed literally to Designer, plugin/command hints and environment entry');
    } finally {
      await contextSettings().update('designerPath', oldDesigner, vscode.ConfigurationTarget.WorkspaceFolder);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(fixture, { recursive: true, force: true });
    }
    assert.match(await cdp.evaluate(dashboard, 'document.querySelector("#debug-heading").closest("section").querySelector("[data-action=runDebug] small, .run-size small").textContent'), /增量编译/);
    assert.match(await cdp.evaluate(dashboard, 'document.querySelector("#release-heading").closest("section").querySelector("[data-action=runRelease] small, .run-size small").textContent'), /增量编译/);
    const autoConfig = () => vscode.workspace.getConfiguration('zw3d', vscode.Uri.file(root));
    const previousAutoRefresh = autoConfig().inspect('autoRefreshCompileCommands')?.workspaceFolderValue;
    const cmakeFile = path.join(root, 'CMakeLists.txt');
    const originalCmake = await fs.readFile(cmakeFile, 'utf8');
    const unused = path.join(root, 'auto-unused.cpp');
    const included = path.join(root, 'src/auto-included.cpp');
    const disabledFile = path.join(root, 'src/auto-disabled.cpp');
    const database = path.join(root, 'build_clangd/compile_commands.json');
    const waitDatabase = async file => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await fs.readFile(database, 'utf8')).includes(file)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`New participating source was not exported: ${file}`);
    };
    try {
      await autoConfig().update('autoRefreshCompileCommands', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      assert.equal(autoConfig().get('autoRefreshCompileCommands'), true);
      await cdp.until(dashboard, 'document.getElementById("auto-compile-commands").checked && !document.getElementById("auto-compile-commands").disabled');
      const before = await fs.readFile(database, 'utf8');
      const stamp = (await fs.stat(database)).mtimeMs;
      await fs.writeFile(unused, '// deliberately outside the src glob\n');
      await cdp.until(dashboard, 'document.querySelector(".status").textContent.includes("自动更新编译数据库完成") && !document.getElementById("auto-compile-commands").disabled');
      assert.equal(await fs.readFile(database, 'utf8'), before);
      assert.equal((await fs.stat(database)).mtimeMs, stamp);
      await fs.appendFile(cmakeFile, '\ntarget_sources(DebugSmoke PRIVATE auto-unused.cpp)\n');
      await waitDatabase(unused);
      await cdp.until(dashboard, '!document.getElementById("auto-compile-commands").disabled');
      await fs.writeFile(included, '// automatically included by the active CMake glob\n');
      await waitDatabase(included);
      await cdp.until(dashboard, '!document.getElementById("auto-compile-commands").disabled');
      await cdp.evaluate(dashboard, 'document.getElementById("auto-compile-commands").click()');
      for (let attempt = 0; attempt < 100 && autoConfig().get('autoRefreshCompileCommands'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(autoConfig().get('autoRefreshCompileCommands'), false);
      await fs.writeFile(disabledFile, '// auto refresh is off\n');
      await new Promise(resolve => setTimeout(resolve, 1800));
      assert.equal((await fs.readFile(database, 'utf8')).includes(disabledFile), false);
      console.log('PASS: incremental labels, real sidebar checkbox, excluded source leaves database untouched, CMake enlistment and glob source auto-refresh, disabling stops refresh');
    } finally {
      await autoConfig().update('autoRefreshCompileCommands', previousAutoRefresh, vscode.ConfigurationTarget.WorkspaceFolder);
      await fs.writeFile(cmakeFile, originalCmake);
      for (const file of [unused, included, disabledFile]) await fs.rm(file, { force: true });
      await vscode.commands.executeCommand('zw3d.configureClangd');
    }
    await fs.writeFile(path.join(root, '.zw3d/reset-sentinel.txt'), 'old config content');
    const originalSource = await fs.readFile(path.join(root, 'src/main.cpp'), 'utf8');
    await cdp.evaluate(dashboard, 'document.querySelector("[data-action=reset]").click()');
    await cdp.discover();
    const quickPick = await cdp.webview('dashboard');
    for (let attempt = 0; attempt < 100; attempt++) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector(".quick-input-widget")?.textContent', returnByValue: true }, cdp.pageSession);
      if (result.value?.includes('重新配置并重载当前窗口')) break;
      if (attempt === 99) throw new Error('Reset/reload choices not shown');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await cdp.until(quickPick, 'document.querySelector(".status").textContent.includes("重新配置项目完成") && !document.querySelector("[data-action=reset]").disabled');
    assert.equal(await fs.stat(path.join(root, '.zw3d/reset-sentinel.txt')).then(() => true, () => false), false);
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')).args, []);
    assert.equal(await fs.readFile(path.join(root, 'src/main.cpp'), 'utf8'), originalSource);
    assert.equal(await fs.readlink(path.join(root, 'compile_commands.json')), 'build_clangd/compile_commands.json');
    await fs.writeFile(configPath, original);
    console.log('PASS: project-card reset button offers optional window reload and regenerates .zw3d without reloading by default');
    await vscode.workspace.getConfiguration('zw3d').update('autoInitializeProjects', false, vscode.ConfigurationTarget.Global);
    try {
      await fs.unlink(configPath);
      await cdp.until(dashboard, 'Boolean(document.querySelector("[data-action=import]")) && document.querySelector("[data-action=buildDebug]").disabled');
      await cdp.until(dashboard, 'document.querySelector(".empty .project-commands").textContent.includes("~DebugSmoke")');
      assert.match(await cdp.evaluate(dashboard, 'document.querySelector(".empty").textContent'), /project\.json/);
      await vscode.commands.executeCommand('zw3d.detectProject');
      await cdp.until(dashboard, '!document.querySelector("[data-action=buildDebug]").disabled');
      await fs.writeFile(configPath, JSON.stringify({ ...JSON.parse(original), commandHint: '!NativeTemplate' }));
      await cdp.until(dashboard, '!document.querySelector("[data-action=buildDebug]").disabled && !document.querySelector("[aria-labelledby=launch-heading] .hint")');
    } finally {
      await fs.writeFile(configPath, original);
      await vscode.workspace.getConfiguration('zw3d').update('autoInitializeProjects', true, vscode.ConfigurationTarget.Global);
    }
    await cdp.until(dashboard, '!document.querySelector("[aria-labelledby=launch-heading] .hint")');
    console.log('PASS: disabling automatic initialization, manual project detection, enabled build/debug and hidden command hints');
    await fs.writeFile(path.resolve(__dirname, '../.test-artifacts/dashboard.png'), Buffer.from(await cdp.screenshot(), 'base64'));
    await vscode.commands.executeCommand('zw3d.createProject');
    const form = await cdp.webview('create');
    await cdp.until(form, 'Boolean(document.getElementById("zw3dRoot")?.value)');
    await cdp.until(form, '/g\\+\\+.*\\d+\\.\\d+/.test(document.getElementById("version-cxxPath").textContent)');
    const compiler = await cdp.evaluate(form, 'document.getElementById("cxxPath").value');
    await cdp.evaluate(form, '(() => { const input = document.getElementById("cxxPath"); input.value = "/not/a/compiler"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await cdp.until(form, 'document.getElementById("version-cxxPath").textContent.includes("路径无效")');
    await cdp.evaluate(form, `(() => { const input = document.getElementById('cxxPath'); input.value = ${JSON.stringify(compiler)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.until(form, '/g\\+\\+.*\\d+\\.\\d+/.test(document.getElementById("version-cxxPath").textContent)');
    console.log('PASS: form versions update after editing tool paths and recover from an invalid path');
    const parent = await fs.mkdtemp(path.join(path.dirname(root), 'ui-'));
    await cdp.evaluate(form, `(() => {
      const set = (id, value) => { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
      set('parent', ${JSON.stringify(parent)}); set('projectName', 'FormProject');
    })()`);
    assert.equal(await cdp.evaluate(form, 'document.getElementById("libraryName").value'), 'FormProject');
    await cdp.evaluate(form, `(() => {
      const input = document.getElementById('libraryName'); input.value = 'FormLibrary'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await fs.writeFile(path.resolve(__dirname, '../.test-artifacts/create-form.png'), Buffer.from(await cdp.screenshot(), 'base64'));
    await cdp.evaluate(form, 'document.getElementById("submit").click()');
    await cdp.until(form, 'document.getElementById("open-project") !== null');
    const generated = path.join(parent, 'FormProject');
    assert.match(await fs.readFile(path.join(generated, 'src/main.cpp'), 'utf8'), /FormLibraryInit/);
    assert.ok((await fs.stat(path.join(generated, '.git/HEAD'))).isFile());
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    console.log('PASS: real dashboard, auto-detected form defaults, library-name sync, form submission, generated project and Git');
  } finally { cdp.close(); }
  const source = path.join(root, 'src/main.cpp');
  const lines = (await fs.readFile(source, 'utf8')).split('\n');
  const line = lines.findIndex(text => text.includes('cvxMsgDisp("Hello from'));
  assert.ok(line >= 0);
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(line, 0)));
  vscode.debug.addBreakpoints([breakpoint]);
  let timer;
  let session;
  let tracker;
  const stopped = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('No source breakpoint stop event within 45 seconds')), 45000);
    tracker = vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', {
      createDebugAdapterTracker(activeSession) {
        session = activeSession;
        return { onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'stopped') resolve(message.body);
          if (message.type === 'event' && message.event === 'output') console.log(message.body.output);
        } };
      }
    });
  });
  try {
    await vscode.commands.executeCommand('zw3d.debug');
    const stop = await stopped;
    assert.equal(stop.reason, 'breakpoint');
    const threads = await session.customRequest('threads');
    const stack = await session.customRequest('stackTrace', { threadId: stop.threadId || threads.threads[0].id, startFrame: 0, levels: 12 });
    assert.ok(stack.stackFrames.some(frame => frame.source?.path === source));
    assert.ok(stack.stackFrames.some(frame => frame.name.includes('TestInvoke')));
    const scopes = await session.customRequest('scopes', { frameId: stack.stackFrames[0].id });
    assert.ok(scopes.scopes.length);
    await fs.writeFile(path.resolve(__dirname, '../.test-artifacts/vscode-debug-result.json'), JSON.stringify({ stop, stack, scopes }, null, 2));
    console.log('PASS: VS Code command -> CMake -> deploy -> cppdbg/GDB -> source breakpoint -> stack/scopes');
  } finally {
    clearTimeout(timer); tracker?.dispose(); vscode.debug.removeBreakpoints([breakpoint]);
    if (session) await vscode.debug.stopDebugging(session);
  }
};
