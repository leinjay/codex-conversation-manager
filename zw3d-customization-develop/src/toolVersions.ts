import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { findExecutable, Tools, zw3dFiles } from './core';
import { runProcess } from './process';

export type ToolVersions = Record<keyof Tools, string>;
export const toolNames: Record<keyof Tools, string> = {
    cmakePath: 'CMake', cxxPath: 'g++', gdbPath: 'GDB', zw3dRoot: 'ZW3D'
};

/** Query CLI tools only; read ZW3D metadata instead of launching the GUI. */
export async function readToolVersion(key: keyof Tools, value: string): Promise<string> {
    if (!value.trim()) { return '未配置'; }
    try {
        if (key === 'zw3dRoot') {
            const files = await zw3dFiles(value);
            for (const candidate of [path.join(path.dirname(files), 'info'), path.join(files, 'info')]) {
                try {
                    if ((await fs.stat(candidate)).size > 64 * 1024) { continue; }
                    const info = JSON.parse(await fs.readFile(candidate, 'utf8')) as { version?: unknown };
                    if (typeof info.version === 'string' && /^[0-9][\w.+-]*$/.test(info.version)) { return info.version; }
                } catch { /* Optional installation metadata. */ }
            }
            return '版本未知（安装包未提供版本信息）';
        }
        const executable = await findExecutable(value);
        if (!executable) { return '路径无效或不可执行'; }
        const output = await runProcess(executable, ['--version'], {
            signal: AbortSignal.timeout(3000), env: { ...process.env, LC_ALL: 'C' }
        });
        return output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 220)
            || '未返回版本信息';
    } catch { return '无法读取版本（运行失败或超时）'; }
}

export async function readToolVersions(tools: Tools): Promise<ToolVersions> {
    const entries = await Promise.all((Object.keys(toolNames) as (keyof Tools)[])
        .map(async key => [key, await readToolVersion(key, tools[key])] as const));
    return Object.fromEntries(entries) as ToolVersions;
}
