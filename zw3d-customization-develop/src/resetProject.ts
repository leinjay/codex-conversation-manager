import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside, Project, readProject, Tools } from './core';
import { connectExistingProject, suggestExistingProject } from './importProject';
import { clangdBuildDirectory } from './clangd';

/** Regenerate the whole .zw3d directory; keep the old directory until setup succeeds. */
export async function resetProjectConfiguration(root: string, overrides: Partial<Tools> = {},
    apply: (project: Project) => Promise<void> = async () => {}, signal?: AbortSignal): Promise<Project> {
    signal?.throwIfAborted();
    const directory = path.join(root, '.zw3d');
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) { throw new Error('.zw3d 必须是当前项目内的实际文件夹，不能是符号链接。'); }
    let buildDirectory = 'build';
    try { buildDirectory = (await readProject(root)).config.buildDirectory; } catch { /* Also allow repair of invalid config. */ }
    // Validate tools, SDK and the new configuration before touching the existing directory.
    const config = await suggestExistingProject(root, overrides, buildDirectory);
    const project = { root, config };
    let managedTarget: string | undefined;
    try {
        const target = (JSON.parse(await fs.readFile(path.join(directory, 'clangd-state.json'), 'utf8')) as { target?: unknown }).target;
        if (typeof target === 'string' && inside(root, target) && await fs.readlink(path.join(root, 'compile_commands.json')) === target) {
            managedTarget = target;
        }
    } catch { /* A user-owned database is left alone. */ }
    signal?.throwIfAborted();
    const backup = path.join(root, `.zw3d-reset-${randomUUID()}`);
    await fs.rename(directory, backup);
    try {
        await connectExistingProject(root, config);
        // Restore ownership, not old project settings, so a changed build folder can retarget the link.
        if (managedTarget) { await fs.writeFile(path.join(directory, 'clangd-state.json'), JSON.stringify({ target: managedTarget }) + '\n'); }
        await apply(project);
        signal?.throwIfAborted();
    } catch (error) {
        if (managedTarget) {
            const database = path.join(root, 'compile_commands.json');
            try {
                if (await fs.readlink(database) === path.join(clangdBuildDirectory, 'compile_commands.json')) {
                    const temporary = `${database}.${randomUUID()}.tmp`;
                    try { await fs.symlink(managedTarget, temporary); await fs.rename(temporary, database); }
                    finally { await fs.rm(temporary, { force: true }); }
                }
            } catch { /* Preserve any independently edited database. */ }
        }
        try {
            await fs.rm(directory, { recursive: true, force: true });
            await fs.rename(backup, directory);
        } catch (restoreError) {
            throw new Error(`重新配置失败且未能自动恢复，旧配置保留在 ${backup}。${String(restoreError)}`, { cause: error });
        }
        throw error;
    }
    await fs.rm(backup, { recursive: true });
    return project;
}
