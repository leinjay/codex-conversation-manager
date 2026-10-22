const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { detectZW3DProject, initializeDetectedProject } = require('../dist/projectDetection');
const { readProject, exists } = require('../dist/core');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-detection-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const sdk = path.join(base, 'SDK/files');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(sdk, 'api/inc'), { recursive: true });
  await fs.writeFile(path.join(sdk, 'api/inc/zwapi_command.h'), '');
  await fs.writeFile(path.join(sdk, 'libZW3D.so'), '');
  const tool = path.join(base, 'tool');
  await fs.writeFile(tool, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const tools = { cmakePath: tool, cxxPath: tool, gdbPath: tool, zw3dRoot: path.dirname(sdk) };
  return { root, tools, base };
}

test('recognize SDK links or real source includes with a shared/module CMake target', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), 'project(Native)\nadd_library(Native SHARED src/main.c)\ntarget_link_libraries(Native "${SDK}/libZW3D.so")\n');
  assert.equal((await detectZW3DProject(root)).isZW3D, true);
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), 'project(Native)\nadd_library(Native MODULE src/main.c)\n');
  await fs.writeFile(path.join(root, 'src/main.c'), '#include "zwapi_command.h"\n');
  const detected = await detectZW3DProject(root);
  assert.equal(detected.isZW3D, true);
  assert.ok(detected.reasons.some(reason => reason.includes('头文件')));
  await fs.writeFile(path.join(root, 'src/main.c'), '#include "VxApi.h"\n');
  assert.equal((await detectZW3DProject(root)).isZW3D, true);
  assert.equal(await exists(path.join(root, '.zw3d/project.json')), false);
});

test('ordinary projects, comments, vendor copies and symlinked sources do not trigger initialization', async t => {
  const { root, base } = await fixture(t);
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), `project(ZW3D)
add_library(ZW3D SHARED src/main.cpp)
# target_link_libraries(ZW3D libZW3D.so)
#[=[ target_link_libraries(ZW3D libZW3D.so) ]=]
`);
  await fs.writeFile(path.join(root, 'src/main.cpp'), '// #include "zwapi_command.h"\n/*\n#include "VxApi.h"\n*/\nint normal;');
  await fs.mkdir(path.join(root, 'vendor'));
  await fs.writeFile(path.join(root, 'vendor/sdk.cpp'), '#include "zwapi_command.h"');
  const external = path.join(base, 'external.cpp');
  await fs.writeFile(external, '#include "zwapi_command.h"');
  await fs.symlink(external, path.join(root, 'src/linked.cpp'));
  assert.equal((await detectZW3DProject(root)).isZW3D, false);
  assert.equal((await initializeDetectedProject(root)).state, 'unrecognized');
  assert.equal(await exists(path.join(root, '.zw3d')), false);
  await fs.unlink(path.join(root, 'CMakeLists.txt'));
  assert.equal((await detectZW3DProject(root)).isZW3D, false);
});

test('automatic initialization is idempotent, preserves CMake and user config, and handles concurrent scans', async t => {
  const { root, tools } = await fixture(t);
  const cmake = 'project(AutoPlugin)\nadd_library(AutoPlugin SHARED src/main.cpp)\ntarget_link_libraries(AutoPlugin libZW3D.so)\n';
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), cmake);
  const results = await Promise.all([initializeDetectedProject(root, tools), initializeDetectedProject(root, tools)]);
  assert.equal(results.filter(result => result.state === 'initialized').length, 1);
  assert.equal(results.filter(result => result.state === 'existing').length, 1);
  assert.equal((await readProject(root)).config.libraryName, 'AutoPlugin');
  assert.equal(await fs.readFile(path.join(root, 'CMakeLists.txt'), 'utf8'), cmake);
  const configPath = path.join(root, '.zw3d/project.json');
  await fs.writeFile(configPath, '{ user configuration that needs repair');
  assert.equal((await initializeDetectedProject(root, tools)).state, 'existing');
  assert.equal(await fs.readFile(configPath, 'utf8'), '{ user configuration that needs repair');
  assert.equal(await exists(path.join(root, '.git')), false);
});
