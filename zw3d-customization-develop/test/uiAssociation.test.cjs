const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inferProjectCommands, inferProjectEntries, inferContextEntries, inferUiContext, scanUiResources } = require('../dist/uiAssociation');
const { detectDesigner, designerVersion, launchDesigner } = require('../dist/designer');

const root = '/example';
const ui = (name, widgetName = name) => `<ui><class>${name}</class><widget class="ZsCc::Form" name="${widgetName}"></widget></ui>`;
const template = name => `<templates><template name="${name}"><property name="custom">Make${name}.c</property></template></templates>`;
const resources = [
  ['resources/forms/FilletBox.ui', ui('FilletBox')],
  ['resources/forms/Other.ui', ui('Other')],
  ['resources/commands/FilletBox.tcmd', template('FilletBox')],
  ['src/operation.cpp', 'ZwCommandFunctionLoad("MakeFilletBox", makeBox, 0); ZwCommandSend("!FilletBox");'],
  ['CMakeLists.txt', 'project(Example)\nadd_library(Plugin SHARED src/operation.cpp)\nset_target_properties(Plugin PROPERTIES OUTPUT_NAME Custom PREFIX "")']
].map(([file, text]) => ({ file: path.join(root, file), text }));

test('project command list merges every template and source, deduplicates definitions, resolves variables and excludes callbacks and test fixtures', () => {
  const files = [...resources,
    { file: '/example/src/second.cpp', text: 'const char command[] = "Second"; ZwCommandFunctionLoad(command, run, 0); ZwCommandFunctionLoad("Second", run, 0);' },
    { file: '/example/commands/OnlyTemplate.tcmd', text: '<templates><template name="NoUi"/></templates>' },
    { file: '/example/forms/Standalone.ui', text: '<ui><widget><property name="functionName"><string>FormCallback</string></property></widget></ui>' },
    { file: '/example/src/standalone.c', text: 'cvxCmdFunc("ShowStandalone", show, 0); ZwCommandFunctionLoad("FormCallback", callback, 0); ZwCommandSend("!ExternalOnly");' },
    { file: '/example/src/commented.c', text: '// ZwCommandFunctionLoad("CommentOnly", run, 0);\n/* cvxCmdFunc("CommentToo", run, 0); */' },
    { file: '/example/tests/mock.c', text: 'ZwCommandFunctionLoad("TestOnly", run, 0);' },
    { file: '/example/examples/Example.tcmd', text: '<templates><template name="ExampleOnly"/></templates>' }
  ];
  assert.deepEqual(inferProjectCommands(files, root), ['!FilletBox', '!NoUi', '~Second', '~ShowStandalone']);
});

test('project commands need neither a UI nor project.json, and rescanning saved source removes obsolete registrations', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-commands-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'main.cpp');
  await fs.writeFile(file, 'ZwCommandFunctionLoad("Before", run, 0);');
  assert.deepEqual(inferProjectCommands((await scanUiResources(temporary)).files, temporary), ['~Before']);
  await fs.writeFile(file, 'ZwCommandFunctionLoad("After", run, 0);');
  assert.deepEqual(inferProjectCommands((await scanUiResources(temporary)).files, temporary), ['~After']);
  await fs.unlink(file);
  assert.deepEqual(inferProjectCommands((await scanUiResources(temporary)).files, temporary), []);
});

test('project entries pair real library/command/UI evidence and keep commands without UI visible', () => {
  const files = [...resources,
    { file: '/example/src/plain.cpp', text: 'ZwCommandFunctionLoad("Plain", run, 0);' },
    { file: '/example/tests/mock.cpp', text: 'ZwCommandFunctionLoad("TestOnly", run, 0);' }
  ];
  assert.deepEqual(inferProjectEntries(files, root), [
    { library: 'Custom.so', command: '!FilletBox', ui: { file: '/example/resources/forms/FilletBox.ui', relative: 'resources/forms/FilletBox.ui' } },
    { library: 'Custom.so', command: '~Plain' }
  ]);
  const context = inferUiContext(root, '/example/src/plain.cpp', false, files);
  assert.deepEqual(inferContextEntries(context, files), [{ library: 'Custom.so', command: '~Plain' }]);
  const configured = inferProjectEntries(files, root, { libraryName: 'Actual' });
  assert.ok(configured.every(entry => entry.library === 'Actual.so'));
  assert.equal(configured.some(entry => entry.command === '~MakeFilletBox' || entry.ui?.file.endsWith('Other.ui')), false);
  assert.deepEqual(inferProjectEntries([{ file: '/example/main.cpp', text: 'cvxCmdFunc("Only", run, 0);' }], root), [{ library: undefined, command: '~Only' }]);
});

test('entries preserve standalone form commands and scope duplicate command names to their CMake module', () => {
  const files = ['One', 'Two'].flatMap(name => [
    { file: `/example/${name}/CMakeLists.txt`, text: `add_library(${name} SHARED main.cpp)\nset_target_properties(${name} PROPERTIES PREFIX "")` },
    { file: `/example/${name}/Form.ui`, text: ui('Form') },
    { file: `/example/${name}/main.cpp`, text: 'cvxCmdFunc("Show", show, 0);cvxFormCreate("Form", 0);' }
  ]);
  const entries = inferProjectEntries(files, root);
  assert.equal(entries.length, 2);
  for (const name of ['One', 'Two']) {
    assert.ok(entries.some(entry => entry.library === `${name}.so` && entry.command === '~Show' && entry.ui?.relative === `${name}/Form.ui`));
  }
  const context = inferUiContext(root, '/example/One/Form.ui', false, files);
  assert.ok(inferContextEntries(context, files).some(entry => entry.command === '~Show'));
});

test('rank the current UI, matching template, direct command reference and template callback above unrelated forms', () => {
  for (const active of ['resources/forms/FilletBox.ui', 'resources/commands/FilletBox.tcmd', 'src/operation.cpp']) {
    const context = inferUiContext(root, path.join(root, active), false, resources);
    assert.equal(context.candidates[0].relative, 'resources/forms/FilletBox.ui');
    assert.ok(context.candidates[0].commands.includes('!FilletBox'));
    assert.equal(context.candidates[0].commands.includes('~MakeFilletBox'), false);
    assert.deepEqual(context.candidates[0].libraries, ['Custom.so']);
    assert.deepEqual(context.candidates[0].warnings, []);
    assert.ok(context.candidates[0].score > context.candidates[1].score);
  }
  const callbackOnly = resources.map(item => item.file.endsWith('operation.cpp') ? { ...item, text: 'ZwCommandFunctionLoad("MakeFilletBox", run, 0);' } : item);
  assert.ok(inferUiContext(root, '/example/src/operation.cpp', false, callbackOnly).candidates[0].reasons.includes('源码注册了模板回调'));
});

test('standalone Form uses variable-based API and registered commands without inventing a template !command', () => {
  const files = [
    { file: '/example/BoxForm.ui', text: '<ui><class>BoxForm</class><widget class="ZsCc::Form" name="BoxForm"><property name="geometry"><rect/></property><property name="functionName"><string>BoxCallback</string></property></widget></ui>' },
    { file: '/example/src/standalone.c', text: 'static char form_name[] = "BoxForm"; static const char show_command[] = "ShowBox"; cvxFormCreate(form_name, 0); ZwCommandFunctionLoad(show_command, show, 0);' }
  ];
  const context = inferUiContext(root, files[1].file, false, files);
  assert.deepEqual(context.candidates[0].commands, ['~ShowBox']);
  assert.ok(context.candidates[0].reasons.includes('源码命令/Form API 直接引用'));
  const variableForm = files.map(item => item.file.endsWith('.c') ? { ...item, text: 'ZwCommandFunctionLoad("BoxCallback", callback, 0);' } : item);
  assert.ok(inferUiContext(root, files[1].file, false, variableForm).candidates[0].reasons.includes('源码含相同 Form 标识'));
});

test('mismatched names are reported, comments do not create commands, folders and weak candidates retain explicit uncertainty', () => {
  const files = resources.map(item => item.file.endsWith('FilletBox.ui') ? { ...item, text: ui('FilletBox', 'WrongForm') } : item);
  files.push({ file: '/example/src/irrelevant.cpp', text: '// ZwCommandSend("!Other");\n/* ZwCommandFunctionLoad("Fake", fn, 0); */' });
  const context = inferUiContext(root, '/example/src/irrelevant.cpp', false, files);
  assert.equal(context.commands.includes('~Fake'), false);
  assert.ok(context.candidates.find(item => item.file.endsWith('FilletBox.ui')).warnings.length >= 1);
  assert.ok(context.candidates.every(item => item.reasons.includes('同工程候选，尚无直接绑定证据')));
  assert.ok(inferUiContext(root, '/example/resources/forms', true, files).candidates[0].reasons.includes('所选目录内的 UI'));
  assert.deepEqual(inferUiContext(root, '/example/src/main.cpp', false, []).candidates, []);
  assert.deepEqual(inferUiContext(root, '/example/CMakeLists.txt', false, [{ file: '/example/CMakeLists.txt', text: 'project(Demo)\nadd_library(${PROJECT_NAME} SHARED src/main.cpp)' }]).libraries, ['libDemo.so']);
});

test('scan excludes builds, external links, dependencies and oversized files, and works without .zw3d configuration', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-ui-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const directory of ['forms', 'build', 'custom-output', 'node_modules', '.hidden']) {
    await fs.mkdir(path.join(temporary, directory));
    await fs.writeFile(path.join(temporary, directory, 'Box.ui'), ui('Box'));
  }
  await fs.symlink(path.join(temporary, 'forms'), path.join(temporary, 'linked'));
  await fs.writeFile(path.join(temporary, 'large.ui'), ' '.repeat(512 * 1024 + 1));
  const scan = await scanUiResources(temporary, 'custom-output');
  assert.deepEqual(scan.files.map(item => path.relative(temporary, item.file)), ['forms/Box.ui']);
  assert.equal(scan.truncated, true);
});

test('Designer detection preserves launchers, reports companion Qt version without launching GUI, and passes a UI path as one literal argument', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d designer '));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, 'designer launcher');
  const capture = path.join(temporary, 'arguments.json');
  const program = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`;
  await fs.writeFile(executable, program, { mode: 0o755 });
  await fs.writeFile(path.join(temporary, 'qmake'), '#!/bin/sh\n[ "$1" = "-query" ] && [ "$2" = "QT_VERSION" ] || exit 9\nprintf "5.9.7\\n"\n', { mode: 0o755 });
  assert.equal(await detectDesigner(executable), executable);
  assert.equal(await detectDesigner(path.join(temporary, 'missing')), '');
  assert.match(await designerVersion(executable), /Qt Designer.*5\.9\.7.*qmake/);
  assert.equal(await fs.stat(capture).then(() => true, () => false), false);
  const file = path.join(temporary, 'form $(do-not-execute) with spaces.ui');
  await fs.writeFile(file, ui('Box'));
  await launchDesigner(executable, file, () => {});
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.stat(capture).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(JSON.parse(await fs.readFile(capture, 'utf8')), [file]);
  await assert.rejects(launchDesigner(executable, path.join(temporary, 'missing.ui'), () => {}));
});
