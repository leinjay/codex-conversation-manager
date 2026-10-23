import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { addShellLibraryPath, checkEnvironment, EnvironmentHealth, prependLibraryPath, restoreLibraryEnvironment } from './environment';
import { inspectRuntimeLibraries, logRuntimeLibraries, requireRuntimeLibraries } from './runtimeLibraries';
import { inspectHost, RestoredHost, stopOwnedHost } from './hostProcess';
import { RunSession, runSessionKey, savedRunSession } from './runSession';
import { spawn, ChildProcess } from 'node:child_process';
import { connectExistingProject, suggestExistingProject } from './importProject';
import { initializeDetectedProject } from './projectDetection';
import { readToolVersions, toolNames } from './toolVersions';
import { clangdBuildDirectory, clangdProject, clangdSettings, syncClangdFiles } from './clangd';
import { upgradeStoredTemplate } from './templateUpgrade';
import { resetProjectConfiguration } from './resetProject';
import { participatingNewSources, sourceCandidate } from './compileCommands';
import { detectDesigner, designerVersion, launchDesigner } from './designer';
import { inferProjectCommands, inferProjectEntries, inferContextEntries, inferUiContext, PluginEntry, ResourceFile, scanUiResources, UiContext } from './uiAssociation';
import { buildProject, createProject, CreateOptions, debugConfiguration, deploy, detectTools, exists,
    configureClangdDatabase, buildDirectories, BuildProfile, findExecutable, identifier, initGit, Project, readProject, runtime,
    selectBuildProfile, Tools, withBuildProfile, zw3dFiles } from './core';

function toolSettings(uri?: vscode.Uri): Partial<Tools> {
    const config = vscode.workspace.getConfiguration('zw3d', uri);
    return {
        cmakePath: config.get<string>('cmakePath'), cxxPath: config.get<string>('cxxPath'),
        gdbPath: config.get<string>('gdbPath'), zw3dRoot: config.get<string>('installRoot')
    };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function webviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext, page: 'dashboard' | 'create'): string {
    const nonce = crypto.randomBytes(24).toString('hex');
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', file));
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('style.css')}"><title>ZW3D 二次开发</title></head>
<body data-page="${page}"><main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${uri('view.js')}"></script></body></html>`;
}

export class Workbench implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView;
    private panel?: vscode.WebviewPanel;
    private busy = false;
    private status = '正在检查开发环境…';
    private environmentOwnsStatus = true;
    private environmentHealth?: EnvironmentHealth;
    private environmentTimer?: NodeJS.Timeout;
    private environmentSequence = 0;
    private selectedAction?: string;
    private selectedRoot?: string;
    private activeHost?: ChildProcess | RestoredHost;
    private runSession?: RunSession;
    private restoreTask?: Promise<void>;
    private persistenceTask: Promise<void> = Promise.resolve();
    private savedRunSignature?: string;
    private runTask?: Promise<void>;
    private runControlTask?: Promise<void>;
    private hostTimer?: NodeJS.Timeout;
    private abort?: AbortController;
    private readonly output = vscode.window.createOutputChannel('ZW3D 二次开发');
    private readonly disposables: vscode.Disposable[] = [];
    private scanTimer?: NodeJS.Timeout;
    private scanTask: Promise<void> = Promise.resolve();
    private compileTimer?: NodeJS.Timeout;
    private readonly newSources = new Map<string, Set<string>>();
    private readonly compileDirty = new Set<string>();
    private readonly detectionErrors = new Map<string, string>();
    private disposed = false;
    private fileContext?: UiContext;
    private contextUri?: vscode.Uri;
    private contextIsDirectory = false;
    private contextTimer?: NodeJS.Timeout;
    private contextSequence = 0;
    private readonly resourceCache = new Map<string, { files: ResourceFile[]; truncated: boolean }>();
    private commandRoot?: string;
    private projectCommands?: { root: string; commands: string[]; entries: PluginEntry[]; truncated?: boolean };
    private commandTimer?: NodeJS.Timeout;
    private commandSequence = 0;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.restoreTask = this.restoreHost().catch(error => {
            this.log(`恢复 ZW3D 运行信息失败：${errorMessage(error)}`);
            if (this.runSession && !this.activeHost && this.runSession.endedAt === undefined) {
                this.runSession.state = 'failed'; this.runSession.endedAt = Date.now();
                this.runSession.detail = `无法核验原进程：${errorMessage(error)}`;
            }
        });
        void this.restoreTask.then(() => this.refresh());
        const watcher = vscode.workspace.createFileSystemWatcher('**/.zw3d/project.json');
        const cmakeWatcher = vscode.workspace.createFileSystemWatcher('**/{CMakeLists.txt,*.cmake}');
        const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{c,cc,cpp,cxx,c++,C,m,mm}');
        const resourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ui,tcmd,c,cc,cpp,cxx,h,hh,hpp,hxx,cmake}');
        const updateContext = () => { this.resourceCache.clear(); this.scheduleFileContext(); this.scheduleProjectCommands(); };
        this.disposables.push(watcher,
            watcher.onDidChange(() => void this.refresh()), watcher.onDidCreate(() => void this.refresh()),
            watcher.onDidDelete(() => void this.refresh()),
            cmakeWatcher, cmakeWatcher.onDidCreate(uri => { this.scheduleDetection(); void this.compileInputChanged(uri); }),
            cmakeWatcher.onDidChange(uri => { this.scheduleDetection(); void this.compileInputChanged(uri); }),
            sourceWatcher, sourceWatcher.onDidCreate(uri => { void this.compileInputChanged(uri, true); }),
            resourceWatcher, resourceWatcher.onDidCreate(updateContext), resourceWatcher.onDidChange(updateContext), resourceWatcher.onDidDelete(updateContext),
            cmakeWatcher.onDidChange(updateContext), cmakeWatcher.onDidCreate(updateContext),
            watcher.onDidChange(() => { updateContext(); this.scheduleEnvironment(true); }), watcher.onDidCreate(() => { updateContext(); this.scheduleEnvironment(true); }), watcher.onDidDelete(() => { updateContext(); this.scheduleEnvironment(true); }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor?.document.uri.scheme === 'file') {
                    this.contextUri = editor.document.uri; this.contextIsDirectory = false; this.scheduleFileContext();
                }
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.uri.toString() === this.contextUri?.toString()) { this.scheduleFileContext(); }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); this.scheduleDetection(); updateContext(); }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => { this.scheduleDetection(); this.scheduleFileContext(); this.scheduleProjectCommands(); }),
            vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('zw3d')) { this.scheduleDetection(); this.scheduleEnvironment(true); void this.refresh(); } }),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (/\.(?:c|cc|cpp|cxx|h|hpp|hxx)$/i.test(document.fileName)) { this.scheduleDetection(); }
                if (document.uri.scheme === 'file' && /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ui|tcmd)$/i.test(document.fileName)) { this.scheduleProjectCommands(); }
            }),
            vscode.debug.onDidTerminateDebugSession(() => void this.refresh()));
        this.scheduleDetection();
        this.scheduleEnvironment();
        this.hostTimer = setInterval(() => { void this.pollHost(); }, 2000);
        this.contextUri = vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor.document.uri : undefined;
        this.scheduleFileContext();
        void this.upgradeTemplates().catch(error => this.log(errorMessage(error)));
    }
    dispose(): void {
        this.disposed = true;
        this.environmentSequence++;
        if (this.hostTimer) { clearInterval(this.hostTimer); }
        if (this.environmentTimer) { clearTimeout(this.environmentTimer); }
        if (this.scanTimer) { clearTimeout(this.scanTimer); }
        if (this.compileTimer) { clearTimeout(this.compileTimer); }
        if (this.contextTimer) { clearTimeout(this.contextTimer); }
        if (this.commandTimer) { clearTimeout(this.commandTimer); }
        this.contextSequence++;
        this.commandSequence++;
        this.abort?.abort(); this.panel?.dispose(); this.output.dispose();
        this.disposables.forEach(d => d.dispose());
        // A normally launched ZW3D is owned by the user and survives a window reload.
    }
    showOutput(): void { this.output.show(true); }
    selectAction(action: string): void { this.selectedAction = action; void this.refresh(); }
    private log = (message: string): void => {
        if (!this.disposed) { this.output.append(message.endsWith('\n') ? message : message + '\n'); }
    };
    private persistRunSession(): Promise<void> {
        if (!this.runSession) { return this.persistenceTask; }
        const signature = JSON.stringify(this.runSession);
        if (signature === this.savedRunSignature) { return this.persistenceTask; }
        const snapshot = JSON.parse(signature) as RunSession;
        this.savedRunSignature = signature;
        this.persistenceTask = this.persistenceTask.catch(() => {}).then(() => this.context.workspaceState.update(runSessionKey, snapshot)).catch(error => {
            if (this.savedRunSignature === signature) { this.savedRunSignature = undefined; }
            this.log(`保存 ZW3D 运行信息失败：${errorMessage(error)}`);
        });
        return this.persistenceTask;
    }
    private async restoreHost(): Promise<void> {
        const session = savedRunSession(this.context.workspaceState.get(runSessionKey));
        if (!session) { return; }
        this.runSession = session;
        this.selectedRoot = session.root;
        if (session.endedAt === undefined) {
            const host = session.identity ? new RestoredHost(session.identity) : undefined;
            const state = await host?.poll();
            if (this.disposed) { return; }
            if (host && state) {
                this.activeHost = host;
                session.state = state; session.detail = undefined; session.stopRequested = false;
                this.watchHost(host, session);
                this.log(`已恢复 ZW3D 运行信息：${session.profile}，PID ${session.pid}。`);
            } else {
                session.state = 'exited'; session.endedAt = Date.now();
                session.detail = '恢复时原进程已退出或身份不匹配；离线期间的准确退出时间未知。';
            }
        }
        await this.persistRunSession();
    }
    private watchHost(child: ChildProcess | RestoredHost, session: RunSession): void {
        child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            if (this.disposed || this.runSession !== session) { return; }
            if (this.activeHost === child) { this.activeHost = undefined; }
            session.state = session.stopRequested || code === 0 ? 'exited' : 'failed'; session.endedAt = Date.now();
            session.detail = child instanceof RestoredHost ? '恢复的 ZW3D 进程已退出（退出码不可用）。' : `退出：${code ?? signal}`;
            this.log(`ZW3D ${session.detail}`);
            if (!session.stopRequested && code !== 0 && !this.disposed) { void this.report(new Error(`ZW3D 退出：${code ?? signal}。请检查许可证、显示环境及 SDK 运行库；调试启动可查看宿主输出。`)); }
            void this.persistRunSession().catch(error => this.log(`保存运行信息失败：${errorMessage(error)}`));
            void this.refresh();
        });
    }
    private scheduleProjectCommands(): void {
        if (this.disposed) { return; }
        this.commandSequence++;
        if (this.commandTimer) { clearTimeout(this.commandTimer); }
        this.commandTimer = setTimeout(() => { void this.updateProjectCommands().catch(error => this.log(`项目命令检测失败：${errorMessage(error)}`)); }, 300);
    }
    private async updateProjectCommands(): Promise<void> {
        const root = this.commandRoot;
        const sequence = ++this.commandSequence;
        if (!root || !vscode.workspace.isTrusted) { this.projectCommands = undefined; await this.refresh(); return; }
        let config;
        try { config = (await readProject(root)).config; } catch { /* Also show commands before project initialization. */ }
        // Read saved files afresh; UI association may use unsaved editor buffers, this list does not.
        const scan = await scanUiResources(root, config?.buildDirectory);
        if (sequence !== this.commandSequence || this.disposed || root !== this.commandRoot) { return; }
        this.projectCommands = { root, commands: inferProjectCommands(scan.files, root), entries: inferProjectEntries(scan.files, root, config), truncated: scan.truncated };
        await this.refresh();
    }
    private scheduleFileContext(): void {
        if (this.disposed) { return; }
        this.contextSequence++;
        if (this.contextTimer) { clearTimeout(this.contextTimer); }
        this.contextTimer = setTimeout(() => { void this.updateFileContext().catch(error => this.log(`关联 UI 检测失败：${errorMessage(error)}`)); }, 250);
    }
    private async updateFileContext(): Promise<void> {
        const sequence = ++this.contextSequence;
        const uri = this.contextUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!uri || uri.scheme !== 'file') { this.fileContext = undefined; await this.refresh(); return; }
        const isDirectory = this.contextUri ? this.contextIsDirectory : true;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        let root = folder?.uri.fsPath;
        // An enclosing workspace may contain multiple independent CMake projects.
        if (root) {
            let directory = isDirectory ? uri.fsPath : path.dirname(uri.fsPath);
            while (directory.startsWith(root + path.sep) || directory === root) {
                if (await exists(path.join(directory, 'CMakeLists.txt')) || await exists(path.join(directory, '.zw3d/project.json'))) { root = directory; break; }
                if (directory === root) { break; }
                directory = path.dirname(directory);
            }
        }
        let context: UiContext = { file: uri.fsPath, isDirectory, candidates: [], libraries: [], commands: [] };
        if (root && vscode.workspace.isTrusted) {
            let config;
            try { config = (await readProject(root)).config; } catch { /* UI resources also work before initializing a project. */ }
            const resources = this.resourceCache.get(root) ?? await scanUiResources(root, config?.buildDirectory);
            if (sequence !== this.contextSequence || this.disposed) { return; }
            this.resourceCache.set(root, resources);
            const files = resources.files.map(item => {
                const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && doc.uri.fsPath === item.file && doc.isDirty);
                return document ? { file: item.file, text: document.getText() } : item;
            });
            context = { ...inferUiContext(root, uri.fsPath, isDirectory, files, config), truncated: resources.truncated };
            context.entries = inferContextEntries(context, files, config);
        }
        if (sequence !== this.contextSequence || this.disposed) { return; }
        this.fileContext = context;
        await this.refresh();
    }
    async useResourceContext(uri?: vscode.Uri): Promise<void> {
        if (uri?.scheme === 'file') {
            this.contextUri = uri; this.contextIsDirectory = (await fs.stat(uri.fsPath)).isDirectory();
            await this.updateFileContext();
        }
        await vscode.commands.executeCommand('workbench.view.extension.zw3d');
    }
    async openRelatedUi(): Promise<void> {
        if (!vscode.workspace.isTrusted || process.platform !== 'linux') { throw new Error('请先信任 Linux 本地工作区。'); }
        await this.updateFileContext();
        const context = this.fileContext;
        if (!context?.candidates.length) { throw new Error('当前文件/文件夹未找到关联 .ui 文件，请选择包含 UI 资源的工程目录或文件。'); }
        const choice = context.candidates.length === 1 ? { candidate: context.candidates[0] } : await vscode.window.showQuickPick(
            context.candidates.map((candidate, index) => ({
                label: `${index + 1}. ${path.basename(candidate.file)}`, description: candidate.relative,
                detail: `${candidate.reasons.join('；')}${candidate.warnings.length ? ' · ' + candidate.warnings.join('；') : ''}`, candidate
            })), { title: '选择关联 UI（按关联度排序）', placeHolder: '首项为当前最可能关联的 UI；同目录候选不代表已确认绑定。', matchOnDescription: true, matchOnDetail: true });
        if (!choice) { return; }
        await this.openDesignerFile(choice.candidate.file, context.root);
    }
    private async openDesignerFile(file: string, root?: string): Promise<void> {
        const uri = vscode.Uri.file(file);
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        if (document?.isDirty && !await document.save()) { throw new Error('UI 文件尚未保存，已停止打开 Qt Designer。'); }
        let configuredDesigner: string | undefined;
        if (root) { try { configuredDesigner = (await readProject(root)).config.designerPath; } catch { /* Uninitialized project. */ } }
        let executable = await detectDesigner(configuredDesigner || vscode.workspace.getConfiguration('zw3d', uri).get<string>('designerPath'));
        if (!executable) {
            const selected = await vscode.window.showOpenDialog({ title: '选择已有的 Qt Designer 可执行文件或启动脚本', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: '使用 Qt Designer' });
            if (!selected?.[0]) { return; }
            executable = await detectDesigner(selected[0].fsPath);
            if (!executable) { throw new Error('所选路径不是可执行文件。'); }
            if (configuredDesigner && root) {
                const project = await readProject(root);
                await fs.writeFile(path.join(root, '.zw3d/project.json'), JSON.stringify({ ...project.config, designerPath: executable }, null, 2) + '\n');
            } else { await vscode.workspace.getConfiguration('zw3d', uri).update('designerPath', executable, vscode.ConfigurationTarget.WorkspaceFolder); }
        }
        await launchDesigner(executable, file, this.log);
        this.status = `已在 Qt Designer 打开 ${path.basename(file)}`;
        this.environmentOwnsStatus = false;
        await this.refresh();
    }
    private async openUiInDesigner(rawFile: unknown, rawRoot: unknown): Promise<void> {
        if (!vscode.workspace.isTrusted || process.platform !== 'linux') { throw new Error('请先信任 Linux 本地工作区。'); }
        if (typeof rawFile !== 'string' || typeof rawRoot !== 'string') { throw new Error('UI 链接已失效，请刷新后重试。'); }
        const listed = this.projectCommands?.root === rawRoot && this.projectCommands.entries.some(entry => entry.ui?.file === rawFile)
            || this.fileContext?.root === rawRoot && (this.fileContext.entries?.some(entry => entry.ui?.file === rawFile)
                || this.fileContext.candidates.some(entry => entry.file === rawFile));
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(rawRoot));
        if (!listed || !folder) { throw new Error('UI 链接已失效，请刷新后重试。'); }
        const [root, file] = await Promise.all([fs.realpath(rawRoot), fs.realpath(rawFile)]);
        const relative = path.relative(root, file);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(file).toLowerCase() !== '.ui') {
            throw new Error('关联 UI 不在当前项目内。');
        }
        await this.openDesignerFile(file, root);
    }
    async report(error: unknown): Promise<void> {
        const message = errorMessage(error);
        this.log(message);
        this.status = message.split('\n')[0];
        this.environmentOwnsStatus = false;
        await this.refresh();
        void vscode.window.showErrorMessage(message, '查看日志').then(choice => { if (choice === '查看日志') { this.showOutput(); } });
    }
    private async roots(): Promise<string[]> {
        const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        const known: string[] = [];
        for (const root of roots) { if (await exists(path.join(root, '.zw3d/project.json'))) { known.push(root); } }
        return known;
    }
    private autoCompileCommands(root: string): boolean {
        return vscode.workspace.getConfiguration('zw3d', vscode.Uri.file(root)).get<boolean>('autoRefreshCompileCommands', true);
    }
    private async compileInputChanged(uri: vscode.Uri, created = false): Promise<void> {
        if (this.disposed || !vscode.workspace.isTrusted || process.platform !== 'linux') { return; }
        const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        if (!root || !this.autoCompileCommands(root)) { return; }
        try {
            const project = await readProject(root);
            const relative = path.relative(root, uri.fsPath);
            const build = path.relative(root, path.resolve(root, project.config.buildDirectory));
            if ([build, clangdBuildDirectory, ...Object.values(buildDirectories)].some(dir => relative === dir || relative.startsWith(dir + path.sep))
                || relative.split(path.sep).some(part => part.startsWith('.'))) { return; }
            const pending = this.newSources.get(root) ?? new Set<string>();
            if (created && sourceCandidate(project, uri.fsPath)) {
                if (pending.size >= 512) { this.log('新增源码等待队列已满，请手动点击“配置 clangd”更新数据库。'); return; }
                pending.add(uri.fsPath);
                this.newSources.set(root, pending);
            }
            if (!pending.size) { return; }
            this.compileDirty.add(root);
            this.scheduleCompileCommands();
        } catch (error) { this.log(`自动更新编译数据库未排队：${errorMessage(error)}`); }
    }
    private scheduleCompileCommands(): void {
        if (this.disposed || !this.compileDirty.size) { return; }
        if (this.compileTimer) { clearTimeout(this.compileTimer); }
        this.compileTimer = setTimeout(() => { void this.refreshCompileCommands().catch(error => this.report(error)); }, 1000);
    }
    private async refreshCompileCommands(): Promise<void> {
        if (this.disposed || !vscode.workspace.isTrusted) { return; }
        if (this.busy) { this.scheduleCompileCommands(); return; }
        const root = this.compileDirty.values().next().value as string | undefined;
        if (!root) { return; }
        this.compileDirty.delete(root);
        if (!this.autoCompileCommands(root) || !(vscode.workspace.workspaceFolders ?? []).some(folder => folder.uri.fsPath === root)) {
            this.newSources.delete(root); this.scheduleCompileCommands(); return;
        }
        try {
            await this.operation('自动更新编译数据库', async signal => {
                await this.scanTask;
                const project = await readProject(root);
                const pending = this.newSources.get(root) ?? new Set<string>();
                for (const file of [...pending]) { if (!await exists(file)) { pending.delete(file); } }
                const matched = await participatingNewSources(clangdProject(project), [...pending], this.log, signal);
                if (!matched.length || !this.autoCompileCommands(root)) { return; }
                signal.throwIfAborted();
                await configureClangdDatabase(project, this.log, signal);
                await this.configureLanguageSettings(project);
                for (const file of matched) { pending.delete(file); }
                this.log(`已为 ${matched.length} 个参与插件构建的新增源码更新 compile_commands.json（未编译或启动 ZW3D）。`);
            });
        } finally { this.scheduleCompileCommands(); }
    }
    private async setAutoCompileCommands(enabled: unknown): Promise<void> {
        if (typeof enabled !== 'boolean' || this.busy) { return; }
        const project = await this.project();
        await vscode.workspace.getConfiguration('zw3d', vscode.Uri.file(project.root))
            .update('autoRefreshCompileCommands', enabled, vscode.ConfigurationTarget.WorkspaceFolder);
        if (!enabled) { this.newSources.delete(project.root); this.compileDirty.delete(project.root); }
        await this.refresh();
    }
    private scheduleDetection(): void {
        if (this.disposed) { return; }
        this.scheduleEnvironment();
        if (this.scanTimer) { clearTimeout(this.scanTimer); }
        this.scanTimer = setTimeout(() => { void this.detectProjects(false).catch(error => this.log(errorMessage(error))); }, 300);
    }
    async detectProjects(manual = true): Promise<void> {
        const task = this.scanTask.then(() => this.scanProjects(manual));
        this.scanTask = task.catch(() => { /* The caller reports the failure. Keep the queue usable. */ });
        return task;
    }
    private async scanProjects(manual: boolean): Promise<void> {
        if (this.disposed || process.platform !== 'linux' || !vscode.workspace.isTrusted) { return; }
        if (!manual && !vscode.workspace.getConfiguration('zw3d').get<boolean>('autoInitializeProjects', true)) { return; }
        if (this.busy) { if (manual) { throw new Error('请等待当前操作完成后再检测项目。'); } return; }
        let initialized = 0;
        let failed = 0;
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const root = folder.uri.fsPath;
            try {
                const result = await initializeDetectedProject(root, toolSettings());
                if (result.state !== 'unrecognized') {
                    const project = await readProject(root);
                    await syncClangdFiles(project, this.log);
                    await this.configureLanguageSettings(project);
                }
                this.detectionErrors.delete(root);
                if (result.state === 'initialized') {
                    initialized++;
                    this.log(`已自动识别并初始化中望二开项目：${root}\n识别依据：${result.reasons.join('、')}`);
                    this.status = `已自动初始化 ${result.config!.projectName}`;
                    void vscode.window.showInformationMessage(`已识别并初始化中望二开项目：${result.config!.projectName}`);
                }
            } catch (error) {
                failed++;
                const message = errorMessage(error);
                this.detectionErrors.set(root, message);
                this.log(`中望项目检测/初始化未完成：${root}\n${message}`);
                this.status = '项目自动初始化未完成，请检查开发环境';
            }
        }
        await this.refresh();
        if (manual && !initialized) {
            void vscode.window.showInformationMessage(failed ? '项目初始化未完成，请查看侧栏提示与日志，配置开发环境后重新检测。'
                : '检测完成：项目已接入，或未发现符合条件的中望 CMake 动态库工程。');
        }
    }
    private async project(): Promise<Project> {
        const roots = await this.roots();
        if (this.selectedRoot && roots.includes(this.selectedRoot)) { return readProject(this.selectedRoot); }
        if (roots.length > 1) {
            this.selectedRoot = undefined;
            await this.selectProject();
            if (!this.selectedRoot) { throw new Error('未选择项目，操作已取消。'); }
        }
        const root = this.selectedRoot && roots.includes(this.selectedRoot) ? this.selectedRoot : roots[0];
        if (!root) { throw new Error('请先初始化项目，或打开包含 .zw3d/project.json 的项目文件夹。'); }
        this.selectedRoot = root;
        return readProject(root);
    }
    async selectProject(): Promise<void> {
        const roots = await this.roots();
        const selected = await vscode.window.showQuickPick(roots.map(root => ({ label: path.basename(root), description: root })), { title: '选择当前 ZW3D 项目' });
        if (selected) { this.selectedRoot = selected.description; this.scheduleEnvironment(true); await this.refresh(); }
    }
    async refresh(): Promise<void> {
        await this.restoreTask;
        await this.persistRunSession();
        if (!this.view || this.disposed) { return; }
        const roots = await this.roots();
        const active = this.selectedRoot && roots.includes(this.selectedRoot) ? this.selectedRoot : roots[0];
        const commandRoot = active ?? this.fileContext?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (commandRoot !== this.commandRoot) { this.commandRoot = commandRoot; this.scheduleProjectCommands(); }
        let project: { name: string; root: string; library: string; apilibs: string; commandHint: string; buildProfile: BuildProfile;
            cmakeArgsByProfile?: Project['config']['cmakeArgsByProfile'] } | undefined;
        let configError = '';
        if (active) {
            try {
                const p = await readProject(active);
                project = { name: p.config.projectName, root: p.root, library: p.config.libraryName, apilibs: p.config.apilibs,
                    commandHint: p.config.commandHint ?? `~${p.config.projectName}`, cmakeArgsByProfile: p.config.cmakeArgsByProfile,
                    buildProfile: p.config.buildType === 'Release' ? 'Release' : 'Debug' };
            } catch (error) { configError = errorMessage(error); }
        }
        const detectionError = (vscode.workspace.workspaceFolders ?? []).map(folder => this.detectionErrors.get(folder.uri.fsPath)).find(Boolean);
        await this.view.webview.postMessage({ type: 'state', project, configError, detectionError, busy: this.busy, status: this.status,
            runSession: this.runSession?.root === active ? { ...this.runSession, controlling: Boolean(this.runControlTask) } : undefined,
            hostRunning: Boolean(this.activeHost),
            hostProfile: this.activeHost ? this.runSession?.profile : undefined,
            environmentIssues: this.environmentHealth?.issues,
            buildDirectories, clangdBuildDirectory,
            multiple: roots.length > 1, selectedAction: this.selectedAction,
            fileContext: this.fileContext,
            projectCommands: this.projectCommands?.root === commandRoot ? this.projectCommands : undefined,
            autoRefreshCompileCommands: active ? this.autoCompileCommands(active) : false });
    }
    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
        view.webview.html = webviewHtml(view.webview, this.context, 'dashboard');
        view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } });
        view.webview.onDidReceiveMessage((message: unknown) => {
            if (!message || typeof message !== 'object') { return; }
            const action = (message as { action?: string }).action;
            const actions: Record<string, () => unknown> = {
                ready: () => this.refresh(), create: () => this.showCreate(), import: () => this.importProject(), build: () => this.execute('build'),
                rebuild: () => this.execute('rebuild'), run: () => this.execute('run'), debug: () => this.execute('debug'),
                buildRelease: () => this.execute('build', 'Release'), runRelease: () => this.execute('run', 'Release'),
                rebuildRelease: () => this.execute('rebuild', 'Release'),
                buildDebug: () => this.execute('build', 'Debug'), runDebug: () => this.execute('run', 'Debug'),
                rebuildDebug: () => this.execute('rebuild', 'Debug'),
                stopRelease: () => this.controlRun('Release', false, (message as { runId?: unknown }).runId),
                restartRelease: () => this.controlRun('Release', true, (message as { runId?: unknown }).runId),
                stopDebug: () => this.controlRun('Debug', false, (message as { runId?: unknown }).runId),
                restartDebug: () => this.controlRun('Debug', true, (message as { runId?: unknown }).runId),
                configureCmakeRelease: () => this.configureCmakeArgument('Release'),
                configureCmakeDebug: () => this.configureCmakeArgument('Debug'),
                configure: () => this.configure(), template: () => this.editTemplate(), output: () => this.showOutput(),
                environmentConfigure: () => this.configureEnvironment(), addLibraryPath: () => this.addLibraryPath(),
                clangd: () => this.configureClangd(), reset: () => this.resetProject(),
                designer: () => this.openRelatedUi(),
                openUiDesigner: () => this.openUiInDesigner((message as { file?: unknown }).file, (message as { root?: unknown }).root),
                autoCompileCommands: () => this.setAutoCompileCommands((message as { enabled?: unknown }).enabled),
                detect: async () => { await this.detectProjects(); await this.detect(); }, scan: () => this.detectProjects(), select: () => this.selectProject(), cancel: () => this.abort?.abort()
            };
            if (action && Object.hasOwn(actions, action)) {
                if (!['ready', 'cancel', 'autoCompileCommands'].includes(action)) { this.selectAction(action); }
                void Promise.resolve(actions[action]()).catch(e => this.report(e));
            }
        });
    }
    private async operation(title: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
        if (this.busy) { throw new Error('已有操作正在执行，请等待完成或点击取消。'); }
        if (!vscode.workspace.isTrusted) { throw new Error('请先信任当前工作区。'); }
        if (process.platform !== 'linux') { throw new Error('当前版本支持 Linux ZW3D 的 .so 插件开发。'); }
        this.busy = true; this.status = title; this.abort = new AbortController();
        this.environmentOwnsStatus = false;
        const abort = this.abort;
        await this.refresh();
        this.showOutput();
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
                const cancel = token.onCancellationRequested(() => abort.abort());
                try { await action(abort.signal); this.status = `${title}完成`; }
                finally { cancel.dispose(); }
            });
        } finally { this.busy = false; this.abort = undefined; await this.refresh(); this.scheduleDetection(); }
    }
    async execute(action: 'build' | 'rebuild' | 'run' | 'debug', profile?: BuildProfile, previous?: RunSession): Promise<void> {
        await this.restoreTask;
        if (this.busy) { throw new Error('已有操作正在执行，请等待完成或点击取消。'); }
        if (this.runControlTask && !previous) { throw new Error('请等待 ZW3D 关闭或重启完成。'); }
        const label = { build: '编译', rebuild: '重新生成', run: '编译并运行', debug: '编译并调试' }[action];
        const title = profile ? `${profile} ${label}` : label;
        let session: RunSession | undefined;
        const task = this.operation(title, async signal => {
            if (previous) { await this.closeHost(previous); signal.throwIfAborted(); }
            const configured = previous ? await readProject(previous.root) : await this.project();
            const selected = action === 'debug' ? 'Debug' : profile ?? (configured.config.buildType === 'Release' ? 'Release' : 'Debug');
            const project = withBuildProfile(configured, selected);
            if (['run', 'debug'].includes(action) && (this.activeHost || vscode.debug.activeDebugSession?.configuration.type === 'cppdbg')) {
                throw new Error('请先关闭本扩展已启动的 ZW3D 或结束当前 C++ 调试，再运行新的实例。');
            }
            if (action === 'run') {
                session = { id: crypto.randomUUID(), root: project.root, profile: selected, state: 'preparing' };
                this.runSession = session;
                await this.refresh();
            }
            signal.throwIfAborted();
            if (!await vscode.workspace.saveAll(false)) { throw new Error('部分文件未保存，已停止构建。'); }
            // Validate debugger and runtime before spending time compiling or deploying.
            const debug = action === 'debug' ? await debugConfiguration(project) : undefined;
            if (debug && !vscode.extensions.getExtension('ms-vscode.cpptools')) { throw new Error('请安装 Microsoft C/C++ 扩展（ms-vscode.cpptools）。'); }
            const launch = ['run', 'debug'].includes(action) ? await runtime(project) : undefined;
            signal.throwIfAborted();
            await selectBuildProfile(configured, selected);
            this.selectAction(action === 'debug' ? 'debug' : `${action}${selected}`);
            this.log(`${selected} 构建目录：${project.config.buildDirectory}`);
            if (session) { session.state = 'building'; await this.refresh(); }
            await buildProject(project, action === 'rebuild', this.log, signal);
            await this.configureLanguageSettings(project);
            signal.throwIfAborted();
            if (!launch) { return; }
            await deploy(project, this.log);
            signal.throwIfAborted();
            await requireRuntimeLibraries(project, this.log, signal);
            signal.throwIfAborted();
            if (debug) {
                const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root));
                if (!await vscode.debug.startDebugging(folder, debug as vscode.DebugConfiguration)) { throw new Error('GDB 调试未能启动，请检查调试控制台。'); }
                this.log('GDB 调试已启动。命中断点后请查看“运行和调试”中的调用堆栈、变量和监视。');
            } else {
                await this.launch(launch, project.config.args, session!);
            }
            const hint = project.config.commandHint ?? `~${project.config.projectName}`;
            this.log(hint ? `在 ZW3D 命令栏输入 ${hint} 测试命令。` : '启动后使用该项目注册的中望命令测试插件。');
        });
        if (action === 'run') { this.runTask = task; }
        try { await task; }
        catch (error) {
            if (session) {
                session.state = session.stopRequested ? 'exited' : 'failed'; session.endedAt = Date.now(); session.detail = errorMessage(error);
                await this.refresh();
                if (session.stopRequested && ((error instanceof Error && error.name === 'AbortError') || /操作已取消/.test(errorMessage(error)))) { return; }
            }
            throw error;
        } finally { if (this.runTask === task) { this.runTask = undefined; } }
    }
    private async pollHost(): Promise<void> {
        await this.restoreTask;
        const session = this.runSession;
        const child = this.activeHost;
        if (this.disposed || !session || !child?.pid || !['running', 'paused'].includes(session.state)) { return; }
        try {
            const next = child instanceof RestoredHost ? await child.poll()
                : /^State:\s+[Tt]/m.test(await fs.readFile(`/proc/${child.pid}/status`, 'utf8')) ? 'paused' : 'running';
            if (!next) { return; }
            if (this.runSession !== session || this.activeHost !== child || !['running', 'paused'].includes(session.state)) { return; }
            if (next !== session.state) { session.state = next; await this.refresh(); }
        } catch { /* Retry unavailable /proc snapshots; a PID alone never establishes ownership. */ }
    }
    private async closeHost(session: RunSession): Promise<void> {
        session.stopRequested = true; session.state = 'stopping'; await this.refresh();
        const child = this.activeHost;
        if (child && session === this.runSession) {
            await stopOwnedHost(child);
            if (this.activeHost === child) { this.activeHost = undefined; }
        }
        session.state = 'exited'; session.endedAt ??= Date.now();
        session.detail = '用户已停止并关闭';
        this.log(`ZW3D 已关闭${session.pid ? `（PID ${session.pid}）` : ''}。`);
        await this.refresh();
    }
    private async controlRun(profile: BuildProfile, restart: boolean, id: unknown): Promise<void> {
        await this.restoreTask;
        const session = this.runSession;
        if (!session || session.profile !== profile || session.id !== id) { throw new Error('运行状态已变化，请使用当前进程卡片。'); }
        if (this.runControlTask) { return this.runControlTask; }
        if (this.activeHost instanceof RestoredHost) {
            await this.activeHost.poll();
            if (this.runControlTask) { return this.runControlTask; }
            if (this.runSession !== session) { throw new Error('运行状态已变化，请使用当前进程卡片。'); }
        }
        if (restart && (!this.activeHost?.pid || this.activeHost.pid !== session.pid || session.endedAt !== undefined
            || this.activeHost.exitCode !== null || this.activeHost.signalCode !== null)) {
            throw new Error('ZW3D 尚未启动或已退出，不能重启。请使用三角形启动按钮。');
        }
        const task = (async () => {
            if (this.busy) {
                const pending = this.runTask;
                if (!pending) { throw new Error('请等待当前操作完成后再关闭 ZW3D。'); }
                session.stopRequested = true; session.state = 'stopping'; this.abort?.abort(); await this.refresh();
                await pending.catch(() => { /* execute reports real failures and handles intentional cancellation. */ });
            }
            if (restart) { await this.execute('run', profile, session); }
            else { await this.operation('关闭 ZW3D', () => this.closeHost(session)); }
        })();
        this.runControlTask = task;
        try { await task; }
        catch (error) { session.state = 'failed'; session.detail = errorMessage(error); await this.refresh(); throw error; }
        finally { if (this.runControlTask === task) { this.runControlTask = undefined; } await this.refresh(); }
    }
    private async configureCmakeArgument(profile: BuildProfile): Promise<void> {
        if (this.busy || !vscode.workspace.isTrusted) { return; }
        const project = await this.project();
        const previous = project.config.cmakeArgsByProfile?.[profile] ?? '';
        const value = await vscode.window.showInputBox({
            title: `设置 ${profile} 构建 CMake 参数`,
            prompt: '输入一个 CMake 参数，会作为单个参数传入；留空可清除。示例：-DMY_OPTION=ON',
            placeHolder: '-DMY_OPTION=ON',
            value: previous,
            validateInput: input => /[\0\r\n]/.test(input) ? '请输入单行 CMake 参数。' : undefined
        });
        if (value === undefined) { return; }
        const parameters = { ...project.config.cmakeArgsByProfile };
        if (value.trim()) { parameters[profile] = value; } else { delete parameters[profile]; }
        const config: Project['config'] = {
            ...project.config,
            ...(Object.keys(parameters).length ? { cmakeArgsByProfile: parameters } : { cmakeArgsByProfile: undefined })
        };
        await fs.writeFile(path.join(project.root, '.zw3d/project.json'), JSON.stringify(config, null, 2) + '\n');
        this.log(value.trim() ? `${profile} CMake 参数已设置：${value}` : `已清除 ${profile} CMake 附加参数。`);
        await this.refresh();
    }
    async importProject(): Promise<void> {
        const candidates = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (await exists(path.join(folder.uri.fsPath, 'CMakeLists.txt')) && !await exists(path.join(folder.uri.fsPath, '.zw3d/project.json'))) {
                candidates.push({ label: folder.name, description: folder.uri.fsPath });
            }
        }
        if (!candidates.length) { throw new Error('请通过“文件 → 打开文件夹”打开尚未接入的 CMake 工程根目录。'); }
        const selected = candidates.length === 1 ? candidates[0] : await vscode.window.showQuickPick(candidates, { title: '选择要接入的现有 CMake 项目' });
        if (!selected) { return; }
        const config = await suggestExistingProject(selected.description, toolSettings());
        const libraryName = await vscode.window.showInputBox({
            title: '接入现有 ZW3D 项目', value: config.libraryName,
            prompt: `确认动态库名称（不带 .so）。工程应输出 ${config.buildDirectory}/plugin/<库名>.so；将新增 .zw3d/project.json。`,
            validateInput: value => { try { identifier(value, '动态库名称'); return undefined; } catch (error) { return errorMessage(error); } }
        });
        if (libraryName === undefined) { return; }
        config.libraryName = libraryName;
        await this.operation('接入现有项目', async signal => {
            signal.throwIfAborted();
            await connectExistingProject(selected.description, config);
            this.selectedRoot = selected.description;
            this.log(`已接入现有项目：${selected.description}`);
        });
        await this.configure();
    }
    private async launch(launch: Awaited<ReturnType<typeof runtime>>, args: string[], session: RunSession): Promise<void> {
        session.state = 'starting'; await this.refresh();
        const child = spawn(launch.program, args, { cwd: launch.cwd, env: launch.env, shell: false, detached: true, stdio: 'ignore' });
        await new Promise<void>((resolve, reject) => {
            child.once('error', reject); child.once('spawn', resolve);
        });
        this.activeHost = child;
        session.state = 'running'; session.pid = child.pid; session.startedAt = Date.now();
        this.watchHost(child, session);
        child.unref();
        try { session.identity = child.pid ? (await inspectHost(child.pid))?.identity : undefined; }
        catch (error) { this.log(`无法记录 ZW3D 进程标识：${errorMessage(error)}`); }
        this.log(`已启动 ZW3D，PID ${child.pid}。`);
        await this.refresh();
    }
    async configure(): Promise<void> {
        const roots = await this.roots();
        const root = this.selectedRoot && roots.includes(this.selectedRoot) ? this.selectedRoot : roots[0];
        if (!root) { throw new Error('请先打开一个 ZW3D 项目。'); }
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, '.zw3d/project.json')));
    }
    async resetProject(): Promise<void> {
        await this.restoreTask;
        if (this.busy) { throw new Error('请等待当前操作完成后再重新配置项目。'); }
        if (this.activeHost || vscode.debug.activeDebugSession?.configuration.type === 'cppdbg') {
            throw new Error('请先关闭本扩展启动的 ZW3D 或结束 C++ 调试，再重新配置项目。');
        }
        const roots = await this.roots();
        if (!this.selectedRoot && roots.length > 1) { await this.selectProject(); if (!this.selectedRoot) { return; } }
        const root = this.selectedRoot && roots.includes(this.selectedRoot) ? this.selectedRoot : roots[0];
        if (!root) { throw new Error('请先打开已接入的中望二开项目。'); }
        const choice = await vscode.window.showQuickPick([
            { label: '重新配置项目', description: '推荐 · 刷新侧栏并重启 clangd', reload: false },
            { label: '重新配置并重载当前窗口', description: '完成后重新加载当前 VS Code 窗口', reload: true }
        ], {
            title: `重新配置 ${path.basename(root)}`,
            placeHolder: `将重建 ${path.join(root, '.zw3d')}，该目录内的手动配置会重置。`
        });
        if (!choice) { return; }
        await this.operation('重新配置项目', async signal => {
            if (!await vscode.workspace.saveAll(false)) { throw new Error('部分文件未保存，已停止重新配置。'); }
            // Let any scan that started before this operation finish; new scans see busy=true.
            await this.scanTask;
            signal.throwIfAborted();
            await resetProjectConfiguration(root, toolSettings(vscode.Uri.file(root)), async project => {
                await configureClangdDatabase(project, this.log, signal);
                await this.configureLanguageSettings(project);
            }, signal);
            this.selectedRoot = root;
            this.detectionErrors.delete(root);
            this.log(`已重新生成 ${path.join(root, '.zw3d')} 并更新编译数据库。`);
        });
        if (choice.reload) {
            this.log('重新配置完成，正在重载当前窗口。');
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
            try {
                const extension = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
                if (extension) { await extension.activate(); await vscode.commands.executeCommand('clangd.restart'); }
            } catch (error) { this.log(`项目重新配置成功；clangd 未自动重启，可手动运行 clangd: Restart language server。${errorMessage(error)}`); }
            await this.refresh();
            void vscode.window.showInformationMessage('项目已重新配置，侧栏和编译数据库已刷新，通常无需重载窗口。');
        }
    }
    private async configureLanguageSettings(project: Project): Promise<void> {
        const uri = vscode.Uri.file(project.root);
        const configuration = vscode.workspace.getConfiguration(undefined, uri);
        const clangdPath = await findExecutable(vscode.workspace.getConfiguration('zw3d', uri).get<string>('clangdPath') || 'clangd');
        const suggested = await clangdSettings(project, clangdPath, await findExecutable('gcc'));
        for (const [key, value] of Object.entries(suggested)) {
            const explicit = configuration.inspect(key);
            // Use VS Code's JSONC editor so comments and unrelated settings survive.
            if (explicit?.workspaceFolderValue !== undefined || explicit?.workspaceValue !== undefined) { continue; }
            await configuration.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        const clangConfig = vscode.workspace.getConfiguration('clangd', uri);
        const args = clangConfig.get<string[]>('arguments') ?? [];
        if (!args.some(arg => arg.startsWith('--query-driver'))) {
            const query = (suggested['clangd.arguments'] as string[]).find(arg => arg.startsWith('--query-driver'))!;
            await clangConfig.update('arguments', [...args, query], vscode.ConfigurationTarget.WorkspaceFolder);
        }
    }
    async configureClangd(): Promise<void> {
        await this.operation('配置 clangd 与编译数据库', async signal => {
            if (!await vscode.workspace.saveAll(false)) { throw new Error('部分文件未保存，已停止配置。'); }
            const project = await this.project();
            await configureClangdDatabase(project, this.log, signal);
            await this.configureLanguageSettings(project);
            this.log('clangd 已配置：.clangd、工作区设置、compile_commands.json。');
            this.log('如已有 clangd 设置将保留；可运行“clangd: Restart language server”重新加载编译数据库。');
        });
    }
    async detect(): Promise<void> {
        await this.inspectEnvironment(true);
    }
    private scheduleEnvironment(takeStatus = false): void {
        if (this.disposed) { return; }
        if (takeStatus && !this.busy) { this.environmentOwnsStatus = true; }
        this.environmentSequence++;
        if (this.environmentTimer) { clearTimeout(this.environmentTimer); }
        this.environmentTimer = setTimeout(() => { void this.inspectEnvironment(false).catch(error => this.log(errorMessage(error))); }, 500);
    }
    private async inspectEnvironment(manual: boolean): Promise<EnvironmentHealth | undefined> {
        if (this.disposed || !vscode.workspace.isTrusted || process.platform !== 'linux') { return; }
        if (manual && !this.busy) {
            this.environmentOwnsStatus = true;
            this.status = '正在检查开发环境…';
            await this.refresh();
        }
        const sequence = ++this.environmentSequence;
        const roots = await this.roots();
        const root = this.selectedRoot && roots.includes(this.selectedRoot) ? this.selectedRoot : roots[0];
        let project: Project | undefined;
        if (root) { try { project = await readProject(root); } catch { /* Config editor remains available for invalid projects. */ } }
        const tools = project?.config ?? await detectTools(toolSettings(root ? vscode.Uri.file(root) : undefined));
        const designerPath = await detectDesigner(project?.config.designerPath || vscode.workspace.getConfiguration('zw3d', root ? vscode.Uri.file(root) : undefined).get<string>('designerPath'));
        const [versions, designer] = await Promise.all([readToolVersions(tools), designerVersion(designerPath)]);
        const executable = project ? path.resolve(project.root, project.config.executable) : undefined;
        let libraryDirectory: string | undefined;
        try { if (tools.zw3dRoot) { libraryDirectory = path.join(await zw3dFiles(tools.zw3dRoot), 'ZWMold/Bin'); } } catch { /* Report missing client below. */ }
        if (libraryDirectory && sequence === this.environmentSequence) {
            const restored = await restoreLibraryEnvironment(os.homedir(), process.env.SHELL || '/bin/bash', libraryDirectory,
                process.env, this.context.environmentVariableCollection.get('LD_LIBRARY_PATH')?.value);
            if (restored) {
                this.context.environmentVariableCollection.persistent = true;
                this.context.environmentVariableCollection.replace('LD_LIBRARY_PATH', process.env.LD_LIBRARY_PATH!);
                this.log(`已恢复此前添加的 ZW3D 动态库路径：${libraryDirectory}（未执行 shell 启动脚本）。`);
            }
        }
        const health = await checkEnvironment(tools, versions, designerPath, executable);
        if (project && !health.issues.some(issue => issue.message.includes('ZW3D'))) {
            try {
                health.runtime = await inspectRuntimeLibraries(project);
                health.issues.push(...health.runtime.issues);
            } catch (error) {
                health.issues.push({ severity: 'warning', message: '无法检查实际启动的动态库依赖（查看日志）', action: 'configure' });
                this.log(`动态库依赖检测未完成：${errorMessage(error)}`);
            }
        } else if (!project) {
            health.issues.push({ severity: 'warning', message: '未接入项目，插件动态库依赖待检查', action: 'configure' });
        }
        if (this.disposed) { return; }
        if (sequence === this.environmentSequence) {
            this.environmentHealth = health;
            if (!this.busy && (manual || this.environmentOwnsStatus)) {
                this.environmentOwnsStatus = true;
                this.status = health.issues.length ? '开发环境检测完成，请处理以下问题' : '准备就绪';
            }
        }
        if (!manual) { await this.refresh(); return sequence === this.environmentSequence ? health : undefined; }
        this.log('开发环境检测：');
        for (const key of Object.keys(toolNames) as (keyof Tools)[]) {
            this.log(`${toolNames[key]}: ${versions[key]}\n  路径：${tools[key] || '未找到，请在设置或初始化表单中指定'}`);
        }
        this.log(`Qt Designer: ${designer}\n  路径：${designerPath || '未找到，请设置 zw3d.designerPath'}`);
        this.log(`扩展进程 LD_LIBRARY_PATH：${process.env.LD_LIBRARY_PATH || '（未设置）'}\nSDK ZWMold 目录：${health.libraryDirectory || '无法确定，请先修正 ZW3D 安装位置'}\n实际启动环境会自动补入 SDK 和插件目录；项目 environment 显式覆盖优先，最终以依赖解析结果为准。`);
        if (health.runtime) { logRuntimeLibraries(health.runtime, this.log); }
        this.showOutput();
        await this.refresh();
        void vscode.window.showInformationMessage(health.issues.length ? '开发环境检测完成，请处理以下问题' : '准备就绪');
        return health;
    }
    private async configureEnvironment(): Promise<void> {
        if ((await this.roots()).length) { await this.configure(); }
        else { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:sponge.zw3d-customization-develop'); }
    }
    async addLibraryPath(): Promise<void> {
        await this.operation('添加zw3d动态库环境变量', async () => {
            const health = await this.inspectEnvironment(false);
            if (!health) { throw new Error('环境配置在检查期间发生变化，请重试。'); }
            const directory = health.libraryDirectory;
            const info = directory ? await fs.stat(directory).catch(() => undefined) : undefined;
            if (!directory || !info?.isDirectory()) { throw new Error('未找到 ZWMold/Bin 目录，请先修正 ZW3D 安装位置。'); }
            const files = await addShellLibraryPath(os.homedir(), process.env.SHELL || '/bin/bash', directory);
            process.env.LD_LIBRARY_PATH = prependLibraryPath(process.env.LD_LIBRARY_PATH, directory);
            this.context.environmentVariableCollection.persistent = true;
            this.context.environmentVariableCollection.replace('LD_LIBRARY_PATH', process.env.LD_LIBRARY_PATH);
            this.log(`已将 ${directory} 添加到 LD_LIBRARY_PATH。已更新：${files.join('、')}。已有终端需重新打开，已有其他应用需重新登录或重启。`);
            await this.inspectEnvironment(false);
        });
        this.environmentOwnsStatus = true;
        await this.inspectEnvironment(false);
        await vscode.window.showInformationMessage('已更新用户 shell 配置和本次扩展环境。请重新打开终端；已运行的其他应用不会自动更新环境。');
    }
    private templateRoot(): string {
        return vscode.workspace.getConfiguration('zw3d').get<string>('templateDirectory')?.trim() || path.join(this.context.extensionPath, 'templates/default');
    }
    private async upgradeTemplates(): Promise<void> {
        await upgradeStoredTemplate(path.join(this.context.globalStorageUri.fsPath, 'templates/default'),
            path.join(this.context.extensionPath, 'templates/default'));
    }
    async editTemplate(): Promise<void> {
        await this.upgradeTemplates();
        let root = vscode.workspace.getConfiguration('zw3d').get<string>('templateDirectory')?.trim();
        if (!root) {
            root = path.join(this.context.globalStorageUri.fsPath, 'templates/default');
            await fs.mkdir(path.dirname(root), { recursive: true });
            if (!await exists(root)) { await fs.cp(path.join(this.context.extensionPath, 'templates/default'), root, { recursive: true, errorOnExist: true, force: false }); }
            await vscode.workspace.getConfiguration('zw3d').update('templateDirectory', root, vscode.ConfigurationTarget.Global);
        }
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'template.json')));
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'CMakeLists.txt.tpl')), { viewColumn: vscode.ViewColumn.Beside });
    }
    async showCreate(): Promise<void> {
        if (this.panel) { this.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel('zw3d.create', '初始化 ZW3D 项目', vscode.ViewColumn.One, {
            enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        });
        this.panel = panel;
        panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; } });
        panel.webview.onDidReceiveMessage((message: unknown) => {
            void this.formMessage(panel, message).catch(async error => {
                this.log(errorMessage(error));
                await panel.webview.postMessage({ type: 'error', message: errorMessage(error) });
            });
        });
        panel.webview.html = webviewHtml(panel.webview, this.context, 'create');
    }
    private async formMessage(panel: vscode.WebviewPanel, raw: unknown): Promise<void> {
        if (!raw || typeof raw !== 'object') { return; }
        const message = raw as { action: string; field?: string; values?: Record<string, unknown>; requestId?: number };
        if (message.action === 'ready' || message.action === 'detect') {
            await panel.webview.postMessage({ type: 'defaults', values: {
                ...await detectTools(toolSettings()),
                ...(message.action === 'ready' ? {
                    parent: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '', projectName: '', libraryName: '',
                    remote: vscode.workspace.getConfiguration('zw3d').get<string>('defaultRemote') ?? ''
                } : {})
            } });
        } else if (message.action === 'versions') {
            const tools = {} as Tools;
            for (const key of Object.keys(toolNames) as (keyof Tools)[]) {
                const value = message.values?.[key];
                if (typeof value !== 'string' || /[\0\r\n]/.test(value)) { return; }
                tools[key] = value;
            }
            await panel.webview.postMessage({ type: 'versions', requestId: message.requestId, versions: await readToolVersions(tools) });
        } else if (message.action === 'browse') {
            const folders = ['parent', 'zw3dRoot'].includes(message.field ?? '');
            if (!['parent', 'zw3dRoot', 'cmakePath', 'cxxPath', 'gdbPath'].includes(message.field ?? '')) { return; }
            const selected = await vscode.window.showOpenDialog({ canSelectFiles: !folders, canSelectFolders: folders, canSelectMany: false, openLabel: '选择' });
            if (selected?.[0]) { await panel.webview.postMessage({ type: 'field', field: message.field, value: selected[0].fsPath }); }
        } else if (message.action === 'create') {
            const values = message.values;
            if (!values) { throw new Error('表单数据为空。'); }
            for (const name of ['parent', 'projectName', 'libraryName', 'cmakePath', 'cxxPath', 'gdbPath', 'zw3dRoot', 'remote']) {
                if (typeof values[name] !== 'string') { throw new Error(`无效字段：${name}`); }
            }
            let result: Project | undefined;
            let gitWarning = '';
            await this.operation('初始化项目', async signal => {
                if (!await vscode.workspace.saveAll(false)) { throw new Error('部分模板文件未保存，已停止创建。'); }
                signal.throwIfAborted();
                await this.upgradeTemplates();
                result = await createProject({ ...values as unknown as CreateOptions,
                    clangdPath: vscode.workspace.getConfiguration('zw3d').get<string>('clangdPath') }, this.templateRoot());
                // Git failures or cancellation preserve the generated project and any local commit.
                try { await initGit(result.root, values.remote as string, this.log, signal); }
                catch (error) { gitWarning = errorMessage(error); this.log(`Git 初始化未完全完成：${gitWarning}`); }
            });
            if (!result) { return; }
            this.createdProjects.set(panel, result.root);
            await panel.webview.postMessage({ type: 'created', root: result.root, warning: gitWarning });
            if (gitWarning) { void vscode.window.showWarningMessage('项目已创建，Git 提交或推送未完成。详细原因和重试方法请查看日志和 README。'); }
        } else if (message.action === 'open') {
            // Only open a successfully created destination owned by this panel.
            const root = this.createdProjects.get(panel);
            if (root) { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true }); }
        }
    }
    private readonly createdProjects = new WeakMap<vscode.WebviewPanel, string>();
}

export function activate(context: vscode.ExtensionContext): void {
    const workbench = new Workbench(context);
    context.subscriptions.push(workbench, vscode.window.registerWebviewViewProvider('zw3d.dashboard', workbench));
    const commands: Record<string, () => unknown> = {
        createProject: () => workbench.showCreate(), importProject: () => workbench.importProject(), build: () => workbench.execute('build'), rebuild: () => workbench.execute('rebuild'),
        run: () => workbench.execute('run'), debug: () => workbench.execute('debug'), configure: () => workbench.configure(), configureClangd: () => workbench.configureClangd(),
        reconfigureProject: () => workbench.resetProject(),
        openRelatedUi: () => workbench.openRelatedUi(),
        editTemplate: () => workbench.editTemplate(), detect: () => workbench.detect(), detectProject: () => workbench.detectProjects(), selectProject: () => workbench.selectProject(),
        showOutput: () => workbench.showOutput(), addLibraryPath: () => workbench.addLibraryPath()
    };
    const actionNames: Record<string, string> = {
        createProject: 'create', importProject: 'import', editTemplate: 'template', detectProject: 'scan',
        selectProject: 'select', showOutput: 'output', configureClangd: 'clangd', reconfigureProject: 'reset', openRelatedUi: 'designer'
    };
    for (const [name, handler] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(`zw3d.${name}`, () => {
            workbench.selectAction(actionNames[name] ?? name);
            return Promise.resolve(handler()).catch(error => workbench.report(error));
        }));
    }
    context.subscriptions.push(vscode.commands.registerCommand('zw3d.inspectUiContext', (uri?: vscode.Uri) =>
        workbench.useResourceContext(uri).catch(error => workbench.report(error))));
}
