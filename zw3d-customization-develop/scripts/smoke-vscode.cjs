const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const net = require('node:net');
const { runProcess } = require('../dist/process');
const { findExecutable } = require('../dist/core');

async function main() {
  const extension = path.resolve(__dirname, '..');
  const latest = JSON.parse(await fs.readFile(path.join(extension, '.test-artifacts/latest-mock.json'), 'utf8'));
  const configPath = path.join(latest.root, '.zw3d/project.json');
  const originalConfig = await fs.readFile(configPath, 'utf8');
  const backupPath = path.join(extension, '.test-artifacts/vscode-original-project.json');
  await fs.writeFile(backupPath, originalConfig);
  const resultFile = path.join(extension, '.test-artifacts/vscode-debug-result.json');
  await fs.rm(resultFile, { force: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'zw3d-vscode-test-'));
  // The CLI can return before extension tests finish. Run the installed Electron
  // binary directly so exit status and lifetime belong to this test window.
  const cli = await fs.realpath(await findExecutable('code'));
  const binary = process.env.VSCODE_EXECUTABLE || path.resolve(path.dirname(cli), '../code');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  try {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 120000);
    try {
      const args = ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`,
        '--user-data-dir', userData, '--extensions-dir', process.env.VSCODE_EXTENSIONS_DIR || path.join(os.homedir(), '.vscode/extensions'),
        `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${path.join(__dirname, 'vscode-suite.cjs')}`, latest.root];
      const env = { ...process.env, ZW3D_CDP_PORT: String(port), ZW3D_TEST_ORIGINAL_CONFIG: backupPath };
      delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI;
      // A workspace without project.json exercises startup auto-detection.
      await fs.unlink(configPath);
      const output = await runProcess(binary, args, { signal: abort.signal, env, label: 'VS Code integration test host' });
      await fs.writeFile(path.join(extension, '.test-artifacts/vscode-console.log'), output);
      for (const line of output.split('\n').filter(line => line.startsWith('PASS:'))) console.log(line);
      const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
      assert.ok(result.stack.stackFrames.some(frame => frame.source?.path === path.join(latest.root, 'src/main.cpp')));
      console.log('VS Code breakpoint, source stack and scopes verified.');
    } finally { clearTimeout(timeout); }
  } finally {
    await fs.writeFile(configPath, originalConfig);
    await fs.rm(userData, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
