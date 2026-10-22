const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { syncClangdFiles, clangdSettings } = require('../dist/clangd');
const { upgradeStoredTemplate } = require('../dist/templateUpgrade');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-clangd-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, config: { buildDirectory: 'build', cxxPath: '/compiler with spaces/g++' } };
}

test('root compilation database stays on build_clangd across build profiles and preserves customized configuration', async t => {
  const project = await fixture(t);
  await syncClangdFiles(project, () => {});
  assert.equal(await fs.readlink(path.join(project.root, 'compile_commands.json')), 'build_clangd/compile_commands.json');
  project.config.buildDirectory = 'build-debug';
  await syncClangdFiles(project, () => {});
  assert.equal(await fs.readlink(path.join(project.root, 'compile_commands.json')), 'build_clangd/compile_commands.json');
  await fs.writeFile(path.join(project.root, '.clangd'), '# my configuration\nCompileFlags:\n  Add: [-DMY_FLAG]\n');
  await fs.unlink(path.join(project.root, 'compile_commands.json'));
  await fs.writeFile(path.join(project.root, 'compile_commands.json'), '[{"custom":true}]');
  await syncClangdFiles(project, () => {});
  assert.equal(await fs.readFile(path.join(project.root, 'compile_commands.json'), 'utf8'), '[{"custom":true}]');
  assert.match(await fs.readFile(path.join(project.root, '.clangd'), 'utf8'), /MY_FLAG/);
  const ignore = await fs.readFile(path.join(project.root, '.gitignore'), 'utf8');
  assert.equal(ignore.split('\n').filter(line => line === 'compile_commands.json').length, 1);
});

test('query-driver covers real C and C++ compilers, including paths containing spaces', async t => {
  const project = await fixture(t);
  await syncClangdFiles(project, () => {});
  await fs.mkdir(path.join(project.root, 'build_clangd'));
  await fs.writeFile(path.join(project.root, 'build_clangd/compile_commands.json'), JSON.stringify([
    { command: '"/other compiler/gcc" -c main.c' }, { arguments: ['/usr/bin/gcc', '-c', 'test.c'] },
    { command: '/not-a-compiler/script -c input.c' }
  ]));
  const settings = await clangdSettings(project, '/clangd path/clangd', '/toolchain/gcc');
  const query = settings['clangd.arguments'].find(arg => arg.startsWith('--query-driver'));
  for (const driver of ['/other compiler/gcc', '/usr/bin/gcc', '/compiler with spaces/g++', '/toolchain/gcc']) assert.ok(query.includes(driver));
  assert.ok(!query.includes('not-a-compiler'));
  assert.equal(settings['C_Cpp.intelliSenseEngine'], 'disabled');
  assert.equal(settings['C_Cpp.default.compileCommands'], '${workspaceFolder}/compile_commands.json');
});

test('upgrade the stored default template without overwriting custom settings', async t => {
  const project = await fixture(t);
  const bundled = path.resolve(__dirname, '../templates/default');
  const oldSettings = { 'C_Cpp.default.compileCommands': '${workspaceFolder}/build/compile_commands.json', 'files.associations': { '*.tcmd': 'xml' } };
  await fs.writeFile(path.join(project.root, 'template.json'), JSON.stringify({ files: { '.vscode/settings.json': 'settings.json.tpl' }, directories: ['src'] }));
  await fs.writeFile(path.join(project.root, 'settings.json.tpl'), JSON.stringify(oldSettings));
  await upgradeStoredTemplate(project.root, bundled);
  const manifest = JSON.parse(await fs.readFile(path.join(project.root, 'template.json'), 'utf8'));
  assert.equal(manifest.files['.clangd'], 'clangd.tpl');
  assert.match(await fs.readFile(path.join(project.root, 'settings.json.tpl'), 'utf8'), /CLANGD_PATH_JSON/);
  const customized = '{"mySetting": true}';
  await fs.writeFile(path.join(project.root, 'settings.json.tpl'), customized);
  await upgradeStoredTemplate(project.root, bundled);
  assert.equal(await fs.readFile(path.join(project.root, 'settings.json.tpl'), 'utf8'), customized);
});


test('legacy managed links migrate only after the independent database exists; user links stay intact', async t => {
  const project = await fixture(t);
  const database = path.join(project.root, 'compile_commands.json');
  const state = path.join(project.root, '.zw3d/clangd-state.json');
  await fs.mkdir(path.dirname(state));
  await fs.mkdir(path.join(project.root, 'build_release'));
  await fs.writeFile(path.join(project.root, 'build_release/compile_commands.json'), '[]');
  await fs.symlink('build_release/compile_commands.json', database);
  await fs.writeFile(state, JSON.stringify({ target: 'build_release/compile_commands.json' }));
  await syncClangdFiles(project, () => {});
  assert.equal(await fs.readlink(database), 'build_release/compile_commands.json');
  await fs.mkdir(path.join(project.root, 'build_clangd'));
  await fs.writeFile(path.join(project.root, 'build_clangd/compile_commands.json'), '[]');
  await syncClangdFiles(project, () => {});
  assert.equal(await fs.readlink(database), 'build_clangd/compile_commands.json');
  await fs.unlink(database);
  await fs.symlink('build_release/compile_commands.json', database);
  await syncClangdFiles(project, () => {});
  assert.equal(await fs.readlink(database), 'build_release/compile_commands.json');
});
