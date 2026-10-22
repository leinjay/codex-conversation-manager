import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectConfig } from './core';

export interface ResourceFile { file: string; text: string }
export interface UiCandidate {
    file: string; relative: string; score: number; reasons: string[]; warnings: string[];
    commands: string[]; libraries: string[];
}
export interface UiContext {
    root?: string; file: string; isDirectory: boolean; candidates: UiCandidate[];
    libraries: string[]; commands: string[]; truncated?: boolean;
}
const sourcePattern = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;
const stem = (file: string) => path.basename(file, path.extname(file));
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const xml = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '');
const decode = (text: string) => text.replace(/&(?:amp|quot|apos|lt|gt);/g, value => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[value]!);
const attr = (tag: string, name: string) => decode(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2] ?? '');
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function source(text: string): string {
    // Preserve string literals (including command names); discard comments only.
    return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        token => token.startsWith('/') ? ' ' : token);
}
function strings(text: string): Map<string, string> {
    const values = new Map<string, string>();
    for (const match of text.matchAll(/\b([A-Za-z_]\w*)\s*(?:\[\s*\])?\s*=\s*"([!~]?[A-Za-z_]\w*)"/g)) { values.set(match[1], match[2]); }
    return values;
}
function argument(value: string, variables: Map<string, string>): string {
    return /^"([!~]?[A-Za-z_]\w*)"$/.exec(value.trim())?.[1] ?? variables.get(value.trim()) ?? '';
}
function registered(text: string): string[] {
    const variables = strings(text);
    return unique([...text.matchAll(/\b(?:ZwCommandFunctionLoad|cvxCmdFunc)\s*\(\s*("[^"\n]+"|\w+)\s*,/g)]
        .map(match => argument(match[1], variables)).filter(name => identifierPattern.test(name)).map(name => '~' + name));
}
function commandTemplates(files: ResourceFile[]) {
    return files.filter(item => /\.tcmd$/i.test(item.file)).flatMap(item => {
        const clean = xml(item.text);
        return [...clean.matchAll(/<template\b([^>]*?)(?:\/>|>([\s\S]*?)<\/template\s*>)/gi)].map(match => ({
            file: item.file, name: attr(match[1], 'name'),
            callbacks: unique([...(match[2] ?? '').matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property\s*>/gi)]
                .filter(property => ['custom', 'init', 'exit', 'callback'].includes(attr(property[1], 'name')))
                .map(property => decode(property[2].trim()).replace(/\.(?:c|cpp|cc|cxx)$/i, '')).filter(name => identifierPattern.test(name)))
        })).filter(item => identifierPattern.test(item.name));
    });
}
function formCallbacks(text: string): string[] {
    return [...xml(text).matchAll(/<property\b([^>]*)>([\s\S]*?)<\/property>/gi)]
        .filter(match => attr(match[1], 'name') === 'functionName')
        .map(match => decode(/<string\b[^>]*>([^<]*)<\/string>/i.exec(match[2])?.[1] ?? ''));
}

/** Project-wide hints from definitions, not commands merely mentioned/sent by source. */
export function inferProjectCommands(files: ResourceFile[], root: string): string[] {
    const projectFiles = files.filter(item => !path.relative(root, item.file).split(path.sep)
        .some(part => /^(?:tests?|examples?|samples?)$/i.test(part)));
    const templates = commandTemplates(projectFiles);
    const callbacks = new Set([...templates.flatMap(item => item.callbacks),
        ...projectFiles.filter(item => /\.ui$/i.test(item.file)).flatMap(item => formCallbacks(item.text))]);
    const commands = projectFiles.filter(item => sourcePattern.test(item.file))
        .flatMap(item => registered(source(item.text))).filter(command => !callbacks.has(command.slice(1)));
    return unique([...templates.map(item => '!' + item.name), ...commands])
        .sort((a, b) => a[0] === b[0] ? a.localeCompare(b, 'en') : a.startsWith('!') ? -1 : 1);
}
function references(text: string): string[] {
    const variables = strings(text);
    return unique([...text.matchAll(/\b(?:ZwCommandSend|cvxCmdSend|cvxFormCreate|cvxFormShow|cvxFormState|cvxFormKill|ZwUiFormCreate|ZwUiFormShow)\s*\(\s*("[^"\n]+"|\w+)/g)]
        .map(match => argument(match[1], variables)).filter(Boolean).map(name => name.replace(/^[!~]/, '')));
}
function namesIn(text: string, names: string[]): boolean {
    const tokens = new Set(text.match(/[A-Za-z_]\w*/g) ?? []);
    return names.some(name => tokens.has(name));
}
function within(root: string, file: string): boolean { const relative = path.relative(root, file); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }

/** Bounded read-only scan. No CMake/project code is executed to infer UI associations. */
export async function scanUiResources(root: string, buildDirectory = 'build'): Promise<{ files: ResourceFile[]; truncated: boolean }> {
    const files: ResourceFile[] = [];
    let count = 0; let bytes = 0; let truncated = false;
    const build = path.resolve(root, buildDirectory);
    const visit = async (directory: string, depth: number): Promise<void> => {
        if (depth > 8 || count > 5000 || files.length >= 512 || bytes >= 8 * 1024 * 1024) { truncated = true; return; }
        try {
            const entries = await fs.readdir(directory, { withFileTypes: true });
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (++count > 5000) { truncated = true; return; }
                const file = path.join(directory, entry.name);
                if (entry.name.startsWith('.') || entry.isSymbolicLink() || within(build, file)) { continue; }
                if (entry.isDirectory()) {
                    if (!/^(?:build(?:[-_].*)?|cmake-build-.*|CMakeFiles|node_modules|dist|vendor|third_party|external|deps|_deps)$/i.test(entry.name)) { await visit(file, depth + 1); }
                } else if (entry.isFile() && (/\.(?:ui|tcmd|cmake)$/i.test(entry.name) || entry.name === 'CMakeLists.txt' || sourcePattern.test(entry.name))) {
                    const size = (await fs.stat(file)).size;
                    if (size > 512 * 1024 || bytes + size > 8 * 1024 * 1024 || files.length >= 512) { truncated = true; continue; }
                    files.push({ file, text: await fs.readFile(file, 'utf8') }); bytes += size;
                }
            }
        } catch { /* Unreadable or concurrently removed directory. */ }
    };
    await visit(root, 0);
    return { files, truncated };
}

function cmakeLibraries(files: ResourceFile[], config?: ProjectConfig): string[] {
    if (config) { return [config.libraryName + '.so']; }
    const result: string[] = [];
    for (const file of files.filter(item => path.basename(item.file) === 'CMakeLists.txt')) {
        let text = file.text.replace(/#[^\n]*/g, '');
        const project = /\bproject\(\s*"?([A-Za-z_]\w*)/i.exec(text)?.[1];
        if (project) { text = text.replace(/\$\{(?:PROJECT_NAME|CMAKE_PROJECT_NAME)\}/g, project); }
        for (const match of text.matchAll(/\badd_library\(\s*"?([A-Za-z_]\w*)"?\s+(?:SHARED|MODULE)\b/gi)) {
            const target = match[1];
            const properties = [...text.matchAll(/\bset_target_properties\(\s*([^)]*)\)/gi)]
                .filter(item => item[1].split(/\bPROPERTIES\b/i)[0].split(/\s+/).includes(target)).map(item => item[1]).join('\n');
            const output = /\bOUTPUT_NAME\s+"?([A-Za-z_]\w*)/.exec(properties)?.[1] ?? target;
            const prefix = /\bPREFIX\s+"([^"]*)"/.exec(properties)?.[1] ?? 'lib';
            result.push(prefix + output + '.so');
        }
    }
    return unique(result);
}

export function inferUiContext(root: string, active: string, isDirectory: boolean, files: ResourceFile[], config?: ProjectConfig): UiContext {
    const activeFile = files.find(item => item.file === active);
    const activeText = activeFile ? sourcePattern.test(active) ? source(activeFile.text) : xml(activeFile.text) : '';
    const sources = files.filter(item => sourcePattern.test(item.file)).map(item => ({ ...item, text: source(item.text) }));
    const templates = commandTemplates(files);
    const libraries = cmakeLibraries(files, config);
    const candidates: UiCandidate[] = [];
    for (const ui of files.filter(item => /\.ui$/i.test(item.file))) {
        const text = xml(ui.text);
        const widget = /<widget\b([^>]*)>/i.exec(text)?.[1] ?? '';
        const formName = attr(widget, 'name');
        const uiClass = decode(/<class\s*>([^<]+)<\/class>/i.exec(text)?.[1]?.trim() ?? '');
        const functionName = formCallbacks(text);
        const names = unique([stem(ui.file), formName, uiClass, ...functionName]).filter(name => identifierPattern.test(name));
        const linkedTemplates = templates.filter(template => names.includes(template.name) || stem(template.file) === stem(ui.file));
        const callbackNames = unique(linkedTemplates.flatMap(template => template.callbacks));
        const linkedSources = sources.filter(item => namesIn(item.text, [...names, ...callbackNames]) || names.includes(stem(item.file)));
        const reasons: string[] = []; let score = 0;
        const add = (weight: number, reason: string): void => { score += weight; reasons.push(reason); };
        if (active === ui.file) { add(1000, '当前文件就是 UI'); }
        if (linkedTemplates.some(template => template.file === active)) { add(900, '当前命令模板对应此 Form'); }
        if (references(activeText).some(name => names.includes(name))) { add(800, '源码命令/Form API 直接引用'); }
        if (!isDirectory && names.includes(stem(active))) { add(600, '文件名与 Form 名一致'); }
        if (sourcePattern.test(active) && namesIn(activeText, callbackNames)) { add(700, '源码注册了模板回调'); }
        if (sourcePattern.test(active) && namesIn(activeText, names)) { add(450, '源码含相同 Form 标识'); }
        const scope = isDirectory ? active : path.dirname(active);
        if (within(scope, ui.file)) { add(100, isDirectory ? '所选目录内的 UI' : '当前文件所在目录内的 UI'); }
        else if (!score) { add(10, '同工程候选，尚无直接绑定证据'); }
        // Stable path proximity is a tie-breaker, never stronger than a semantic relation.
        const distance = path.relative(scope, path.dirname(ui.file)).split(path.sep).filter(Boolean).length;
        score += Math.max(0, 8 - distance);
        const warnings: string[] = [];
        if (attr(widget, 'class') === 'ZsCc::Form' && formName && formName !== stem(ui.file)) { warnings.push('UI 文件名与顶层 Form name 不一致'); }
        for (const template of linkedTemplates) {
            if (stem(template.file) !== template.name || stem(ui.file) !== template.name || formName !== template.name) {
                warnings.push(`${path.basename(template.file)} 的模板名、UI 文件名或 Form name 不一致`);
            }
        }
        const commands = unique([...linkedTemplates.map(template => '!' + template.name),
            ...linkedSources.flatMap(item => registered(item.text)).filter(command => ![...callbackNames, ...functionName].includes(command.slice(1)))]);
        candidates.push({ file: ui.file, relative: path.relative(root, ui.file), score, reasons, warnings: unique(warnings), commands, libraries });
    }
    candidates.sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));
    return { root, file: active, isDirectory, candidates, libraries,
        commands: unique([...registered(activeText), ...(config?.commandHint ? [config.commandHint] : [])]) };
}
