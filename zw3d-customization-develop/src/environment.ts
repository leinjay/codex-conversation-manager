import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { findExecutable, Tools, zw3dFiles } from './core';
import { ToolVersions } from './toolVersions';
import type { RuntimeLibraryHealth } from './runtimeLibraries';

export interface EnvironmentIssue {
    severity: 'error' | 'warning';
    message: string;
    action: 'configure' | 'addLibraryPath';
}
export interface EnvironmentHealth { issues: EnvironmentIssue[]; libraryDirectory?: string; runtime?: RuntimeLibraryHealth }
export function hasLibraryPath(value: string | undefined, directory: string): boolean {
    return (value ?? '').split(':').filter(Boolean).some(entry => path.resolve(entry) === path.resolve(directory));
}
export function prependLibraryPath(value: string | undefined, directory: string): string {
    return hasLibraryPath(value, directory) ? value! : [directory, value].filter(Boolean).join(':');
}
export async function checkEnvironment(tools: Tools, versions: ToolVersions, designerPath: string,
    executable?: string): Promise<EnvironmentHealth> {
    const issues: EnvironmentIssue[] = [];
    const missing = (['cmakePath', 'cxxPath', 'gdbPath'] as const).filter(key =>
        !tools[key] || /^(未配置|路径无效|无法读取版本)/.test(versions[key]));
    const names = { cmakePath: 'CMake', cxxPath: 'g++', gdbPath: 'GDB' };
    if (missing.length) { issues.push({ severity: 'error', message: `缺少编译工具 ${missing.map(key => names[key]).join('、')}`, action: 'configure' }); }
    let files: string | undefined;
    try { if (tools.zw3dRoot) { files = await zw3dFiles(tools.zw3dRoot); } } catch { /* Invalid configured SDK. */ }
    const clients: string[] = [];
    if (!files || !await findExecutable(executable ?? path.join(files, 'zw3d'))) { clients.push('ZW3D'); }
    if (!designerPath || !await findExecutable(designerPath)) { clients.push('Qt Designer'); }
    if (clients.length) { issues.push({ severity: 'error', message: `缺少客户端工具 ${clients.join('、')}`, action: 'configure' }); }
    const libraryDirectory = files ? path.join(files, 'ZWMold/Bin') : undefined;
    return { issues, libraryDirectory };
}

async function shellFiles(home: string, shell: string): Promise<string[]> {
    const name = path.basename(shell);
    let files: string[];
    if (name === 'bash') {
        let login = '.profile';
        for (const candidate of ['.bash_profile', '.bash_login']) {
            try { await fs.access(path.join(home, candidate)); login = candidate; break; } catch { /* Next login file. */ }
        }
        files = [login, '.bashrc'];
    } else if (name === 'zsh') { files = ['.zprofile', '.zshrc']; }
    else if (['sh', 'dash', 'ksh'].includes(name)) { files = ['.profile']; }
    else { throw new Error(`暂不支持自动编辑 ${name || '未知'} shell，请手动配置 LD_LIBRARY_PATH。`); }
    return files.map(file => path.join(home, file));
}
function shellBlock(directory: string): { marker: string; block: string } {
    const marker = `# ZW3D LD_LIBRARY_PATH ${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`;
    const literal = "'" + directory.replace(/'/g, "'\\''") + "'";
    const block = `${marker}\ncase ":\${LD_LIBRARY_PATH-}:" in\n  *:${literal}:*) ;;\n  *) export LD_LIBRARY_PATH=${literal}\${LD_LIBRARY_PATH:+:"$LD_LIBRARY_PATH"} ;;\nesac\n`;
    return { marker, block };
}

/** Restore only the current installation's previously approved path, never source a shell file. */
export async function restoreLibraryEnvironment(home: string, shell: string, directory: string,
    environment: NodeJS.ProcessEnv, persistedValue?: string): Promise<boolean> {
    if (hasLibraryPath(environment.LD_LIBRARY_PATH, directory)) { return false; }
    try { if (!(await fs.stat(directory)).isDirectory()) { return false; } } catch { return false; }
    let approved = hasLibraryPath(persistedValue, directory);
    if (!approved) {
        // Also migrate existing button-generated blocks when VS Code has no stored collection.
        const block = shellBlock(directory).block;
        const files = await shellFiles(home, shell).catch(() => []);
        for (const file of files) {
            try { if ((await fs.readFile(file, 'utf8')).includes(block)) { approved = true; break; } } catch { /* Optional shell configuration. */ }
        }
    }
    if (!approved) { return false; }
    environment.LD_LIBRARY_PATH = prependLibraryPath(environment.LD_LIBRARY_PATH, directory);
    return true;
}

/** Append literal, idempotent POSIX shell blocks; never source user startup scripts. */
export async function addShellLibraryPath(home: string, shell: string, directory: string): Promise<string[]> {
    if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) { throw new Error('无效的动态库目录。'); }
    const { marker, block } = shellBlock(directory);
    const destinations = await shellFiles(home, shell);
    for (const file of destinations) {
        let current = '';
        try { current = await fs.readFile(file, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        if (!current.includes(marker)) { await fs.appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}\n${block}`, { mode: 0o600 }); }
    }
    return destinations;
}
