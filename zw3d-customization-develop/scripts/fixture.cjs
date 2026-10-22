const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../dist/core');
const { runProcess } = require('../dist/process');

async function mockHost(parent, tools) {
  const actualFiles = await core.zw3dFiles(tools.zw3dRoot);
  const files = path.join(parent, 'mock SDK/files');
  await fs.mkdir(path.join(files, 'api'), { recursive: true });
  await fs.symlink(path.join(actualFiles, 'api/inc'), path.join(files, 'api/inc'));
  const sdkSource = path.join(parent, 'mock-sdk.cpp');
  await fs.writeFile(sdkSource, `#include "zwapi_command.h"
#include "zwapi_message.h"
#include <cstdio>
static zwFunctionPointer command;
extern "C" ezwErrors ZwCommandFunctionLoad(const char *, zwFunctionPointer fn, ezwCommandLicenseType) { command = fn; return ZW_API_NO_ERROR; }
extern "C" ezwErrors ZwCommandFunctionUnload(const char *) { command = nullptr; return ZW_API_NO_ERROR; }
extern "C" void cvxMsgDisp(const char *text) { std::puts(text); }
extern "C" void TestInvoke() { if (command) reinterpret_cast<void(*)()>(command)(); }
`);
  await runProcess(tools.cxxPath, ['-shared', '-fPIC', '-g', '-isystem', path.join(actualFiles, 'api/inc'), sdkSource,
    '-Wl,-soname,libZW3D.so', '-o', path.join(files, 'libZW3D.so')]);
  const hostSource = path.join(parent, 'mock-host.cpp');
  await fs.writeFile(hostSource, `#include <dlfcn.h>
#include <cstdio>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  void *lib = dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL);
  if (!lib) { std::puts(dlerror()); return 3; }
  auto init = reinterpret_cast<int(*)(int,void*)>(dlsym(lib, "DebugPluginInit"));
  auto invoke = reinterpret_cast<void(*)()>(dlsym(lib, "TestInvoke"));
  auto exit = reinterpret_cast<int(*)()>(dlsym(lib, "DebugPluginExit"));
  if (!init || !invoke || !exit) return 4;
  if (init(0, nullptr) != 0) return 5;
  invoke();
  if (exit() != 0) return 6;
  dlclose(lib);
  return 0;
}
`);
  await runProcess(tools.cxxPath, ['-g', '-O0', hostSource, '-ldl', '-o', path.join(files, 'zw3d')]);
  const project = await core.createProject({ ...tools, zw3dRoot: path.dirname(files), parent, projectName: 'DebugSmoke', libraryName: 'DebugPlugin', remote: '' }, path.resolve(__dirname, '../templates/default'));
  project.config.args = [path.join(files, 'apilibs/DebugPlugin.so')];
  await fs.writeFile(path.join(project.root, '.zw3d/project.json'), JSON.stringify(project.config, null, 2));
  return project;
}
module.exports = { mockHost };
