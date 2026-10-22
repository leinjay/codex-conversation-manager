const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findExecutable, buildCommands } = require('../dist/core');
const { runProcess } = require('../dist/process');
const { participatingNewSources, sourceCandidate } = require('../dist/compileCommands');

async function fixture(t) {
  const cmake = await findExecutable('cmake');
  const cxx = await findExecutable('g++');
  if (!cmake || !cxx) { t.skip('CMake and an existing g++ are required'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d source membership '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['src', 'helper', 'tests']) await fs.mkdir(path.join(root, dir));
  for (const file of ['src/main.cpp', 'helper/main.cpp', 'tests/main.cpp']) await fs.writeFile(path.join(root, file), 'int main() { return 0; }\n');
  const cmakeText = `cmake_minimum_required(VERSION 3.16)
project(Example LANGUAGES C CXX)
file(GLOB_RECURSE sources CONFIGURE_DEPENDS src/*.cpp src/*.c)
file(GLOB helpers CONFIGURE_DEPENDS helper/*.cpp)
file(GLOB tests CONFIGURE_DEPENDS tests/*.cpp)
add_library(Helper STATIC \${helpers})
add_library(PluginTarget SHARED \${sources})
target_link_libraries(PluginTarget PRIVATE Helper)
set_target_properties(PluginTarget PROPERTIES PREFIX "" OUTPUT_NAME PluginOutput)
add_executable(IndependentTests \${tests})
option(EXTRA_ENABLED "Use extra source" OFF)
if(EXTRA_ENABLED)
  target_sources(PluginTarget PRIVATE deferred.cpp)
endif()
`;
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), cmakeText);
  const project = { root, config: {
    cmakePath: cmake, cxxPath: cxx, buildDirectory: 'build', cmakeArgs: [],
    projectName: 'Example', libraryName: 'PluginOutput', buildType: 'Debug', zw3dRoot: root
  } };
  await runProcess(cmake, buildCommands(project)[0], { cwd: root });
  return { project, cmakeText, database: path.join(root, 'build/compile_commands.json') };
}

test('CMake target membership includes glob sources and linked libraries, excludes unrelated/test/header/generated files, and leaves the real database untouched', async t => {
  const f = await fixture(t); if (!f) return;
  const { project, database } = f;
  const before = await fs.readFile(database, 'utf8');
  const stamp = (await fs.stat(database)).mtimeMs;
  const names = ['src/new.cpp', 'src/new.c', 'helper/new.cpp', 'tests/new.cpp', 'unused.cpp', 'src/header.h', 'build/generated.cpp', 'build_release/generated.cpp', 'build_debug/generated.cpp', 'build_clangd/generated.cpp'];
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(project.root, name)), { recursive: true });
    await fs.writeFile(path.join(project.root, name), '// new file\n');
  }
  for (const directory of ['build_release', 'build_debug', 'build_clangd']) assert.equal(sourceCandidate(project, path.join(project.root, directory, 'generated.cpp')), false);
  const files = names.map(name => path.join(project.root, name));
  const matched = await participatingNewSources(project, files, () => {});
  assert.deepEqual(matched.sort(), files.slice(0, 3).sort());
  assert.equal(sourceCandidate(project, path.join(project.root, '../outside.cpp')), false);
  assert.equal(sourceCandidate(project, path.join(project.root, '.git/inside.cpp')), false);
  assert.equal(await fs.readFile(database, 'utf8'), before);
  assert.equal((await fs.stat(database)).mtimeMs, stamp);
  assert.deepEqual(await participatingNewSources(project, [path.join(project.root, 'src/main.cpp')], () => {}), []);
});

test('a new explicit source is recognized only after adding it to CMake, and cached conditional options are preserved', async t => {
  const f = await fixture(t); if (!f) return;
  const { project, cmakeText, database } = f;
  const file = path.join(project.root, 'deferred.cpp');
  await fs.writeFile(file, '// conditionally included source\n');
  assert.deepEqual(await participatingNewSources(project, [file], () => {}), []);
  // Set a cache-only value; it is deliberately absent from project.cmakeArgs.
  await runProcess(project.config.cmakePath, [...buildCommands(project)[0], '-DEXTRA_ENABLED=ON'], { cwd: project.root });
  // Remove only its database entry to simulate a newly created, not-yet-exported source.
  const entries = JSON.parse(await fs.readFile(database, 'utf8')).filter(entry => path.resolve(entry.directory, entry.file) !== file);
  await fs.writeFile(database, JSON.stringify(entries));
  assert.deepEqual(await participatingNewSources(project, [file], () => {}), [file]);
  const explicit = path.join(project.root, 'explicit.cpp');
  await fs.writeFile(explicit, '// explicit source\n');
  assert.deepEqual(await participatingNewSources(project, [explicit], () => {}), []);
  await fs.writeFile(path.join(project.root, 'CMakeLists.txt'), cmakeText + '\ntarget_sources(PluginTarget PRIVATE explicit.cpp)\n');
  assert.deepEqual(await participatingNewSources(project, [explicit], () => {}), [explicit]);
});

test('failed or cancelled membership probes clean up temporary build directories and preserve the real database', async t => {
  const f = await fixture(t); if (!f) return;
  const { project, database } = f;
  const before = await fs.readFile(database, 'utf8');
  const initial = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('zw3d-source-probe-')));
  const file = path.join(project.root, 'src/new.cpp');
  await fs.writeFile(file, '// new file');
  await fs.appendFile(path.join(project.root, 'CMakeLists.txt'), '\nmessage(FATAL_ERROR "probe failure")\n');
  await assert.rejects(participatingNewSources(project, [file], () => {}), /probe failure/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(participatingNewSources(project, [file], () => {}, controller.signal));
  assert.equal(await fs.readFile(database, 'utf8'), before);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('zw3d-source-probe-') && !initial.has(name)), []);
});


test('dedicated clangd configuration stays in Debug, does not compile, survives profile builds and refreshes only on request', async t => {
  const f = await fixture(t); if (!f) return;
  const core = require('../dist/core');
  const { clangdProject } = require('../dist/clangd');
  const active = core.withBuildProfile(f.project, 'Release');
  const snapshot = JSON.stringify(active);
  await core.configureClangdDatabase(active, () => {}, undefined, false);
  assert.equal(JSON.stringify(active), snapshot);
  const navigation = clangdProject(active);
  const directory = path.join(active.root, 'build_clangd');
  const database = path.join(directory, 'compile_commands.json');
  const cache = await fs.readFile(path.join(directory, 'CMakeCache.txt'), 'utf8');
  assert.match(cache, /CMAKE_BUILD_TYPE:STRING=Debug/);
  assert.equal(await core.exists(path.join(directory, 'PluginOutput.so')), false);
  const before = await fs.readFile(database, 'utf8');
  const stamp = (await fs.stat(database)).mtimeMs;
  const link = path.join(active.root, 'compile_commands.json');
  const inode = (await fs.lstat(link)).ino;
  for (const profile of ['Release', 'Debug']) {
    await core.buildProject(core.withBuildProfile(active, profile), false, () => {});
    assert.equal(await fs.readlink(link), 'build_clangd/compile_commands.json');
    assert.equal((await fs.lstat(link)).ino, inode);
    assert.equal(await fs.readFile(database, 'utf8'), before);
    assert.equal((await fs.stat(database)).mtimeMs, stamp);
  }
  const releaseCache = path.join(active.root, 'build_release/CMakeCache.txt');
  const releaseBefore = await fs.readFile(releaseCache, 'utf8');
  const newSource = path.join(active.root, 'src/navigation.cpp');
  await fs.writeFile(newSource, '// new participating source');
  assert.deepEqual(await participatingNewSources(navigation, [newSource], () => {}), [newSource]);
  await core.configureClangdDatabase(active, () => {});
  assert.ok((await fs.readFile(database, 'utf8')).includes(newSource));
  assert.equal(await fs.readFile(releaseCache, 'utf8'), releaseBefore);
  assert.equal(await core.exists(path.join(directory, 'PluginOutput.so')), false);
  const changedTools = { ...active, config: { ...active.config, cmakeArgs: ['-DNAVIGATION_FLAG=ON'] } };
  await core.configureClangdDatabase(changedTools, () => {}, undefined, false);
  assert.match(await fs.readFile(path.join(directory, 'CMakeCache.txt'), 'utf8'), /NAVIGATION_FLAG:UNINITIALIZED=ON/);
});
