import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { findExecutable } from './core';
import { Log, runProcess } from './process';

// Limit discovery to common Qt installation roots; never search the whole home directory.
async function qtBinaries(base: string, names: string[]): Promise<string[]> {
    const result: string[] = [];
    let visited = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
        if (++visited > 128 || depth > 4) { return; }
        try {
            const entries = await fs.readdir(directory, { withFileTypes: true });
            for (const name of names) {
                if (entries.some(entry => entry.name === name && !entry.isDirectory())) {
                    const executable = await findExecutable(path.join(directory, name));
                    if (executable) { result.push(executable); }
                }
            }
            for (const entry of entries.sort((a, b) => (a.name === 'bin' ? -1 : b.name === 'bin' ? 1 : b.name.localeCompare(a.name)))) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && !['lib', 'include', 'src', 'doc', 'examples', 'plugins', 'mkspecs', 'qml', 'translations', 'resources'].includes(entry.name)) {
                    await visit(path.join(directory, entry.name), depth + 1);
                }
            }
        } catch { /* Optional installation directory. */ }
    };
    await visit(base, 0);
    return result;
}

export async function detectDesigner(override = ''): Promise<string> {
    if (override.trim()) { return findExecutable(override.trim()); }
    for (const value of ['designer', 'designer-qt5', 'designer-qt6', path.join(os.homedir(), 'software/qt5/designer'),
        '/usr/lib/qt5/bin/designer', '/usr/lib/qt6/bin/designer', '/usr/lib64/qt5/bin/designer']) {
        const found = await findExecutable(value);
        if (found) { return found; }
    }
    for (const base of [path.join(os.homedir(), 'software/qt5'), path.join(os.homedir(), 'software/qt6'), path.join(os.homedir(), 'Qt'), '/opt/Qt']) {
        const found = await qtBinaries(base, ['designer']);
        if (found.length) { return found[0]; }
    }
    return '';
}

// Designer 5.9 displays help/errors in a modal GUI and has no --version option.
// Query the companion qmake instead, and explicitly label this as its Qt version.
export async function designerVersion(executable: string): Promise<string> {
    if (!executable) { return '未找到（可配置 zw3d.designerPath）'; }
    if (!await findExecutable(executable)) { return '路径无效或不可执行'; }
    const binary = await fs.realpath(executable);
    const candidates = new Set([path.join(path.dirname(executable), 'qmake'), path.join(path.dirname(binary), 'qmake')]);
    for (const base of [path.dirname(executable), path.resolve(path.dirname(binary), '..')]) {
        // A local launcher such as qt5/designer may wrap a versioned gcc_64/bin/designer.
        if (!['/usr', '/usr/bin', '/usr/lib', '/opt', '/', os.homedir()].includes(base)) {
            for (const qmake of await qtBinaries(base, ['qmake', 'qmake6'])) { candidates.add(qmake); }
        }
    }
    const versions = new Set<string>();
    for (const qmake of candidates) {
        if (!await findExecutable(qmake)) { continue; }
        try {
            const version = (await runProcess(qmake, ['-query', 'QT_VERSION'], { signal: AbortSignal.timeout(3000) })).trim();
            if (/^\d+\.\d+(?:\.\d+)?$/.test(version)) { versions.add(version); }
        } catch { /* No suitable companion qmake. */ }
    }
    return versions.size === 1 ? `Qt Designer · Qt ${[...versions][0]}（同安装目录 qmake）`
        : '版本未知（未找到唯一的同安装目录 qmake）';
}

export async function launchDesigner(executable: string, file: string, log: Log): Promise<ChildProcess> {
    if (!await findExecutable(executable)) { throw new Error('未找到 Qt Designer，请在设置 zw3d.designerPath 中指定已有的可执行文件或启动脚本。'); }
    if (path.extname(file).toLowerCase() !== '.ui' || !(await fs.stat(file)).isFile()) { throw new Error('关联 UI 已不存在，请重新选择。'); }
    const child = spawn(executable, [file], { cwd: path.dirname(file), shell: false, detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.on('error', error => log(`Qt Designer 启动错误：${error.message}`));
    child.once('exit', code => { if (code) { log(`Qt Designer 退出码 ${code}，请检查 Qt 运行库和自定义控件插件。`); } });
    child.unref();
    log(`已用 Qt Designer 打开 ${file}（PID ${child.pid}）。`);
    return child;
}
