const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readToolVersion, readToolVersions } = require('../dist/toolVersions');

test('read version output from executable paths with spaces, and installation metadata without launching ZW3D', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d versions '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = path.join(root, 'compiler with spaces');
  await fs.writeFile(tool, '#!/bin/sh\n[ "$1" = "--version" ] || exit 9\nprintf "g++ (test compiler) 15.2.0\\nCopyright information\\n"\n', { mode: 0o755 });
  const sdk = path.join(root, 'sdk');
  await fs.mkdir(path.join(sdk, 'files/api/inc'), { recursive: true });
  await fs.writeFile(path.join(sdk, 'files/api/inc/zwapi_command.h'), '');
  await fs.writeFile(path.join(sdk, 'files/libZW3D.so'), '');
  await fs.writeFile(path.join(sdk, 'info'), JSON.stringify({ version: '2026.0.1.0' }));
  const result = await readToolVersions({ cmakePath: tool, cxxPath: tool, gdbPath: tool, zw3dRoot: path.join(sdk, 'files') });
  assert.equal(result.cxxPath, 'g++ (test compiler) 15.2.0');
  assert.equal(result.zw3dRoot, '2026.0.1.0');
  await fs.unlink(path.join(sdk, 'info'));
  assert.match(await readToolVersion('zw3dRoot', sdk), /版本未知/);
  assert.equal(await readToolVersion('gdbPath', ''), '未配置');
  assert.match(await readToolVersion('cxxPath', path.join(root, 'missing')), /路径无效/);
  await fs.writeFile(tool, '#!/bin/sh\nexit 8\n', { mode: 0o755 });
  assert.match(await readToolVersion('cxxPath', tool), /无法读取版本/);
});
