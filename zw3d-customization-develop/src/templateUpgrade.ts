import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';

/** Upgrade only the extension's stored default copy; preserve customized file contents. */
export async function upgradeStoredTemplate(stored: string, bundled: string): Promise<void> {
    let manifest: { files: Record<string, string> };
    try { manifest = JSON.parse(await fs.readFile(path.join(stored, 'template.json'), 'utf8')); }
    catch { return; }
    if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) { return; }
    const additions: Record<string, string> = { '.clangd': 'clangd.tpl', '.vscode/extensions.json': 'extensions.json.tpl' };
    let changed = false;
    for (const [destination, source] of Object.entries(additions)) {
        if (Object.hasOwn(manifest.files, destination)) { continue; }
        try { await fs.copyFile(path.join(bundled, source), path.join(stored, source), constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
        manifest.files[destination] = source;
        changed = true;
    }
    const settings = path.join(stored, 'settings.json.tpl');
    try {
        const raw = await fs.readFile(settings, 'utf8');
        const oldDefault = { 'C_Cpp.default.compileCommands': '${workspaceFolder}/build/compile_commands.json', 'files.associations': { '*.tcmd': 'xml' } };
        if (JSON.stringify(JSON.parse(raw)) === JSON.stringify(oldDefault)) {
            await fs.writeFile(settings, await fs.readFile(path.join(bundled, 'settings.json.tpl'), 'utf8'));
        }
    } catch { /* A customized template is never replaced. */ }
    const cmakeFile = path.join(stored, 'CMakeLists.txt.tpl');
    try {
        const current = await fs.readFile(cmakeFile, 'utf8');
        const latest = await fs.readFile(path.join(bundled, 'CMakeLists.txt.tpl'), 'utf8');
        if (current === latest.replace('set(CMAKE_EXPORT_COMPILE_COMMANDS ON)\n', '')) { await fs.writeFile(cmakeFile, latest); }
    } catch { /* Optional custom mapping. */ }
    if (changed) { await fs.writeFile(path.join(stored, 'template.json'), JSON.stringify(manifest, null, 2) + '\n'); }
}
