import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { constants } from 'node:fs';
import { runProcess, Log } from './process';
import { clangdProject, syncClangdFiles } from './clangd';

export interface Tools { cmakePath: string; cxxPath: string; gdbPath: string; zw3dRoot: string }
export type BuildProfile = 'Release' | 'Debug';
export interface ProjectConfig extends Tools {
    version: 1;
    projectName: string;
    libraryName: string;
    buildDirectory: string;
    buildType: 'Debug' | 'RelWithDebInfo' | 'Release';
    executable: string;
    apilibs: string;
    args: string[];
    environment: Record<string, string>;
    cmakeArgs: string[];
    cmakeArgsByProfile?: Partial<Record<BuildProfile, string>>;
    commandHint?: string;
}
export interface Project { root: string; config: ProjectConfig }
export const buildDirectories: Record<BuildProfile, string> = { Release: 'build_release', Debug: 'build_debug' };
export function withBuildProfile(project: Project, profile: BuildProfile): Project {
    return { ...project, config: { ...project.config, buildType: profile, buildDirectory: buildDirectories[profile] } };
}
export async function selectBuildProfile(project: Project, profile: BuildProfile): Promise<Project> {
    const selected = withBuildProfile(project, profile);
    if (selected.config.buildType !== project.config.buildType || selected.config.buildDirectory !== project.config.buildDirectory) {
        await fs.writeFile(path.join(project.root, '.zw3d/project.json'), JSON.stringify(selected.config, null, 2) + '\n');
    }
    return selected;
}
export interface CreateOptions extends Tools { parent: string; projectName: string; libraryName: string; remote: string; clangdPath?: string }
interface Template { directories: string[]; files: Record<string, string> }

export function expandHome(value: string): string {
    return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
export async function exists(file: string): Promise<boolean> {
    try { await fs.access(file); return true; } catch { return false; }
}
export async function findExecutable(value: string): Promise<string> {
    if (!value) { return ''; }
    const expanded = expandHome(value);
    const candidates = expanded.includes(path.sep) ? [path.resolve(expanded)] :
        (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, expanded));
    for (const candidate of candidates) {
        try {
            await fs.access(candidate, constants.X_OK);
            if ((await fs.stat(candidate)).isFile()) { return candidate; }
        } catch { /* Try next PATH entry. Preserve symlinks: compiler wrappers use argv[0]. */ }
    }
    return '';
}
export async function zw3dFiles(root: string): Promise<string> {
    const expanded = path.resolve(expandHome(root));
    for (const candidate of [path.join(expanded, 'files'), expanded]) {
        if (await exists(path.join(candidate, 'api/inc/zwapi_command.h')) && await exists(path.join(candidate, 'libZW3D.so'))) {
            return candidate;
        }
    }
    throw new Error(`未找到 ZW3D SDK：${root}。目录必须包含 files/api/inc 和 files/libZW3D.so（也可直接选择 files）。`);
}
export async function detectTools(overrides: Partial<Tools> = {}): Promise<Tools> {
    const [cmakePath, cxxPath, gdbPath] = await Promise.all([
        findExecutable(overrides.cmakePath || 'cmake').then(async p => p || (!overrides.cmakePath ? findExecutable('cmake3') : '')),
        findExecutable(overrides.cxxPath || 'g++'), findExecutable(overrides.gdbPath || 'gdb')
    ]);
    let zw3dRoot = '';
    const roots = overrides.zw3dRoot ? [overrides.zw3dRoot] : [process.env.ZW3D_ROOT ?? '', path.join(os.homedir(), 'software/zw3d')];
    if (!overrides.zw3dRoot) {
        for (const base of ['/opt/apps', '/opt', '/usr/local', path.join(os.homedir(), 'software')]) {
            try {
                roots.push(...(await fs.readdir(base)).filter(n => /zw3d/i.test(n)).sort().reverse().map(n => path.join(base, n)));
            } catch { /* Optional location. */ }
        }
    }
    for (const root of roots.filter(Boolean)) {
        try { await zw3dFiles(root); zw3dRoot = path.resolve(expandHome(root)); break; } catch { /* Next installation. */ }
    }
    return { cmakePath, cxxPath, gdbPath, zw3dRoot };
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${label} 必须是对象。`); }
    return value as Record<string, unknown>;
}
function string(value: unknown, label: string, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || /[\0\r\n]/.test(value)) { throw new Error(`${label} 必须是有效字符串。`); }
    return value;
}
export function identifier(value: unknown, label: string): string {
    const result = string(value, label);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(result)) { throw new Error(`${label} 请使用英文字母开头的字母、数字、下划线。`); }
    return result;
}
export function inside(root: string, relative: string): string {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.includes('\0')) {
        throw new Error(`路径必须位于目录内部：${relative}`);
    }
    const target = path.resolve(root, relative);
    if (!target.startsWith(path.resolve(root) + path.sep)) { throw new Error(`路径不能指向根目录：${relative}`); }
    return target;
}
function strings(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) { throw new Error(`${label} 必须是字符串数组。`); }
    return value.map(item => string(item, label, true));
}
export function validateConfig(raw: unknown, root: string): ProjectConfig {
    const data = object(raw, '项目配置');
    if (data.version !== 1) { throw new Error('不支持的项目配置版本。需要 version: 1。'); }
    identifier(data.projectName, '项目名称'); identifier(data.libraryName, '动态库名称');
    for (const key of ['cmakePath', 'cxxPath', 'zw3dRoot', 'executable', 'apilibs', 'buildDirectory']) { string(data[key], key); }
    string(data.gdbPath, 'gdbPath', true);
    inside(root, data.buildDirectory as string);
    if (!(data.buildDirectory as string).split('/').every(p => p !== '.git' && p !== '.zw3d' && p !== 'src' && p !== 'resources')) {
        throw new Error('buildDirectory 不能指向源码、配置或 Git 目录。');
    }
    if (!['Debug', 'RelWithDebInfo', 'Release'].includes(data.buildType as string)) { throw new Error('无效的 buildType。'); }
    strings(data.args, 'args'); strings(data.cmakeArgs, 'cmakeArgs');
    if (data.cmakeArgsByProfile !== undefined) {
        const values = object(data.cmakeArgsByProfile, 'cmakeArgsByProfile');
        for (const [profile, value] of Object.entries(values)) {
            if (!['Release', 'Debug'].includes(profile)) { throw new Error(`无效的 CMake 参数构建类型：${profile}`); }
            string(value, `cmakeArgsByProfile.${profile}`);
        }
    }
    if (data.commandHint !== undefined) { string(data.commandHint, 'commandHint', true); }
    for (const [key, value] of Object.entries(object(data.environment, 'environment'))) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { throw new Error(`无效的环境变量名：${key}`); }
        string(value, `environment.${key}`, true);
    }
    return data as unknown as ProjectConfig;
}
export async function readProject(root: string): Promise<Project> {
    const raw = JSON.parse(await fs.readFile(path.join(root, '.zw3d/project.json'), 'utf8'));
    return { root, config: validateConfig(raw, root) };
}
export function cmakeString(value: string): string {
    return value.replace(/\\/g, '/').replace(/\$/g, '\\$').replace(/"/g, '\\"').replace(/;/g, '\\;');
}
export function render(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, key: string) => {
        if (!(key in values)) { throw new Error(`模板包含未知占位符：${key}`); }
        return values[key];
    });
}
async function templatePath(root: string, relative: string): Promise<string> {
    const file = inside(root, relative);
    const realRoot = await fs.realpath(root);
    if (!(await fs.realpath(file)).startsWith(realRoot + path.sep)) { throw new Error(`模板文件不能链接到模板外部：${relative}`); }
    return file;
}
export async function createProject(options: CreateOptions, templateRoot: string): Promise<Project> {
    identifier(options.projectName, '项目名称'); identifier(options.libraryName, '动态库名称');
    const parent = path.resolve(expandHome(string(options.parent, '存放文件夹')));
    if (!(await fs.stat(parent)).isDirectory()) { throw new Error('存放位置必须是已有文件夹。'); }
    const root = inside(parent, options.projectName);
    const tools = await detectTools(options);
    if (!tools.cmakePath || !tools.cxxPath || !tools.zw3dRoot) { throw new Error('请填写有效的 CMake、g++ 和 ZW3D 安装位置。'); }
    const files = await zw3dFiles(tools.zw3dRoot);
    const config: ProjectConfig = {
        version: 1, projectName: options.projectName, libraryName: options.libraryName, ...tools,
        buildDirectory: buildDirectories.Debug, buildType: 'Debug', executable: path.join(files, 'zw3d'), apilibs: path.join(files, 'apilibs'),
        args: [], environment: {}, cmakeArgs: []
    };
    const values = {
        PROJECT_NAME: config.projectName, LIBRARY_NAME: config.libraryName,
        ZW3D_ROOT_CMAKE: cmakeString(config.zw3dRoot), CXX_PATH_CMAKE: cmakeString(config.cxxPath),
        CLANGD_PATH_JSON: JSON.stringify(await findExecutable(options.clangdPath || 'clangd') || 'clangd'),
        QUERY_DRIVER_ARGUMENT_JSON: JSON.stringify(`--query-driver=${[config.cxxPath, await findExecutable('gcc')].filter(Boolean).join(',')}`)
    };
    const raw = object(JSON.parse(await fs.readFile(path.join(templateRoot, 'template.json'), 'utf8')), 'template.json');
    const template: Template = { directories: strings(raw.directories, 'directories'), files: object(raw.files, 'files') as Record<string, string> };
    const directories = template.directories.map(dir => inside(root, render(dir, values)));
    const output = new Map<string, string>();
    for (const [destination, source] of Object.entries(template.files)) {
        const target = inside(root, render(destination, values));
        if (target === path.join(root, '.zw3d/project.json') || target.startsWith(path.join(root, '.git') + path.sep) || target === path.join(root, '.git')) {
            throw new Error(`模板不能写入保留路径：${destination}`);
        }
        if (output.has(target)) { throw new Error(`模板的输出路径重复：${destination}`); }
        const content = await fs.readFile(await templatePath(templateRoot, string(source, '模板文件')), 'utf8');
        output.set(target, render(content, values));
    }
    for (const required of ['CMakeLists.txt', 'src/main.cpp']) {
        if (!output.has(path.join(root, required))) { throw new Error(`模板必须生成 ${required}。`); }
    }
    // Exclusive creation: an existing project is never overwritten or removed.
    await fs.mkdir(root);
    try {
        for (const dir of directories) { await fs.mkdir(dir, { recursive: true }); }
        for (const [file, content] of output) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, content, { flag: 'wx' });
        }
        await fs.mkdir(path.join(root, '.zw3d'), { recursive: true });
        await fs.writeFile(path.join(root, '.zw3d/project.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
        await fs.rm(root, { recursive: true, force: true });
        throw error;
    }
    return { root, config };
}

export async function initGit(root: string, remote: string, log: Log, signal?: AbortSignal): Promise<void> {
    const git = await findExecutable('git');
    if (!git) { throw new Error('未找到 Git；项目文件已经生成，请配置 Git 后手动初始化。'); }
    const run = (args: string[], label?: string) => runProcess(git, args, {
        cwd: root, log, label, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    await run(['init', '-b', 'main']);
    if (!remote.trim()) { return; }
    // Treat the URL as one argument. A failed push leaves the local project and commit intact.
    if (/^[\s-]|[\0\r\n]/.test(remote)) { throw new Error('远程仓库地址无效。'); }
    await run(['remote', 'add', 'origin', remote], 'git remote add origin <配置的地址>');
    await run(['add', '.']);
    await run(['commit', '-m', 'Initialize ZW3D plugin project']);
    await run(['push', '-u', 'origin', 'main'], 'git push -u origin main');
}

export function buildCommands(project: Project, clean = false): string[][] {
    const { config: c, root } = project;
    const build = inside(root, c.buildDirectory);
    return [
        ['-S', root, '-B', build, ...c.cmakeArgs, ...(c.cmakeArgsByProfile?.[c.buildType as BuildProfile] ? [c.cmakeArgsByProfile[c.buildType as BuildProfile]!] : []),
            `-DCMAKE_BUILD_TYPE=${c.buildType}`, `-DCMAKE_CXX_COMPILER=${c.cxxPath}`,
            `-DZW3D_ROOT=${c.zw3dRoot}`, `-DZW3D_LIBRARY_NAME=${c.libraryName}`, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'],
        ['--build', build, '--parallel', String(Math.max(1, Math.min(os.cpus().length, 8))), ...(clean ? ['--clean-first'] : [])]
    ];
}
export async function buildProject(project: Project, clean: boolean, log: Log, signal?: AbortSignal): Promise<void> {
    if (!await findExecutable(project.config.cmakePath)) { throw new Error('CMake 不存在，请修改 .zw3d/project.json 的 cmakePath。'); }
    for (const [index, args] of buildCommands(project, clean).entries()) {
        await runProcess(project.config.cmakePath, args, { cwd: project.root, log, signal });
        if (index === 0) { await configureClangdDatabase(project, log, signal, false); }
    }
    log(`构建完成：${path.join(project.root, project.config.buildDirectory, 'plugin', project.config.libraryName + '.so')}\n`);
}
/** Configure only: never compile or deploy from the dedicated clangd directory. */
export async function configureClangdDatabase(project: Project, log: Log, signal?: AbortSignal, force = true): Promise<void> {
    const navigation = clangdProject(project);
    const args = buildCommands(navigation)[0];
    const signature = JSON.stringify([navigation.config.cmakePath, ...args]);
    const stateFile = path.join(project.root, '.zw3d/clangd-state.json');
    let state: { target?: string; configuration?: string } = {};
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { /* Initial configure or config reset. */ }
    const database = path.join(project.root, navigation.config.buildDirectory, 'compile_commands.json');
    if (force || state.configuration !== signature || !await exists(database)) {
        await runProcess(navigation.config.cmakePath, args, { cwd: project.root, log, signal });
        if (!await exists(database)) { throw new Error('CMake 未生成 build_clangd/compile_commands.json，请使用支持编译数据库的 Makefiles 或 Ninja 生成器。'); }
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify({ ...state, configuration: signature }, null, 2) + '\n');
    }
    await syncClangdFiles(project, log);
}
export async function deploy(project: Project, log: Log): Promise<string[]> {
    const { config: c, root } = project;
    const output = path.join(inside(root, c.buildDirectory), 'plugin');
    const so = path.join(output, c.libraryName + '.so');
    if (!await exists(so)) { throw new Error(`未找到动态库：${so}。模板应输出到 buildDirectory/plugin。`); }
    const target = path.isAbsolute(c.apilibs) ? c.apilibs : path.resolve(root, c.apilibs);
    await fs.mkdir(target, { recursive: true });
    const names = [c.libraryName + '.so', c.libraryName + '.zrc'];
    const deployed: string[] = [];
    for (const name of names) {
        const source = path.join(output, name);
        if (!await exists(source)) { continue; }
        // Rename a complete new inode over the old library, never truncate a mapped .so.
        const destination = path.join(target, name);
        const temporary = path.join(target, `.${name}.${process.pid}.${Date.now()}.tmp`);
        try { await fs.copyFile(source, temporary, constants.COPYFILE_EXCL); await fs.rename(temporary, destination); }
        finally { await fs.rm(temporary, { force: true }); }
        deployed.push(destination); log(`已部署：${destination}\n`);
    }
    return deployed;
}

export async function runtime(project: Project): Promise<{ program: string; cwd: string; env: NodeJS.ProcessEnv }> {
    const files = await zw3dFiles(project.config.zw3dRoot);
    const program = path.isAbsolute(project.config.executable) ? project.config.executable : path.resolve(project.root, project.config.executable);
    if (!await findExecutable(program)) { throw new Error(`ZW3D 程序不可执行：${program}`); }
    const env = { ...process.env };
    const libraries = ['', 'lib3rd', 'libqt', 'libqt/plugins/designer', 'xlator', 'xlator/InterOp', 'xlator/InterOp/iop/code/bin', 'xlator/InterOp/acis'];
    env.LD_LIBRARY_PATH = [...libraries.map(p => path.join(files, p)), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    const hook = path.join(files, 'libZwCodecHook.so');
    if (await exists(hook)) { env.LD_PRELOAD = [env.LD_PRELOAD, hook].filter(Boolean).join(':'); }
    env.QT_SCREEN_SCALE_FACTORS = '1'; env.SPAIOP_ACCELERATED_VISU_NEW = 'False';
    Object.assign(env, project.config.environment);
    return { program, cwd: files, env };
}
export async function debugConfiguration(project: Project): Promise<Record<string, unknown>> {
    const { program, cwd, env } = await runtime(project);
    const gdb = await findExecutable(project.config.gdbPath || 'gdb');
    if (!gdb) { throw new Error('未找到 GDB。请在 .zw3d/project.json 配置 gdbPath。'); }
    if (project.config.buildType === 'Release') { throw new Error('调试需要 Debug 或 RelWithDebInfo；请修改项目配置中的 buildType。'); }
    const apilibs = path.resolve(project.root, project.config.apilibs);
    return {
        name: `ZW3D: ${project.config.projectName}`, type: 'cppdbg', request: 'launch', program, cwd,
        args: project.config.args, MIMode: 'gdb', miDebuggerPath: gdb,
        environment: Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([name, value]) => ({ name, value })),
        additionalSOLibSearchPath: [apilibs, path.join(project.root, project.config.buildDirectory, 'plugin'), cwd].join(';'),
        stopAtEntry: false, externalConsole: false,
        setupCommands: [
            { text: '-enable-pretty-printing', ignoreFailures: true },
            { text: '-gdb-set breakpoint pending on', ignoreFailures: false },
            { text: '-interpreter-exec console "handle SIGPIPE nostop noprint pass"', ignoreFailures: true }
        ]
    };
}
