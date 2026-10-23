const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { checkEnvironment, hasLibraryPath, prependLibraryPath, addShellLibraryPath } = require('../dist/environment');
const { runProcess } = require('../dist/process');

test('environment diagnostics distinguish failed compilers, invalid clients and missing exact library entries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = path.join(root, 'files');
  await fs.mkdir(path.join(files, 'api/inc'), { recursive: true });
  await fs.writeFile(path.join(files, 'api/inc/zwapi_command.h'), '');
  await fs.writeFile(path.join(files, 'libZW3D.so'), '');
  const host = path.join(files, 'zw3d');
  await fs.writeFile(host, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const tools = { cmakePath: host, cxxPath: host, gdbPath: host, zw3dRoot: root };
  const versions = { cmakePath: 'CMake 4', cxxPath: 'g++ 15', gdbPath: 'GDB 16', zw3dRoot: '版本未知' };
  const directory = path.join(files, 'ZWMold/Bin');
  const healthy = await checkEnvironment(tools, versions, host);
  assert.deepEqual(healthy, { issues: [], libraryDirectory: directory });
  const problems = await checkEnvironment(tools, { ...versions, cxxPath: '无法读取版本（运行失败或超时）' }, '/missing/designer', '/missing/zw3d');
  assert.deepEqual(problems.issues, [
    { severity: 'error', message: '缺少编译工具 g++', action: 'configure' },
    { severity: 'error', message: '缺少客户端工具 ZW3D、Qt Designer', action: 'configure' }
  ]);
  const missingSdk = await checkEnvironment({ ...tools, zw3dRoot: '/missing/sdk' }, versions, host);
  assert.equal(missingSdk.issues[0].message, '缺少客户端工具 ZW3D');
  assert.equal(missingSdk.libraryDirectory, undefined);
  assert.equal(hasLibraryPath('', directory), false);
  assert.equal(prependLibraryPath(undefined, directory), directory);
  assert.equal(prependLibraryPath(directory + ':/other', directory), directory + ':/other');
});

test('shell updates preserve user settings, select the effective login profile, quote paths literally and stay idempotent', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-shell-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const profile = path.join(home, '.bash_profile');
  await fs.writeFile(profile, '# user preferences without trailing newline');
  const directory = path.join(home, "SDK ' $(touch unexpected) [*]/ZWMold/Bin");
  const touched = await addShellLibraryPath(home, '/bin/bash', directory);
  assert.deepEqual(touched, [profile, path.join(home, '.bashrc')]);
  const first = await fs.readFile(profile, 'utf8');
  assert.ok(first.startsWith('# user preferences without trailing newline\n'));
  await addShellLibraryPath(home, '/bin/bash', directory);
  assert.equal(await fs.readFile(profile, 'utf8'), first);
  const env = { ...process.env }; delete env.LD_LIBRARY_PATH;
  const result = await runProcess('/bin/bash', ['--noprofile', '--norc', '-c', '. "$1"; . "$2"; printf %s "$LD_LIBRARY_PATH"', 'test', ...touched], { env, cwd: home });
  assert.equal(result, directory);
  const preserved = await runProcess('/bin/bash', ['--noprofile', '--norc', '-c', '. "$1"; . "$2"; printf %s "$LD_LIBRARY_PATH"', 'test', ...touched], { env: { ...env, LD_LIBRARY_PATH: '/existing' }, cwd: home });
  assert.equal(preserved, directory + ':/existing');
  await assert.rejects(fs.access(path.join(home, 'unexpected')));
  await assert.rejects(addShellLibraryPath(home, '/bin/fish', directory), /暂不支持/);
  await assert.rejects(addShellLibraryPath(home, '/bin/bash', '/bad\npath'), /无效/);
  const zshFiles = await addShellLibraryPath(home, '/bin/zsh', '/sdk/Bin');
  assert.deepEqual(zshFiles.map(file => path.basename(file)), ['.zprofile', '.zshrc']);
});

test('fresh processes restore only an approved existing SDK path without running shell configuration', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-restart-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'sdk/ZWMold/Bin');
  await fs.mkdir(directory, { recursive: true });
  await addShellLibraryPath(home, '/bin/bash', directory);
  await fs.appendFile(path.join(home, '.bashrc'), '\ntouch should-not-run\n');
  const moduleFile = path.resolve(__dirname, '../dist/environment.js');
  const script = `const {restoreLibraryEnvironment}=require(process.argv[1]); const env={LD_LIBRARY_PATH:'/fresh'}; restoreLibraryEnvironment(process.argv[2], '/bin/bash', process.argv[3], env).then(restored=>console.log(JSON.stringify({restored,value:env.LD_LIBRARY_PATH})));`;
  const output = await runProcess(process.execPath, ['-e', script, moduleFile, home, directory], { cwd: home });
  assert.deepEqual(JSON.parse(output), { restored: true, value: directory + ':/fresh' });
  await assert.rejects(fs.access(path.join(home, 'should-not-run')));
  const { restoreLibraryEnvironment } = require('../dist/environment');
  await fs.rm(path.join(home, '.profile'));
  await fs.rm(path.join(home, '.bashrc'));
  const restarted = { LD_LIBRARY_PATH: '/preserved' };
  assert.equal(await restoreLibraryEnvironment(home, '/bin/bash', directory, restarted, directory + ':/stale'), true);
  assert.equal(restarted.LD_LIBRARY_PATH, directory + ':/preserved');
  assert.equal(await restoreLibraryEnvironment(home, '/bin/bash', directory, restarted, directory), false);
  const unapproved = {};
  assert.equal(await restoreLibraryEnvironment(home, '/bin/bash', directory, unapproved, directory + '-other'), false);
  assert.equal(unapproved.LD_LIBRARY_PATH, undefined);
  await fs.rm(directory, { recursive: true });
  assert.equal(await restoreLibraryEnvironment(home, '/bin/bash', directory, {}, directory), false);
});
