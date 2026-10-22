import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Project } from './core';
import type { Log } from './process';

export const defaultClangdConfig = '# ZW3D: read the CMake compilation database exposed at the project root.\nCompileFlags:\n  CompilationDatabase: .\nIndex:\n  Background: Build\n';
export const clangdBuildDirectory = 'build_clangd';
export function clangdProject(project: Project): Project {
    return { ...project, config: { ...project.config, buildDirectory: clangdBuildDirectory, buildType: 'Debug' } };
}

/** Keep one stable database for language services, independent of the active build profile. */
export async function syncClangdFiles(project: Project, log: Log): Promise<void> {
    const root = project.root;
    await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
    try {
        await fs.writeFile(path.join(root, '.vscode/extensions.json'), JSON.stringify({
            recommendations: ['llvm-vs-code-extensions.vscode-clangd', 'ms-vscode.cpptools']
        }, null, 2) + '\n', { flag: 'wx' });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
    try { await fs.writeFile(path.join(root, '.clangd'), defaultClangdConfig, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
    const destination = path.join(root, 'compile_commands.json');
    const relative = path.join(clangdBuildDirectory, 'compile_commands.json');
    const stateFile = path.join(root, '.zw3d/clangd-state.json');
    let state: { target?: string; configuration?: string } = {};
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { /* First use. */ }
    const previous = state.target;
    let managed = false;
    try {
        const existing = await fs.lstat(destination);
        if (existing.isSymbolicLink() && previous && await fs.readlink(destination) === previous) {
            let ready = true;
            try { await fs.access(path.join(root, relative)); } catch { ready = false; }
            // Preserve working legacy links until the dedicated database has been configured.
            managed = previous === relative || ready;
            if (previous !== relative && ready) {
                const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
                try { await fs.symlink(relative, temporary); await fs.rename(temporary, destination); }
                finally { await fs.rm(temporary, { force: true }); }
            }
        } else { log('保留现有 compile_commands.json；如需改用 build_clangd，请自行调整该文件或链接。'); }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        try { await fs.symlink(relative, destination); managed = true; }
        catch (createError) { if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') { throw createError; } }
    }
    if (managed) {
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify({ ...state, target: relative }, null, 2) + '\n');
        log(`编译数据库：${destination} → ${relative}`);
    }
    const ignoreFile = path.join(root, '.gitignore');
    let ignore = '';
    try { ignore = await fs.readFile(ignoreFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    const additions = ['compile_commands.json', '.cache/', '.zw3d/clangd-state.json', 'build_release/', 'build_debug/', 'build_clangd/'].filter(entry => !ignore.split(/\r?\n/).some(line => line === entry || line === '/' + entry));
    if (additions.length) { await fs.appendFile(ignoreFile, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`); }
}

export async function clangdSettings(project: Project, clangdPath: string, gccPath: string): Promise<Record<string, unknown>> {
    const drivers = new Set([project.config.cxxPath, gccPath].filter(Boolean));
    try {
        const database = JSON.parse(await fs.readFile(path.join(project.root, 'compile_commands.json'), 'utf8')) as {
            arguments?: string[]; command?: string;
        }[];
        for (const entry of database) {
            const match = /^(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+))/.exec(entry.command?.trim() ?? '');
            const driver = entry.arguments?.[0] || match?.[1]?.replace(/\\(["\\])/g, '$1') || match?.[2] || match?.[3];
            if (driver && path.isAbsolute(driver) && /^(?:[\w.-]+-)?(?:gcc|g\+\+|cc|c\+\+|clang|clang\+\+)(?:-\d+)?$/.test(path.basename(driver))) {
                drivers.add(driver);
            }
        }
    } catch { /* CMake generates the database on first configure. */ }
    return {
        'clangd.path': clangdPath || 'clangd',
        'clangd.arguments': ['--background-index', '--clang-tidy', '--header-insertion=never', `--query-driver=${[...drivers].join(',')}`],
        'clangd.checkUpdates': false,
        'C_Cpp.intelliSenseEngine': 'disabled',
        'C_Cpp.default.compileCommands': '${workspaceFolder}/compile_commands.json'
    };
}
