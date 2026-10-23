import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exists, findExecutable, Project, runtime } from './core';
import { runProcess, Log } from './process';
import type { EnvironmentIssue } from './environment';

export interface LibraryCheck {
    file: string;
    status: 'passed' | 'missing' | 'unavailable';
    missing: string[];
    output: string;
}
export interface RuntimeLibraryHealth {
    issues: EnvironmentIssue[];
    checks: LibraryCheck[];
    libraryPath: string;
    program: string;
}

export async function inspectElfLibraries(file: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<LibraryCheck> {
    const unavailable = (output: string): LibraryCheck => ({ file, status: 'unavailable', missing: [], output });
    const handle = await fs.open(file, 'r').catch(() => undefined);
    if (!handle) { return unavailable('文件不存在或不可读取'); }
    const header = Buffer.alloc(20);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    if (header.subarray(0, 4).toString('hex') !== '7f454c46') { return unavailable('不是 ELF 文件，未检查动态库依赖'); }
    const type = header[5] === 2 ? header.readUInt16BE(16) : header.readUInt16LE(16);
    if (![2, 3].includes(type)) { return unavailable('不是 ELF 可执行文件或共享库'); }
    const ldd = await findExecutable('ldd');
    if (!ldd) { return unavailable('未找到 ldd，未安装额外工具'); }
    let output = '';
    let failure: unknown;
    try {
        output = await runProcess(ldd, ['--', file], {
            cwd, env: { ...env, LC_ALL: 'C' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
            log: chunk => { output = (output + chunk).slice(-128_000); }, label: 'ELF 动态库检查'
        });
    } catch (error) { failure = error; }
    signal?.throwIfAborted();
    const missing = [...new Set(output.split(/\r?\n/).flatMap(line => {
        const dependency = /^\s*(.+?)\s+=>\s+not found\s*$/.exec(line);
        if (dependency) { return [dependency[1]]; }
        if (/version .+ not found|cannot be preloaded|error while loading shared libraries/i.test(line)) { return [line.trim()]; }
        return [];
    }))];
    if (missing.length) { return { file, status: 'missing', missing, output }; }
    if (failure && !/statically linked/.test(output)) {
        return unavailable(`${output}\n${failure instanceof Error ? failure.message : '依赖检查失败或超时'}`);
    }
    if (!output.trim()) { return unavailable('ldd 未返回依赖信息'); }
    return { file, status: 'passed', missing: [], output };
}

export async function inspectRuntimeLibraries(project: Project, deployedOnly = false, signal?: AbortSignal): Promise<RuntimeLibraryHealth> {
    const launch = await runtime(project);
    const built = path.join(project.root, project.config.buildDirectory, 'plugin', project.config.libraryName + '.so');
    const deployed = path.resolve(project.root, project.config.apilibs, project.config.libraryName + '.so');
    const candidates = [...new Set(deployedOnly ? [deployed] : [built, deployed])];
    const files = [launch.program];
    for (const candidate of candidates) { if (await exists(candidate)) { files.push(candidate); } }
    const checks: LibraryCheck[] = [];
    for (const file of files) { checks.push(await inspectElfLibraries(file, launch.cwd, launch.env, signal)); }
    const issues: EnvironmentIssue[] = [];
    const missing = [...new Set(checks.flatMap(check => check.missing))];
    if (missing.length) {
        issues.push({ severity: 'error', message: `缺少运行动态库 ${missing.slice(0, 4).join('、')}${missing.length > 4 ? ` 等 ${missing.length} 项（查看日志）` : ''}`, action: 'configure' });
    }
    if (checks.some(check => check.status === 'unavailable')) {
        issues.push({ severity: 'warning', message: '动态库依赖检查未完成（查看日志）', action: 'configure' });
    }
    if (files.length === 1) {
        issues.push({ severity: deployedOnly ? 'error' : 'warning', message: deployedOnly ? '未找到已部署插件，无法启动' : '插件尚未生成或部署，动态库依赖待检查', action: 'configure' });
    }
    return { issues, checks, program: launch.program, libraryPath: launch.env.LD_LIBRARY_PATH ?? '' };
}

export function logRuntimeLibraries(health: RuntimeLibraryHealth, log: Log): void {
    log(`ZW3D 实际启动程序：${health.program}\n启动 LD_LIBRARY_PATH：${health.libraryPath || '（未设置）'}`);
    for (const check of health.checks) { log(`动态库依赖：${check.file}\n检测结果：${check.status === 'passed' ? '已解析 ELF 依赖' : check.status === 'missing' ? '存在缺失/不兼容依赖' : '未完成'}\n${check.output}`); }
    log('检查覆盖 ELF 静态声明依赖；运行中 dlopen、许可证、GUI 和命令执行仍需实际运行验证。外部启动的 ZW3D 不使用本扩展启动环境。');
}

export async function requireRuntimeLibraries(project: Project, log: Log, signal?: AbortSignal): Promise<void> {
    const health = await inspectRuntimeLibraries(project, true, signal);
    logRuntimeLibraries(health, log);
    if (health.issues.length) { throw new Error(`已停止启动 ZW3D：${health.issues.map(issue => issue.message).join('；')}。请查看日志并修正项目运行环境或补齐依赖。`); }
}
