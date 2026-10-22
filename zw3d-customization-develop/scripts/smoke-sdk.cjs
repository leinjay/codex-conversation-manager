const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../dist/core');
const { runProcess } = require('../dist/process');
const { mockHost } = require('./fixture.cjs');
const { clangdSettings } = require('../dist/clangd');

async function main() {
  const tools = await core.detectTools({ zw3dRoot: process.env.ZW3D_ROOT });
  for (const [name, value] of Object.entries(tools)) assert.ok(value, `${name} unavailable`);
  const base = path.resolve(__dirname, '../.test-artifacts');
  await fs.mkdir(base, { recursive: true });
  const parent = await fs.mkdtemp(path.join(base, 'sdk-'));
  const project = await core.createProject({ ...tools, parent, projectName: 'SDKSmoke', libraryName: 'SDKPlugin', remote: '' }, path.resolve(__dirname, '../templates/default'));
  project.config.apilibs = path.join(parent, 'staging/apilibs');
  await core.buildProject(project, false, console.log);
  const database = JSON.parse(await fs.readFile(path.join(project.root, 'compile_commands.json'), 'utf8'));
  assert.ok(database.some(entry => entry.file === path.join(project.root, 'src/main.cpp')));
  const clangd = await core.findExecutable('clangd');
  if (clangd) {
    const settings = await clangdSettings(project, clangd, await core.findExecutable('gcc'));
    const query = settings['clangd.arguments'].find(arg => arg.startsWith('--query-driver='));
    const check = await runProcess(clangd, [`--check=${path.join(project.root, 'src/main.cpp')}`, query], { cwd: project.root });
    await fs.writeFile(path.join(parent, 'clangd-check.txt'), check);
    assert.match(check, /All checks completed, 0 errors/);
    console.log('clangd parsed the generated C++ plugin with the real SDK and GCC system headers.');
  }
  await core.buildProject(project, true, console.log);
  for (const profile of ['Release', 'Debug']) {
    const selected = await core.selectBuildProfile(project, profile);
    await core.buildProject(selected, false, console.log);
    await core.buildProject(selected, true, console.log);
    const profileLibrary = path.join(project.root, selected.config.buildDirectory, 'plugin/SDKPlugin.so');
    const sections = await runProcess('readelf', ['-S', profileLibrary]);
    if (profile === 'Debug') assert.match(sections, /\.debug_info/);
    else assert.doesNotMatch(sections, /\.debug_info/);
    const cache = await fs.readFile(path.join(project.root, selected.config.buildDirectory, 'CMakeCache.txt'), 'utf8');
    assert.ok(cache.includes(`CMAKE_BUILD_TYPE:STRING=${profile}`));
    await core.deploy(selected, console.log);
    assert.deepEqual(await fs.readFile(path.join(selected.config.apilibs, 'SDKPlugin.so')), await fs.readFile(profileLibrary));
    assert.equal(await fs.readlink(path.join(project.root, 'compile_commands.json')), 'build_clangd/compile_commands.json');
  }
  console.log('Release/Debug SDK builds, clean rebuilds, isolated caches, symbols and matching deployments verified.');
  const library = path.join(project.root, project.config.buildDirectory, 'plugin/SDKPlugin.so');
  const exports = await runProcess('nm', ['-D', '--defined-only', library]);
  assert.match(exports, /\bSDKPluginInit\b/); assert.match(exports, /\bSDKPluginExit\b/);
  assert.doesNotMatch(exports, /\b_Z.*SDKPluginInit/);
  assert.match(await runProcess('readelf', ['-S', library]), /\.debug_info/);
  await core.deploy(project, console.log);
  assert.deepEqual(await fs.readFile(path.join(project.config.apilibs, 'SDKPlugin.so')), await fs.readFile(library));
  // Exercise apiDemo's optional native resource pipeline against the actual zrc compiler.
  const reference = process.env.ZW3D_REFERENCE || '/home/winnie/project/apiDemo';
  if (await core.exists(path.join(reference, 'resources/forms/OriginBox.ui'))) {
    await fs.cp(path.join(reference, 'resources'), path.join(project.root, 'resources'), { recursive: true });
    await core.buildProject(project, false, console.log);
    assert.ok((await fs.stat(path.join(project.root, project.config.buildDirectory, 'plugin/SDKPlugin.zrc'))).size > 0);
    assert.equal((await core.deploy(project, console.log)).length, 2);
  }
  // A small host emulates SDK callbacks to test lifecycle and dynamic-load breakpoints,
  // without license/UI interactions or modifications to the real ZW3D installation.
  const mock = await mockHost(parent, tools);
  await core.buildProject(mock, false, console.log);
  await core.deploy(mock, console.log);
  const launch = await core.runtime(mock);
  const output = await runProcess(launch.program, mock.config.args, { cwd: launch.cwd, env: launch.env });
  assert.match(output, /Hello from DebugSmoke!/);
  const gdb = await runProcess(tools.gdbPath, ['--batch', '-ex', 'set breakpoint pending on',
    '-ex', 'break DebugPluginInit', '-ex', 'break DebugSmokeCommand', '-ex', 'run', '-ex', 'bt',
    '-ex', 'continue', '-ex', 'bt', '-ex', 'continue', '--args', launch.program, ...mock.config.args], { env: launch.env, cwd: launch.cwd });
  assert.match(gdb, /Breakpoint \d, DebugPluginInit/);
  assert.match(gdb, /Breakpoint \d, DebugSmokeCommand/);
  assert.match(gdb, /main\.cpp:\d+/);
  assert.match(gdb, /TestInvoke/);
  await fs.writeFile(path.join(base, 'latest-mock.json'), JSON.stringify({ root: mock.root }, null, 2));
  await fs.writeFile(path.join(parent, 'gdb.txt'), gdb);
  console.log(`Real SDK build, zrc, deployment, lifecycle and GDB source/stack smoke passed.\nArtifacts: ${parent}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
