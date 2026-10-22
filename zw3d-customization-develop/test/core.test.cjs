const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { suggestExistingProject, connectExistingProject } = require('../dist/importProject');
const { runProcess } = require('../dist/process');
const template = path.resolve(__dirname, '../templates/default');
const quiet = () => {};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d test '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'SDK with spaces/files');
  await fs.mkdir(path.join(sdk, 'api/inc'), { recursive: true });
  for (const file of ['api/inc/zwapi_command.h', 'libZW3D.so', 'libZwCodecHook.so']) await fs.writeFile(path.join(sdk, file), '');
  const executable = path.join(root, 'tool with spaces');
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.copyFile(executable, path.join(sdk, 'zw3d'));
  const options = { parent: root, projectName: 'HelloZW3D', libraryName: 'MyLibrary', remote: '',
    cmakePath: executable, cxxPath: executable, gdbPath: executable, zw3dRoot: path.dirname(sdk) };
  return { root, sdk, options };
}

test('generate a complete project, matching exports and no reference-machine dependencies', async t => {
  const f = await fixture(t);
  const p = await core.createProject(f.options, template);
  const source = await fs.readFile(path.join(p.root, 'src/main.cpp'), 'utf8');
  assert.match(source, /MyLibraryInit\(int format, void \*data\)/);
  assert.match(source, /MyLibraryExit\(\)/);
  assert.match(source, /HelloZW3DCommand/);
  assert.match(source, /extern "C"/);
  const cmake = await fs.readFile(path.join(p.root, 'CMakeLists.txt'), 'utf8');
  assert.match(cmake, /PREFIX ""/);
  assert.doesNotMatch(cmake, /\/home\/winnie|OriginBox|\{\{/);
  for (const dir of ['resources/forms', 'resources/commands', 'cmake', 'tests']) assert.ok((await fs.stat(path.join(p.root, dir))).isDirectory());
  assert.equal((await core.readProject(p.root)).config.buildType, 'Debug');
  assert.equal(p.config.buildDirectory, 'build_debug');
  assert.equal(p.config.cxxPath, f.options.cxxPath);
  const settings = JSON.parse(await fs.readFile(path.join(p.root, '.vscode/settings.json'), 'utf8'));
  assert.equal(settings['C_Cpp.intelliSenseEngine'], 'disabled');
  assert.ok(settings['clangd.arguments'].some(arg => arg.includes(f.options.cxxPath)));
  assert.match(await fs.readFile(path.join(p.root, '.clangd'), 'utf8'), /CompilationDatabase: ./);
  await assert.rejects(core.createProject(f.options, template), /EEXIST/);
  assert.equal(await fs.readFile(path.join(p.root, 'src/main.cpp'), 'utf8'), source);
});

test('custom templates render files and reject path traversal before creating a project', async t => {
  const f = await fixture(t);
  const custom = path.join(f.root, 'custom');
  await fs.cp(template, custom, { recursive: true });
  const manifestPath = path.join(custom, 'template.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files['include/{{PROJECT_NAME}}.h'] = 'extra.tpl';
  await fs.writeFile(path.join(custom, 'extra.tpl'), '// {{PROJECT_NAME}} / {{LIBRARY_NAME}}');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const project = await core.createProject(f.options, custom);
  assert.equal(await fs.readFile(path.join(project.root, 'include/HelloZW3D.h'), 'utf8'), '// HelloZW3D / MyLibrary');
  manifest.files['../escaped.cpp'] = 'extra.tpl';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(core.createProject({ ...f.options, projectName: 'Unsafe' }, custom), /路径/);
  assert.equal(await core.exists(path.join(f.root, 'Unsafe')), false);
  delete manifest.files['../escaped.cpp'];
  await fs.symlink('/etc/hosts', path.join(custom, 'outside.tpl'));
  manifest.files['outside.txt'] = 'outside.tpl';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(core.createProject({ ...f.options, projectName: 'Unsafe' }, custom), /不能链接/);
});

test('invalid identifiers, unknown placeholders, reserved output paths and root build paths fail clearly', async t => {
  const f = await fixture(t);
  assert.throws(() => core.identifier('bad-name', 'name'), /字母/);
  assert.throws(() => core.render('{{MISSING}}', {}), /未知占位符/);
  assert.equal(core.render('${CMAKE_BINARY_DIR}/{{PROJECT_NAME}}', { PROJECT_NAME: 'Hello' }), '${CMAKE_BINARY_DIR}/Hello');
  assert.equal(core.render('{{ZW3D_ROOT_CMAKE}}', { ZW3D_ROOT_CMAKE: '/sdk' }), '/sdk');
  for (const relative of ['../x', '/tmp/x', '.', 'src/../../x', '..\\x']) assert.throws(() => core.inside(f.root, relative), /路径/);
  const p = await core.createProject(f.options, template);
  assert.throws(() => core.validateConfig({ ...p.config, buildDirectory: 'src' }, p.root), /源码/);
  assert.throws(() => core.validateConfig({ ...p.config, environment: { 'BAD=NAME': '1' } }, p.root), /环境变量/);
});

test('regeneration cleans build targets and runtime/debug configurations preserve paths and symbols', async t => {
  const f = await fixture(t);
  const p = await core.createProject(f.options, template);
  const commands = core.buildCommands(p, true);
  assert.ok(commands[0].includes('-DCMAKE_BUILD_TYPE=Debug'));
  assert.ok(commands[0].includes(`-DCMAKE_CXX_COMPILER=${f.options.cxxPath}`));
  assert.ok(commands[1].includes('--clean-first'));
  assert.ok(!core.buildCommands(p, false)[1].includes('--clean-first'));
  const envBefore = process.env.LD_LIBRARY_PATH;
  const launch = await core.runtime(p);
  assert.equal(launch.program, path.join(f.sdk, 'zw3d'));
  assert.ok(launch.env.LD_LIBRARY_PATH.includes(path.join(f.sdk, 'libqt')));
  assert.ok(launch.env.LD_PRELOAD.includes('libZwCodecHook.so'));
  assert.equal(process.env.LD_LIBRARY_PATH, envBefore);
  const debug = await core.debugConfiguration(p);
  assert.equal(debug.type, 'cppdbg');
  assert.equal(debug.MIMode, 'gdb');
  assert.equal(debug.miDebuggerPath, f.options.gdbPath);
  assert.ok(debug.setupCommands.some(c => c.text.includes('breakpoint pending on')));
  await assert.rejects(core.debugConfiguration({ ...p, config: { ...p.config, buildType: 'Release' } }), /Debug/);
});

test('deploy copies matching .so and .zrc using a new inode and leaves other plugins untouched', async t => {
  const f = await fixture(t);
  const p = await core.createProject(f.options, template);
  const output = path.join(p.root, p.config.buildDirectory, 'plugin');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'MyLibrary.so'), 'new so');
  await fs.writeFile(path.join(output, 'MyLibrary.zrc'), 'new zrc');
  await fs.mkdir(p.config.apilibs, { recursive: true });
  await fs.writeFile(path.join(p.config.apilibs, 'MyLibrary.so'), 'old so');
  await fs.writeFile(path.join(p.config.apilibs, 'Other.so'), 'other');
  const fd = await fs.open(path.join(p.config.apilibs, 'MyLibrary.so'), 'r');
  t.after(() => fd.close());
  assert.equal((await core.deploy(p, quiet)).length, 2);
  assert.equal(await fs.readFile(path.join(p.config.apilibs, 'MyLibrary.so'), 'utf8'), 'new so');
  assert.equal(await fd.readFile('utf8'), 'old so');
  assert.equal(await fs.readFile(path.join(p.config.apilibs, 'Other.so'), 'utf8'), 'other');
  assert.deepEqual((await fs.readdir(p.config.apilibs)).sort(), ['MyLibrary.so', 'MyLibrary.zrc', 'Other.so']);
});

test('process arguments are not interpreted by a shell; failures and cancellation propagate', async () => {
  const payload = 'with spaces; echo $(touch /tmp/not-executed) `whoami`';
  assert.equal(await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload]), payload);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)']), /7/);
  const abort = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: abort.signal });
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(running, /取消/);
});

test('Git creates local main repository and pushes a configured remote without global Git changes', async t => {
  const git = await core.findExecutable('git');
  if (!git) return t.skip('Git unavailable');
  const f = await fixture(t);
  const p = await core.createProject(f.options, template);
  await core.initGit(p.root, '', quiet);
  assert.equal((await runProcess(git, ['symbolic-ref', '--short', 'HEAD'], { cwd: p.root })).trim(), 'main');
  const remote = path.join(f.root, 'remote.git');
  await runProcess(git, ['init', '--bare', remote]);
  await runProcess(git, ['config', 'user.name', 'ZW3D Test'], { cwd: p.root });
  await runProcess(git, ['config', 'user.email', 'test@example.invalid'], { cwd: p.root });
  await core.initGit(p.root, remote, quiet);
  assert.match(await runProcess(git, ['--git-dir', remote, 'log', 'main', '--oneline']), /Initialize ZW3D/);
});

test('connect an existing C project, preserving source, cached toolchain and native template command', async t => {
  const f = await fixture(t);
  const root = path.join(f.root, 'existing C project');
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.mkdir(path.join(root, 'resources/commands'), { recursive: true });
  const cmake = 'project(OriginBox LANGUAGES C)\nadd_library(OriginBox SHARED src/OriginBox.c)\n';
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), cmake);
  await fs.writeFile(path.join(root, 'resources/commands/OriginBox.tcmd'), '<templates><template name="OriginBox"></template></templates>');
  await fs.writeFile(path.join(root, 'build/CMakeCache.txt'), [
    `CMAKE_HOME_DIRECTORY:INTERNAL=${root}`, 'CMAKE_PROJECT_NAME:STATIC=OriginBox',
    'CMAKE_BUILD_TYPE:STRING=RelWithDebInfo', `CMAKE_COMMAND:INTERNAL=${f.options.cmakePath}`,
    `CMAKE_TOOLCHAIN_FILE:FILEPATH=${root}/cmake/local-sysroot.cmake`
  ].join('\n'));
  const config = await suggestExistingProject(root, f.options);
  assert.equal(config.libraryName, 'OriginBox');
  assert.equal(config.buildType, 'RelWithDebInfo');
  assert.equal(config.commandHint, '!OriginBox');
  assert.deepEqual(config.cmakeArgs, [`-DCMAKE_TOOLCHAIN_FILE=${root}/cmake/local-sysroot.cmake`]);
  assert.equal(await core.exists(path.join(root, '.zw3d/project.json')), false);
  await connectExistingProject(root, config);
  assert.equal((await core.readProject(root)).config.projectName, 'OriginBox');
  assert.equal(await fs.readFile(path.join(root, 'CMakeLists.txt'), 'utf8'), cmake);
  assert.equal(await core.exists(path.join(root, '.git')), false);
  await assert.rejects(connectExistingProject(root, config), /EEXIST/);
  await fs.writeFile(path.join(root, 'build/CMakeCache.txt'), 'CMAKE_HOME_DIRECTORY:INTERNAL=/different/project\n');
  assert.equal((await suggestExistingProject(root, f.options)).buildDirectory, 'build-zw3d');
});


test('Release and Debug profiles keep separate artifacts and deploy matching outputs with a stable language database', async t => {
  const f = await fixture(t);
  const original = await core.createProject(f.options, template);
  original.config.buildType = 'RelWithDebInfo';
  original.config.buildDirectory = 'build';
  original.config.cmakeArgs = ['-DCMAKE_TOOLCHAIN_FILE=/custom/toolchain.cmake'];
  await fs.mkdir(path.join(original.root, 'build_clangd'), { recursive: true });
  await fs.writeFile(path.join(original.root, 'build_clangd/compile_commands.json'), '[]');
  let current = original;
  for (const profile of ['Release', 'Debug', 'Release']) {
    const selected = await core.selectBuildProfile(current, profile);
    const directory = `build_${profile.toLowerCase()}`;
    assert.equal(selected.config.buildDirectory, directory);
    assert.equal(selected.config.buildType, profile);
    assert.deepEqual(selected.config.cmakeArgs, original.config.cmakeArgs);
    assert.equal((await core.readProject(selected.root)).config.buildDirectory, directory);
    const [configure, build] = core.buildCommands(selected, true);
    assert.equal(configure[configure.indexOf('-B') + 1], path.join(selected.root, directory));
    assert.ok(configure.includes(`-DCMAKE_BUILD_TYPE=${profile}`));
    assert.equal(build[1], path.join(selected.root, directory));
    assert.ok(build.includes('--clean-first'));
    const output = path.join(selected.root, directory, 'plugin');
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'MyLibrary.so'), profile);
    await fs.writeFile(path.join(output, 'MyLibrary.zrc'), `${profile} resources`);
    await core.buildProject(selected, false, quiet); // fixture tool succeeds without touching outputs
    assert.equal(await fs.readlink(path.join(selected.root, 'compile_commands.json')), 'build_clangd/compile_commands.json');
    await core.deploy(selected, quiet);
    assert.equal(await fs.readFile(path.join(selected.config.apilibs, 'MyLibrary.so'), 'utf8'), profile);
    assert.equal(await fs.readFile(path.join(selected.config.apilibs, 'MyLibrary.zrc'), 'utf8'), `${profile} resources`);
    if (profile === 'Debug') {
      assert.ok((await core.debugConfiguration(selected)).additionalSOLibSearchPath.includes(output));
    }
    current = selected;
  }
  assert.equal(original.config.buildDirectory, 'build');
  for (const profile of ['Release', 'Debug']) {
    assert.equal(await fs.readFile(path.join(original.root, `build_${profile.toLowerCase()}`, 'plugin/MyLibrary.so'), 'utf8'), profile);
  }
});

test('existing project discovery reads profile caches and retains library/toolchain metadata', async t => {
  const f = await fixture(t);
  const p = await core.createProject(f.options, template);
  for (const profile of ['Release', 'Debug']) {
    const directory = `build_${profile.toLowerCase()}`;
    await fs.mkdir(path.join(p.root, directory), { recursive: true });
    await fs.writeFile(path.join(p.root, directory, 'CMakeCache.txt'), [
      `CMAKE_HOME_DIRECTORY:INTERNAL=${p.root}`, 'CMAKE_PROJECT_NAME:STATIC=HelloZW3D',
      'ZW3D_LIBRARY_NAME:STRING=MyLibrary', `CMAKE_BUILD_TYPE:STRING=${profile}`,
      `CMAKE_COMMAND:INTERNAL=${f.options.cmakePath}`, 'CMAKE_TOOLCHAIN_FILE:FILEPATH=/custom/toolchain.cmake'
    ].join('\n'));
    const config = await suggestExistingProject(p.root, f.options);
    assert.equal(config.buildDirectory, directory);
    assert.equal(config.buildType, profile);
    assert.equal(config.libraryName, 'MyLibrary');
    assert.deepEqual(config.cmakeArgs, ['-DCMAKE_TOOLCHAIN_FILE=/custom/toolchain.cmake']);
  }
});
