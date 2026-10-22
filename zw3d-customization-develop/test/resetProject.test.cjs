const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { syncClangdFiles } = require('../dist/clangd');
const { resetProjectConfiguration } = require('../dist/resetProject');

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-reset-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sdk = path.join(parent, 'SDK/files');
  await fs.mkdir(path.join(sdk, 'api/inc'), { recursive: true });
  for (const file of ['libZW3D.so', 'api/inc/zwapi_command.h']) await fs.writeFile(path.join(sdk, file), '');
  const executable = path.join(parent, 'tool');
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const tools = { cmakePath: executable, cxxPath: executable, gdbPath: executable, zw3dRoot: path.dirname(sdk) };
  const project = await core.createProject({ ...tools, parent, projectName: 'ResetDemo', libraryName: 'ResetPlugin', remote: '' }, path.resolve(__dirname, '../templates/default'));
  project.config.buildDirectory = 'custom-build';
  project.config.environment = { OLD_OVERRIDE: 'remove on reset' };
  await fs.writeFile(path.join(project.root, '.zw3d/project.json'), JSON.stringify(project.config));
  await fs.writeFile(path.join(project.root, '.zw3d/old-custom.txt'), 'remove on successful reset');
  await fs.mkdir(path.join(project.root, 'custom-build'));
  await fs.writeFile(path.join(project.root, 'custom-build/CMakeCache.txt'), [
    `CMAKE_HOME_DIRECTORY:INTERNAL=${project.root}`,
    'CMAKE_PROJECT_NAME:STATIC=ResetDemo', 'ZW3D_LIBRARY_NAME:STRING=ResetPlugin',
    'CMAKE_BUILD_TYPE:STRING=RelWithDebInfo', 'CMAKE_TOOLCHAIN_FILE:FILEPATH=/test/toolchain.cmake'
  ].join('\n'));
  await syncClangdFiles(project, () => {});
  return { project, tools, parent };
}

test('regenerate the whole .zw3d directory from the active build cache while preserving sources and database ownership', async t => {
  const { project, tools } = await fixture(t);
  const source = await fs.readFile(path.join(project.root, 'src/main.cpp'), 'utf8');
  const cmake = await fs.readFile(path.join(project.root, 'CMakeLists.txt'), 'utf8');
  const reset = await resetProjectConfiguration(project.root, tools, updated => syncClangdFiles(updated, () => {}));
  assert.equal(reset.config.buildDirectory, 'custom-build');
  assert.equal(reset.config.libraryName, 'ResetPlugin');
  assert.equal(reset.config.buildType, 'RelWithDebInfo');
  assert.equal(reset.config.commandHint, '~ResetDemo');
  assert.deepEqual(reset.config.cmakeArgs, ['-DCMAKE_TOOLCHAIN_FILE=/test/toolchain.cmake']);
  assert.deepEqual(reset.config.environment, {});
  assert.equal(await core.exists(path.join(project.root, '.zw3d/old-custom.txt')), false);
  assert.equal(await fs.readlink(path.join(project.root, 'compile_commands.json')), 'build_clangd/compile_commands.json');
  assert.equal(await fs.readFile(path.join(project.root, 'src/main.cpp'), 'utf8'), source);
  assert.equal(await fs.readFile(path.join(project.root, 'CMakeLists.txt'), 'utf8'), cmake);
  assert.equal((await fs.readdir(project.root)).some(name => name.startsWith('.zw3d-reset-')), false);
});

test('failed application or cancellation restores original config and files, and invalid tool detection leaves them untouched', async t => {
  const { project, tools } = await fixture(t);
  const original = await fs.readFile(path.join(project.root, '.zw3d/project.json'), 'utf8');
  await assert.rejects(resetProjectConfiguration(project.root, tools, async () => { throw new Error('CMake configure failed'); }), /CMake configure failed/);
  assert.equal(await fs.readFile(path.join(project.root, '.zw3d/project.json'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(project.root, '.zw3d/old-custom.txt'), 'utf8'), 'remove on successful reset');
  const abort = new AbortController();
  await assert.rejects(resetProjectConfiguration(project.root, tools, async () => { abort.abort(); }, abort.signal));
  assert.equal(await fs.readFile(path.join(project.root, '.zw3d/project.json'), 'utf8'), original);
  await assert.rejects(resetProjectConfiguration(project.root, { ...tools, cmakePath: '/not/a/cmake' }), /有效的 CMake/);
  assert.equal(await fs.readFile(path.join(project.root, '.zw3d/project.json'), 'utf8'), original);
  assert.equal((await fs.readdir(project.root)).some(name => name.startsWith('.zw3d-reset-')), false);
});

test('reject a symlinked .zw3d directory without touching its destination', async t => {
  const { project, tools, parent } = await fixture(t);
  const external = path.join(parent, 'external-config');
  await fs.rename(path.join(project.root, '.zw3d'), external);
  const original = await fs.readFile(path.join(external, 'project.json'), 'utf8');
  await fs.symlink(external, path.join(project.root, '.zw3d'));
  await assert.rejects(resetProjectConfiguration(project.root, tools), /不能是符号链接/);
  assert.equal(await fs.readFile(path.join(external, 'project.json'), 'utf8'), original);
});

test('failed project reset restores the legacy managed link after migration to build_clangd', async t => {
  const { project, tools } = await fixture(t);
  const link = path.join(project.root, 'compile_commands.json');
  await fs.unlink(link);
  await fs.symlink('custom-build/compile_commands.json', link);
  await fs.writeFile(path.join(project.root, '.zw3d/clangd-state.json'), JSON.stringify({ target: 'custom-build/compile_commands.json' }));
  await fs.mkdir(path.join(project.root, 'build_clangd'));
  await fs.writeFile(path.join(project.root, 'build_clangd/compile_commands.json'), '[]');
  await assert.rejects(resetProjectConfiguration(project.root, tools, async updated => {
    await syncClangdFiles(updated, () => {});
    assert.equal(await fs.readlink(link), 'build_clangd/compile_commands.json');
    throw new Error('settings failed');
  }), /settings failed/);
  assert.equal(await fs.readlink(link), 'custom-build/compile_commands.json');
  assert.equal(JSON.parse(await fs.readFile(path.join(project.root, '.zw3d/clangd-state.json'), 'utf8')).target, 'custom-build/compile_commands.json');
});
