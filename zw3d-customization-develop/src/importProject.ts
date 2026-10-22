import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildDirectories, detectTools, exists, identifier, inside, ProjectConfig, Tools, validateConfig, zw3dFiles } from './core';

/** Read only: obtain editable defaults without changing the existing CMake project. */
export async function suggestExistingProject(root: string, overrides: Partial<Tools> = {}, buildDirectory?: string): Promise<ProjectConfig> {
    if (!buildDirectory) {
        for (const directory of [buildDirectories.Debug, buildDirectories.Release, 'build']) {
            if (await exists(path.join(root, directory, 'CMakeCache.txt'))) { buildDirectory = directory; break; }
        }
        buildDirectory ??= buildDirectories.Debug;
    }
    const cmake = (await fs.readFile(path.join(root, 'CMakeLists.txt'), 'utf8')).replace(/#[^\n]*/g, '');
    const cache: Record<string, string> = {};
    try {
        const text = await fs.readFile(path.join(inside(root, buildDirectory), 'CMakeCache.txt'), 'utf8');
        for (const line of text.split('\n')) {
            const match = /^([^#/:][^:]*):[^=]+=(.*)$/.exec(line);
            if (match) { cache[match[1]] = match[2].trim(); }
        }
    } catch { /* A first build has no cache. */ }
    const movedCache = Boolean(cache.CMAKE_HOME_DIRECTORY && path.resolve(cache.CMAKE_HOME_DIRECTORY) !== path.resolve(root));
    if (movedCache) { for (const key of Object.keys(cache)) { delete cache[key]; } }
    const tools = await detectTools({
        cmakePath: overrides.cmakePath || cache.CMAKE_COMMAND,
        cxxPath: overrides.cxxPath || cache.CMAKE_CXX_COMPILER,
        gdbPath: overrides.gdbPath,
        zw3dRoot: overrides.zw3dRoot || cache.ZW3D_ROOT
            || /\bset\(\s*ZW3D_ROOT\s+"([^"$]+)"/i.exec(cmake)?.[1]
    });
    if (!tools.cmakePath || !tools.cxxPath || !tools.zw3dRoot) {
        throw new Error('请先在 ZW3D 设置中指定有效的 CMake、g++ 和安装位置，然后重新接入。');
    }
    const files = await zw3dFiles(tools.zw3dRoot);
    const fallback = path.basename(root).replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]*/, '') || 'ZW3DPlugin';
    const projectName = identifier(cache.CMAKE_PROJECT_NAME || /\bproject\(\s*"?([A-Za-z][A-Za-z0-9_]*)["\s)]/i.exec(cmake)?.[1] || fallback, '项目名称');
    const libraryName = identifier(cache.ZW3D_LIBRARY_NAME || /\bOUTPUT_NAME\s+"?([A-Za-z][A-Za-z0-9_]*)["\s)]/i.exec(cmake)?.[1]
        || /\badd_library\(\s*"?([A-Za-z][A-Za-z0-9_]*)"?\s+SHARED\b/i.exec(cmake)?.[1] || projectName, '动态库名称');
    let commandHint = '';
    const commandFile = path.join(root, 'resources/commands', libraryName + '.tcmd');
    if (await exists(commandFile)) {
        const text = await fs.readFile(commandFile, 'utf8');
        const name = /<template\s+name="([A-Za-z][A-Za-z0-9_]*)"/.exec(text)?.[1];
        if (name) { commandHint = '!' + name; }
    }
    if (!commandHint) {
        for (const file of ['src/main.cpp', 'src/main.c']) {
            try {
                const source = await fs.readFile(path.join(root, file), 'utf8');
                const command = /\bZwCommandFunctionLoad\(\s*"([A-Za-z][A-Za-z0-9_]*)"/.exec(source)?.[1];
                if (command) { commandHint = '~' + command; break; }
            } catch { /* Existing projects can have other entry-point filenames. */ }
        }
    }
    const cmakeArgs = cache.CMAKE_TOOLCHAIN_FILE ? [`-DCMAKE_TOOLCHAIN_FILE=${cache.CMAKE_TOOLCHAIN_FILE}`] : [];
    return validateConfig({
        version: 1, projectName, libraryName, ...tools,
        buildDirectory: movedCache ? 'build-zw3d' : buildDirectory,
        buildType: ['Debug', 'RelWithDebInfo', 'Release'].includes(cache.CMAKE_BUILD_TYPE) ? cache.CMAKE_BUILD_TYPE : 'Debug',
        executable: path.join(files, 'zw3d'), apilibs: path.join(files, 'apilibs'),
        args: [], environment: {}, cmakeArgs, commandHint
    }, root);
}

/** Only the extension config is added. Existing files and Git history are preserved. */
export async function connectExistingProject(root: string, config: ProjectConfig): Promise<void> {
    validateConfig(config, root);
    if (!await exists(path.join(root, 'CMakeLists.txt'))) { throw new Error('所选目录不包含 CMakeLists.txt。'); }
    await fs.mkdir(path.join(root, '.zw3d'), { recursive: true });
    await fs.writeFile(path.join(root, '.zw3d/project.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
}
