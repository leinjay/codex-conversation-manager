import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exists, ProjectConfig, Tools } from './core';
import { connectExistingProject, suggestExistingProject } from './importProject';

export interface ProjectDetection { isZW3D: boolean; reasons: string[] }
export interface InitializationResult extends ProjectDetection {
    state: 'existing' | 'unrecognized' | 'initialized';
    config?: ProjectConfig;
}

function cmakeCode(text: string): string {
    return text.replace(/#\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/#[^\n]*/g, '');
}
function sourceCode(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Bounded static inspection; never configure/build or execute project code. */
export async function detectZW3DProject(root: string): Promise<ProjectDetection> {
    if (!await exists(path.join(root, 'CMakeLists.txt'))) { return { isZW3D: false, reasons: [] }; }
    const cmake: string[] = [];
    let sdkHeader = false;
    let scannedFiles = 0;
    let scannedEntries = 0;
    let scannedBytes = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name === 'CMakeLists.txt' ? -1 : b.name === 'CMakeLists.txt' ? 1 : a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (++scannedEntries > 2000 || scannedFiles >= 256 || scannedBytes >= 4 * 1024 * 1024) { return; }
            if (entry.isSymbolicLink()) { continue; }
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (depth < 5 && !/^(?:\..*|build.*|node_modules|vendor|third.party|external|out|dist)$/i.test(entry.name)
                    && (depth > 0 || /^(?:src|source|sources|include|inc|cmake|lib)$/i.test(entry.name))) {
                    await walk(file, depth + 1);
                }
                continue;
            }
            const isCmake = entry.name === 'CMakeLists.txt' || /\.cmake$/i.test(entry.name);
            if (!entry.isFile() || (!isCmake && !/\.(?:c|cc|cpp|cxx|h|hpp|hxx)$/i.test(entry.name))) { continue; }
            const stat = await fs.stat(file);
            if (stat.size > 256 * 1024) { continue; }
            scannedFiles++; scannedBytes += stat.size;
            const text = await fs.readFile(file, 'utf8');
            if (isCmake) { cmake.push(cmakeCode(text)); }
            else if (/^\s*#\s*include\s*[<"](?:[^">]*\/)?(?:zwapi_[\w]+|vxapi)\.h[">]/im.test(sourceCode(text))) {
                sdkHeader = true;
            }
        }
    };
    await walk(root, 0);
    const build = cmake.join('\n');
    const shared = /\badd_library\s*\([^)]*\b(?:SHARED|MODULE)\b/i.test(build);
    const sdkLibrary = /\blibZW3D(?:_[\w]+)?\.so\b|\bZW3D\.lib\b/i.test(build)
        || /\btarget_link_libraries\s*\([^)]*\bZW3D\b/i.test(build);
    const sdkIncludes = /\b(?:zwapi_[\w]+\.h|api\/inc)\b/i.test(build) && /\bZW3D_(?:ROOT|FILES|SDK)\b/i.test(build);
    const reasons: string[] = [];
    if (shared) { reasons.push('CMake 动态库目标'); }
    if (sdkHeader) { reasons.push('源码包含中望 SDK 头文件'); }
    if (sdkLibrary) { reasons.push('CMake 引用中望 SDK 库'); }
    if (sdkIncludes) { reasons.push('中望 SDK 头文件路径'); }
    return { isZW3D: shared && (sdkHeader || sdkLibrary || sdkIncludes), reasons };
}

export async function initializeDetectedProject(root: string, overrides: Partial<Tools> = {}): Promise<InitializationResult> {
    // Even an invalid existing configuration belongs to the user; never replace it.
    if (await exists(path.join(root, '.zw3d/project.json'))) { return { state: 'existing', isZW3D: true, reasons: [] }; }
    const detection = await detectZW3DProject(root);
    if (!detection.isZW3D) { return { ...detection, state: 'unrecognized' }; }
    const config = await suggestExistingProject(root, overrides);
    try { await connectExistingProject(root, config); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') { return { ...detection, state: 'existing' }; }
        throw error;
    }
    return { ...detection, state: 'initialized', config };
}
