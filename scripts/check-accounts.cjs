const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AccountManager, AccountAuthenticationError, AccountEnvironmentError } = require('../dist/accounts.js');

const cache = (email, accountId, revision = 0) => JSON.stringify({
  auth_mode: 'chatgpt', testEmail: email,
  tokens: { account_id: accountId, access_token: `synthetic-access-${revision}`, refresh_token: `synthetic-refresh-${revision}` }
});

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sponge-accounts-'));
  const home = path.join(root, 'codex');
  const storage = path.join(root, 'storage');
  await fs.mkdir(home);
  const activeFile = path.join(home, 'auth.json');
  await fs.writeFile(activeFile, cache('a@example.com', 'account-a'));
  const vault = new Map();
  const secrets = {
    get: async key => vault.get(key),
    store: async (key, value) => { vault.set(key, value); },
    delete: async key => { vault.delete(key); }
  };
  let beforeCount = 0;
  let revision = 0;
  const backend = {
    failRefresh: false,
    failAfterRotation: false,
    wrongAfterWrite: false,
    store: 'file',
    onRefresh: undefined,
    waitForCancel: false,
    async read(directory, refresh, isolated) {
      let raw;
      try { raw = JSON.parse(await fs.readFile(path.join(directory, 'auth.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { email: '', store: this.store }; throw error; }
      if (refresh) {
        if (this.failRefresh) throw new AccountAuthenticationError('Synthetic expired authorization');
        raw.tokens.refresh_token = `synthetic-rotated-${++revision}`;
        await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify(raw));
        if (this.failAfterRotation) throw new Error('Synthetic read failure after rotation');
        await this.onRefresh?.();
      }
      return { email: this.wrongAfterWrite && !isolated && raw.testEmail === 'b@example.com' ? 'wrong@example.com' : raw.testEmail, store: this.store, planType: 'plus' };
    },
    async login(directory, signal) {
      if (this.waitForCancel) {
        await new Promise((resolve, reject) => {
          if (signal.aborted) reject(new Error('cancelled'));
          else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }
      await fs.writeFile(path.join(directory, 'auth.json'), cache('b@example.com', 'account-b'));
      return { email: 'b@example.com', store: 'file', planType: 'pro' };
    }
  };
  const create = () => new AccountManager(storage, home, secrets, backend, () => {}, async () => { beforeCount++; });
  const manager = create();
  await manager.initialize();
  const active = () => fs.readFile(activeFile, 'utf8');
  try { await run({ root, home, storage, activeFile, manager, create, backend, vault, secrets, active, beforeCount: () => beforeCount }); }
  finally {
    manager.dispose();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

async function main() {
  await checkProtocol();
  await fixture(async f => {
    const original = await f.active();
    await f.manager.saveCurrent();
    await f.manager.add();
    assert.equal(await f.active(), original, 'Adding another account must not change the active login.');
    assert.equal(f.manager.snapshot().items.length, 2);
    const metadata = await fs.readFile(path.join(f.storage, 'accounts', 'index.json'), 'utf8');
    assert.doesNotMatch(metadata, /synthetic-access|synthetic-refresh|tokens/);
    assert.doesNotMatch(JSON.stringify(f.manager.snapshot()), /synthetic-access|synthetic-refresh|tokens/);
    assert.deepEqual((await fs.readdir(path.join(f.storage, 'accounts'))).filter(name => name.startsWith('login-')), []);
    const b = f.manager.snapshot().items.find(item => item.email === 'b@example.com');
    assert.equal(await f.manager.switchTo(b.id), true);
    assert.equal(f.beforeCount(), 1);
    assert.equal(JSON.parse(await f.active()).testEmail, 'b@example.com');
    assert.match(await f.secrets.get(`sponge.accounts.${b.id}`), /synthetic-rotated/);
    assert.equal(f.manager.snapshot().phase, 'reloadRequired');
    await assert.rejects(f.manager.verifyAfterReload(), /重载/);
    const reloaded = f.create();
    await reloaded.initialize();
    await reloaded.verifyAfterReload();
    assert.equal(reloaded.snapshot().phase, 'confirmationRequired');
    await assert.rejects(reloaded.confirmIde('a@example.com'), /不一致/);
    assert.equal(reloaded.snapshot().phase, 'confirmationRequired');
    await reloaded.confirmIde('b@example.com');
    assert.equal(reloaded.snapshot().phase, 'confirmed');
    const otherWindow = f.create();
    await otherWindow.initialize();
    await otherWindow.verifyAfterReload();
    assert.equal(otherWindow.snapshot().phase, 'confirmationRequired', 'Another window must not inherit a manual IDE confirmation.');
    assert.match(otherWindow.snapshot().message, /请核对/, 'Another window must not inherit a confirmed-account message.');
    const refreshed = JSON.parse(await f.active());
    refreshed.tokens.refresh_token = 'synthetic-latest-b';
    await fs.writeFile(f.activeFile, JSON.stringify(refreshed));
    const a = reloaded.snapshot().items.find(item => item.email === 'a@example.com');
    await reloaded.switchTo(a.id);
    assert.match(await f.secrets.get(`sponge.accounts.${b.id}`), /synthetic-latest-b/, 'Save the latest active cache before switching away.');
    const beforeRemove = await f.active();
    await reloaded.remove(a.id);
    assert.equal(await f.active(), beforeRemove, 'Removing a saved copy must not log out the current account.');
    assert.equal(await f.secrets.get(`sponge.accounts.${a.id}`), undefined);
  });

  await fixture(async f => {
    await f.manager.add();
    const b = f.manager.snapshot().items[0];
    const original = await f.active();
    f.backend.failRefresh = true;
    await assert.rejects(f.manager.switchTo(b.id), /登录已失效/);
    assert.equal(await f.active(), original);
    assert.equal(f.beforeCount(), 0);
    assert.equal(f.manager.snapshot().items.find(item => item.id === b.id).state, 'reauth');
    f.backend.failRefresh = false;
    f.backend.failAfterRotation = true;
    await assert.rejects(f.manager.switchTo(b.id), /无法在线核验/);
    assert.match(await f.secrets.get(`sponge.accounts.${b.id}`), /synthetic-rotated/, 'Preserve a rotated refresh token even if a later identity/config read fails.');
    assert.equal(await f.active(), original);
    f.backend.failAfterRotation = false;
    f.backend.wrongAfterWrite = true;
    await assert.rejects(f.manager.switchTo(b.id), /核验失败/);
    assert.equal(await f.active(), original, 'A post-write mismatch must restore the previous login.');
    assert.equal(f.manager.snapshot().phase, 'unverified');
  });

  await fixture(async f => {
    await f.manager.add();
    f.backend.onRefresh = async () => fs.writeFile(f.activeFile, cache('external@example.com', 'account-external'));
    await assert.rejects(f.manager.switchTo(f.manager.snapshot().items[0].id), /其他 Codex 客户端/);
    assert.equal(JSON.parse(await f.active()).testEmail, 'external@example.com', 'Never overwrite another client\'s concurrent credential update.');
  });

  await fixture(async f => {
    await f.manager.add();
    const b = f.manager.snapshot().items[0];
    f.backend.failAfterRotation = true;
    await assert.rejects(f.manager.switchTo(b.id), /无法在线核验/);
    assert.equal(f.manager.snapshot().items.find(item => item.id === b.id).state, 'saved', 'A network/config read failure must not be labeled as expired authorization.');
    assert.equal(JSON.parse(await f.active()).testEmail, 'a@example.com');
  });

  await fixture(async f => {
    await f.manager.add();
    const b = f.manager.snapshot().items[0];
    const original = await f.active();
    f.backend.onRefresh = async () => { throw new AccountEnvironmentError('账户校验进程尚未退出'); };
    await assert.rejects(f.manager.switchTo(b.id), /进程尚未退出/);
    assert.equal(await f.active(), original);
    assert.equal(f.manager.snapshot().items.find(item => item.id === b.id).state, 'saved');
    assert.doesNotMatch(f.manager.snapshot().message, /在线核验|网络|登录已失效/);
    assert.equal(f.beforeCount(), 0);
  });

  await fixture(async f => {
    await f.manager.add();
    const b = f.manager.snapshot().items[0];
    const original = await f.active();
    const originalRm = fs.rm;
    let retryOptions;
    try {
      fs.rm = async (directory, options) => {
        if (path.dirname(directory) === path.join(f.storage, 'accounts') && path.basename(directory).startsWith('login-')) {
          retryOptions = options;
          throw Object.assign(new Error('Synthetic locked SQLite database'), { code: 'EBUSY' });
        }
        return originalRm(directory, options);
      };
      await assert.rejects(f.manager.switchTo(b.id), /临时目录.*占用/);
    } finally { fs.rm = originalRm; }
    assert.equal(retryOptions.maxRetries, 5);
    assert.equal(retryOptions.retryDelay, 150);
    assert.equal(await f.active(), original, 'Cleanup failure must prevent applying a candidate login.');
    assert.equal(f.manager.snapshot().items.find(item => item.id === b.id).state, 'saved');
    assert.doesNotMatch(f.manager.snapshot().message, /在线核验|网络|登录已失效/);
    assert.equal(f.beforeCount(), 0);
    assert.match(await f.secrets.get(`sponge.accounts.${b.id}`), /synthetic-rotated/, 'A cleanup failure must preserve refreshed saved credentials.');
  });

  await fixture(async f => {
    f.backend.waitForCancel = true;
    const add = f.manager.add();
    // Wait for the operation lock and cancellation controller, without assuming scheduling speed.
    for (let count = 0; !f.manager.snapshot().canCancel && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.manager.snapshot().canCancel, true);
    const other = f.create();
    await other.initialize();
    await assert.rejects(other.saveCurrent(), /另一个 VS Code 窗口/);
    f.manager.cancelLogin();
    await assert.rejects(add, /cancelled/);
    assert.deepEqual((await fs.readdir(path.join(f.storage, 'accounts'))).filter(name => name.startsWith('login-')), []);
    assert.equal(f.manager.snapshot().busy, false);
    await other.saveCurrent();
    await f.manager.refreshIndex();
    assert.equal(f.manager.snapshot().items.length, 1, 'Account metadata should be shared across windows.');
  });

  await fixture(async f => {
    await f.manager.add();
    const b = f.manager.snapshot().items[0];
    await fs.unlink(f.activeFile);
    await f.manager.switchTo(b.id);
    assert.equal(JSON.parse(await f.active()).testEmail, 'b@example.com', 'A saved valid account should work when currently logged out.');
    const reloaded = f.create();
    await reloaded.initialize();
    await fs.writeFile(f.activeFile, cache('external@example.com', 'account-external'));
    await assert.rejects(reloaded.verifyAfterReload(), /核验不一致/);
    assert.equal(reloaded.snapshot().phase, 'unverified');
  });

  await fixture(async f => {
    const original = await f.active();
    f.backend.store = 'keyring';
    await assert.rejects(f.manager.saveCurrent(), /凭据库/);
    assert.equal(await f.active(), original);
    assert.equal(f.vault.size, 0);
    f.backend.store = 'file';
    f.secrets.store = async () => { throw new Error('Synthetic secure storage failure'); };
    await assert.rejects(f.manager.saveCurrent(), /storage failure/);
    assert.equal(await f.active(), original);
    assert.equal(f.manager.snapshot().busy, false);
    assert.equal(f.manager.snapshot().items.length, 0, 'A secure-storage failure must not expose an unsaved account row.');
  });
  process.stdout.write('Saved-account isolation, rotation, cancellation, locking, rollback, reload and manual IDE confirmation checks passed.\n');
}

async function checkProtocol() {
  const Module = require('node:module');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const originalLoad = Module._load;
  let options;
  let child;
  Module._load = function (request, parent, isMain) {
    if (request === './cli' && parent.filename.endsWith('appServer.js')) return {
      spawnAppServer(_path, supplied) {
        options = supplied;
        child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; } });
        child.stdin.on('data', data => {
          const request = JSON.parse(data.toString());
          if (request.id !== undefined) child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
        });
        return child;
      }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  const { AppServerSession } = require('../dist/appServer.js');
  Module._load = originalLoad;
  const session = new AppServerSession('synthetic-cli', { env: { CODEX_HOME: 'synthetic-isolated-home' }, config: ['cli_auth_credentials_store="file"'] });
  await session.connect();
  assert.equal(options.env.CODEX_HOME, 'synthetic-isolated-home');
  const notifications = [];
  const unsubscribe = session.onNotification((method, params) => notifications.push({ method, params }));
  child.stdout.write('{"method":"account/login/completed","params":');
  child.stdout.write('{"success":true}}\n');
  assert.deepEqual(notifications, [{ method: 'account/login/completed', params: { success: true } }]);
  unsubscribe();
  child.stdout.write('{"method":"account/updated","params":{}}\n');
  assert.equal(notifications.length, 1);
  let stoppedAndClosed = false;
  const closing = session.stopAndWait().then(() => { stoppedAndClosed = true; });
  await Promise.resolve();
  assert.equal(child.killed, true);
  assert.equal(stoppedAndClosed, false, 'Sending a kill signal is not confirmation of process exit.');
  child.emit('close', 0);
  await closing;
  assert.equal(stoppedAndClosed, true);
  await session.stopAndWait();

  const blockedSession = new AppServerSession('synthetic-cli');
  await blockedSession.connect();
  await assert.rejects(blockedSession.stopAndWait(5), /退出超时/);
  child.emit('close', 0);

  let mode = 'success';
  let stopped = 0;
  let cancelled = 0;
  let opened = 0;
  let releaseClose;
  class FakeSession {
    constructor(_target, supplied) { options = supplied; }
    async connect() {}
    onNotification(listener) { this.listener = listener; return () => { this.listener = undefined; }; }
    async request(method) {
      if (method === 'account/login/start') {
        if (mode === 'success') this.listener('account/login/completed', { success: true, loginId: 'login-test' });
        return { loginId: 'login-test', authUrl: mode === 'badUrl' ? 'https://example.invalid/authorize' : 'https://auth.openai.com/authorize' };
      }
      if (method === 'account/login/cancel') { cancelled++; return {}; }
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'synthetic@example.com' } };
      if (method === 'config/read') return { config: { cli_auth_credentials_store: 'file' } };
      throw new Error('Unexpected protocol method');
    }
    async stopAndWait() {
      stopped++;
      if (mode === 'closeFailure') throw new Error('Synthetic exit timeout');
      if (mode === 'delayedClose') await new Promise(resolve => { releaseClose = resolve; });
    }
  }
  Module._load = function (request, parent, isMain) {
    if (request === './appServer' && parent.filename.endsWith('accountBackend.js')) return { AppServerSession: FakeSession };
    return originalLoad.call(this, request, parent, isMain);
  };
  const { CodexAccountBackend } = require('../dist/accountBackend.js');
  Module._load = originalLoad;
  let abortController = new AbortController();
  const backend = new CodexAccountBackend(() => ({ path: 'synthetic-cli', source: 'configured' }), async () => {
    opened++;
    if (mode === 'cancel') abortController.abort();
  });
  assert.equal((await backend.login('isolated-home', abortController.signal)).email, 'synthetic@example.com');
  assert.equal(options.env.CODEX_HOME, 'isolated-home');
  assert.deepEqual(options.config, ['cli_auth_credentials_store="file"']);
  mode = 'badUrl';
  await assert.rejects(backend.login('isolated-home', new AbortController().signal), /授权地址/);
  assert.equal(opened, 1, 'Never open an unrecognized OAuth host.');
  mode = 'cancel';
  abortController = new AbortController();
  await assert.rejects(backend.login('isolated-home', abortController.signal), /取消/);
  assert.equal(cancelled, 1);
  assert.equal(stopped, 3, 'Always close the dedicated login App Server.');
  mode = 'delayedClose';
  let accountReadComplete = false;
  const read = backend.read('isolated-home', false, true).then(value => { accountReadComplete = true; return value; });
  for (let count = 0; !releaseClose && count < 20; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseClose, 'function');
  assert.equal(accountReadComplete, false, 'Do not let the manager delete a home while its App Server still holds files.');
  releaseClose();
  assert.equal((await read).email, 'synthetic@example.com');
  mode = 'closeFailure';
  await assert.rejects(backend.read('isolated-home', false, true), AccountEnvironmentError);
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
