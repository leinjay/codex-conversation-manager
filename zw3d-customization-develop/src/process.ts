import { spawn } from 'node:child_process';

export type Log = (message: string) => void;

export async function runProcess(command: string, args: string[], options: {
    cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; log?: Log; label?: string;
} = {}): Promise<string> {
    options.signal?.throwIfAborted();
    options.log?.(`> ${options.label ?? [command, ...args].map(a => JSON.stringify(a)).join(' ')}`);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd, env: options.env ?? process.env,
            shell: false, detached: process.platform === 'linux', stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        const collect = (chunk: Buffer) => {
            const message = chunk.toString();
            output = (output + message).slice(-128_000);
            options.log?.(message);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        let killTimer: NodeJS.Timeout | undefined;
        const killGroup = (signal: NodeJS.Signals) => {
            try {
                if (process.platform === 'linux' && child.pid) { process.kill(-child.pid, signal); }
                else { child.kill(signal); }
            } catch { /* Process already exited. */ }
        };
        const abort = () => {
            killGroup('SIGTERM');
            killTimer = setTimeout(() => killGroup('SIGKILL'), 1500);
            killTimer.unref();
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); }
        const clean = () => {
            options.signal?.removeEventListener('abort', abort);
            if (killTimer) { clearTimeout(killTimer); }
        };
        child.once('error', error => { clean(); reject(error); });
        child.once('close', (code, signal) => {
            clean();
            if (options.signal?.aborted) { reject(new Error('操作已取消。')); }
            else if (code === 0) { resolve(output); }
            else { reject(new Error(`${options.label ?? command} 失败（${code ?? signal}）。\n${output.slice(-6000)}`)); }
        });
    });
}
