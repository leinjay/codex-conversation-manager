import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';

export interface HostIdentity {
    pid: number; bootId: string; startTicks: string; executable: string;
}

/** Linux boot + process start time identify a particular process even after PID reuse. */
export async function inspectHost(pid: number): Promise<{ identity: HostIdentity; state: 'running' | 'paused' } | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 1) { return undefined; }
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        // comm can contain spaces and parentheses; fields after its final ')' start at field 3.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (['Z', 'X', 'x'].includes(fields[0]) || Number(fields[2]) !== pid || Number(fields[3]) !== pid) { return undefined; }
        if (!/^\d+$/.test(fields[19] || '')) { return undefined; }
        const [bootId, executable, check] = await Promise.all([
            fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readlink(`/proc/${pid}/exe`), fs.readFile(`/proc/${pid}/stat`, 'utf8')
        ]);
        const checked = check.slice(check.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (checked[19] !== fields[19] || ['Z', 'X', 'x'].includes(checked[0])) { return undefined; }
        return { identity: { pid, bootId: bootId.trim(), startTicks: fields[19], executable }, state: /^[Tt]$/.test(checked[0]) ? 'paused' : 'running' };
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) { return undefined; }
        throw error;
    }
}

/** A verified process from an earlier extension host; it is no longer our ChildProcess. */
export class RestoredHost extends EventEmitter {
    readonly pid: number;
    exitCode: number | null = null;
    readonly signalCode: NodeJS.Signals | null = null;
    constructor(readonly identity: HostIdentity) { super(); this.pid = identity.pid; }

    async poll(): Promise<'running' | 'paused' | undefined> {
        if (this.exitCode !== null) { return undefined; }
        const current = await inspectHost(this.pid);
        const expected = this.identity;
        if (current && current.identity.bootId === expected.bootId && current.identity.startTicks === expected.startTicks
            && current.identity.executable === expected.executable) { return current.state; }
        this.exitCode = 0;
        this.emit('exit', 0, null);
        return undefined;
    }

    async stop(graceMilliseconds = 5000): Promise<void> {
        const signal = async (name: NodeJS.Signals) => {
            // Revalidate immediately before each signal; never trust a saved PID alone.
            if (!await this.poll()) { return; }
            try { process.kill(-this.pid, name); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
        };
        await signal('SIGTERM');
        const started = Date.now();
        let forced = false;
        while (await this.poll()) {
            const elapsed = Date.now() - started;
            if (!forced && elapsed >= graceMilliseconds) { await signal('SIGKILL'); forced = true; }
            if (elapsed >= graceMilliseconds + 3000) { throw new Error('ZW3D 退出超时，已停止重新编译运行。'); }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
}

/** Close only an extension-owned child or verified restored host, and wait before rebuilding. */
export async function stopOwnedHost(child: ChildProcess | RestoredHost, graceMilliseconds = 5000): Promise<void> {
    if (child instanceof RestoredHost) { return child.stop(graceMilliseconds); }
    if (child.exitCode !== null || child.signalCode !== null) { return; }
    if (!child.pid) { throw new Error('ZW3D 进程尚未取得 PID。'); }
    return new Promise<void>((resolve, reject) => {
        let forceTimer: NodeJS.Timeout | undefined;
        let exitTimer: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (forceTimer) { clearTimeout(forceTimer); }
            if (exitTimer) { clearTimeout(exitTimer); }
            child.removeListener('exit', exited);
        };
        const exited = () => { cleanup(); resolve(); };
        const signal = (name: NodeJS.Signals) => {
            if (child.exitCode !== null || child.signalCode !== null) { exited(); return; }
            try {
                if (process.platform === 'linux') { process.kill(-child.pid!, name); }
                else { child.kill(name); }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') { exited(); }
                else { cleanup(); reject(error); }
            }
        };
        child.once('exit', exited);
        forceTimer = setTimeout(() => signal('SIGKILL'), graceMilliseconds);
        exitTimer = setTimeout(() => { cleanup(); reject(new Error('ZW3D 退出超时，已停止重新编译运行。')); }, graceMilliseconds + 3000);
        signal('SIGTERM');
    });
}
