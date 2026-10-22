import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCommands, buildDirectories, exists, inside, Project } from './core';
import { Log, runProcess } from './process';
import { clangdBuildDirectory } from './clangd';

export function sourceCandidate(project: Project, file: string): boolean {
    const relative = path.relative(project.root, file);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !/\.(?:c|cc|cpp|cxx|c\+\+|m|mm)$/i.test(file)) { return false; }
    const build = path.relative(project.root, inside(project.root, project.config.buildDirectory));
    return ![build, clangdBuildDirectory, ...Object.values(buildDirectories)].some(dir => relative === dir || relative.startsWith(dir + path.sep))
        && !relative.split(path.sep).some(part => part.startsWith('.') || ['node_modules', 'CMakeFiles'].includes(part));
}

function quoted(value: string): string {
    let separator = '=';
    while (value.includes(']' + separator + ']')) { separator += '='; }
    return '[' + separator + '[' + value + ']' + separator + ']';
}

// Preserve effective user cache options (including toolchains and conditional sources),
// without copying CMake's internal paths or writing into the real build directory.
async function probeArguments(project: Project, temporary: string): Promise<string[]> {
    const build = inside(project.root, project.config.buildDirectory);
    const cacheFile = path.join(build, 'CMakeCache.txt');
    const args = buildCommands(project)[0];
    args[args.indexOf('-B') + 1] = temporary;
    if (!await exists(cacheFile)) { return args; }
    const cache = await fs.readFile(cacheFile, 'utf8');
    const preload: string[] = [];
    for (const line of cache.split(/\r?\n/)) {
        const entry = /^([^/#][^:]*):(BOOL|FILEPATH|PATH|STRING|UNINITIALIZED)=(.*)$/.exec(line);
        if (!entry) { continue; }
        const [, key, type, value] = entry;
        preload.push(`set(${quoted(key)} ${quoted(value.split(build).join(temporary))} CACHE ${type === 'UNINITIALIZED' ? 'STRING' : type} "" FORCE)`);
    }
    const initial = path.join(temporary, 'zw3d-cache.cmake');
    await fs.writeFile(initial, preload.join('\n'));
    args.unshift('-C', initial);
    const generator = /^CMAKE_GENERATOR:INTERNAL=(.+)$/m.exec(cache)?.[1].trim();
    if (generator) { args.push('-G', generator); }
    return args;
}

interface Target {
    id: string; type: string;
    artifacts?: { path: string }[];
    dependencies?: { id: string }[];
    sources?: { path: string; compileGroupIndex?: number; isGenerated?: boolean }[];
}

// Use evaluated CMake targets, rather than inferring membership from a filename or GLOB text.
async function pluginSources(project: Project, build: string): Promise<Set<string>> {
    const reply = path.join(build, '.cmake/api/v1/reply');
    const indexes = (await fs.readdir(reply)).filter(name => /^index-.*\.json$/.test(name)).sort();
    const index = JSON.parse(await fs.readFile(path.join(reply, indexes.at(-1)!), 'utf8'));
    const object = index.objects?.find((item: { kind: string }) => item.kind === 'codemodel');
    if (!object) { throw new Error('CMake 未返回 codemodel，无法确认新文件是否参与插件构建。'); }
    const model = JSON.parse(await fs.readFile(path.join(reply, object.jsonFile), 'utf8'));
    const configuration = model.configurations.find((item: { name: string }) => item.name === project.config.buildType)
        ?? model.configurations.find((item: { name: string }) => !item.name);
    if (!configuration) { throw new Error('CMake 未返回当前构建类型的目标信息。'); }
    const targets = new Map<string, Target>();
    for (const ref of configuration.targets) {
        const target: Target = JSON.parse(await fs.readFile(path.join(reply, ref.jsonFile), 'utf8'));
        targets.set(target.id, target);
    }
    const roots = [...targets.values()].filter(target => ['SHARED_LIBRARY', 'MODULE_LIBRARY'].includes(target.type)
        && target.artifacts?.some(artifact => path.basename(artifact.path) === project.config.libraryName + '.so'));
    if (roots.length !== 1) { throw new Error(`无法唯一确定 ${project.config.libraryName}.so 对应的 CMake 插件目标，未更新正式数据库。`); }
    const visited = new Set<string>();
    const result = new Set<string>();
    const visit = (target: Target): void => {
        if (visited.has(target.id)) { return; }
        visited.add(target.id);
        for (const source of target.sources ?? []) {
            if (source.compileGroupIndex !== undefined && !source.isGenerated) { result.add(path.resolve(model.paths.source, source.path)); }
        }
        for (const dependency of target.dependencies ?? []) {
            const child = targets.get(dependency.id);
            if (child) { visit(child); }
        }
    };
    visit(roots[0]);
    return result;
}

export async function participatingNewSources(project: Project, files: readonly string[], log: Log, signal?: AbortSignal): Promise<string[]> {
    const candidates: string[] = [];
    const database = path.join(inside(project.root, project.config.buildDirectory), 'compile_commands.json');
    let known = new Set<string>();
    if (await exists(database)) {
        const entries: { directory: string; file: string }[] = JSON.parse(await fs.readFile(database, 'utf8'));
        known = new Set(entries.map(entry => path.resolve(entry.directory, entry.file)));
    }
    for (const file of files) {
        if (sourceCandidate(project, file) && !known.has(file) && await exists(file)) { candidates.push(file); }
    }
    if (!candidates.length) { return []; }
    signal?.throwIfAborted();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-source-probe-'));
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 60_000);
    try {
        if (signal?.aborted) { abort.abort(); }
        const query = path.join(temporary, '.cmake/api/v1/query');
        await fs.mkdir(query, { recursive: true });
        await fs.writeFile(path.join(query, 'codemodel-v2'), '');
        await runProcess(project.config.cmakePath, await probeArguments(project, temporary), {
            cwd: project.root, signal: abort.signal, log, label: 'CMake 临时配置：检查新增源码的目标归属（不编译）'
        });
        const sources = await pluginSources(project, temporary);
        const matched = candidates.filter(file => sources.has(file));
        for (const file of candidates) { log(`${matched.includes(file) ? '参与插件构建' : '未纳入插件构建，保留正式数据库'}：${path.relative(project.root, file)}`); }
        return matched;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
