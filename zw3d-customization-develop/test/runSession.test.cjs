const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inspectHost, RestoredHost, stopOwnedHost } = require('../dist/hostProcess');
const { savedRunSession, runSessionKey } = require('../dist/runSession');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain); };
const { Workbench } = require('../dist/extension');
Module._load = originalLoad;

async function fixture(t, ignoreTerm = false) {
  // The launcher exits first: the restored host really is no longer our child.
  const script = `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}setInterval(()=>{},1000);`;
  const launcher = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(script)}],{detached:true,stdio:'ignore'});child.once('spawn',()=>{console.log(child.pid);child.unref();});`;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', launcher]);
  const pid = Number(stdout.trim());
  const current = await inspectHost(pid);
  assert.ok(current);
  const identity = current.identity;
  t.after(async () => { await stopOwnedHost(new RestoredHost(identity), 100); });
  return { id: 'saved-session', root: '/original/project', profile: 'Release', state: 'running',
    pid, startedAt: Date.now() - 3_600_000, identity };
}
function store(initial) {
  let value = structuredClone(initial);
  return {
    get: key => { assert.equal(key, runSessionKey); return structuredClone(value); },
    update: async (key, next) => { assert.equal(key, runSessionKey); value = structuredClone(next); }
  };
}
function workbench(storage) {
  const instance = Object.create(Workbench.prototype);
  instance.context = { workspaceState: storage };
  instance.persistenceTask = Promise.resolve();
  instance.log = () => {};
  instance.refresh = () => instance.persistRunSession();
  instance.operation = async (_title, action) => action(new AbortController().signal);
  return instance;
}

test('restore a detached host after its launcher exits, retaining profile, PID and original timer', async t => {
  const session = await fixture(t);
  const storage = store(session);
  const instance = workbench(storage);
  await instance.restoreHost();
  assert.ok(instance.activeHost instanceof RestoredHost);
  assert.equal(instance.runSession.profile, 'Release');
  assert.equal(instance.runSession.pid, session.pid);
  assert.equal(instance.runSession.startedAt, session.startedAt);
  assert.equal(instance.runSession.state, 'running');
  assert.equal(instance.selectedRoot, session.root);
  process.kill(-session.pid, 'SIGSTOP');
  for (let attempt = 0; attempt < 20 && instance.runSession.state !== 'paused'; attempt++) {
    await instance.pollHost();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(instance.runSession.state, 'paused');
  process.kill(-session.pid, 'SIGCONT');
  await instance.pollHost();
  await instance.controlRun('Release', false, session.id);
  assert.equal(instance.activeHost, undefined);
  assert.equal(instance.runSession.state, 'exited');
  assert.ok(instance.runSession.endedAt >= session.startedAt);
  await instance.persistenceTask;
  const next = workbench(storage);
  await next.restoreHost();
  assert.equal(next.activeHost, undefined);
  assert.equal(next.runSession.endedAt, instance.runSession.endedAt, 'closed sessions keep their frozen timer');
});

test('a restored host can restart only after closing the original process and keeps project/profile', async t => {
  const session = await fixture(t);
  const instance = workbench(store(session));
  await instance.restoreHost();
  let restarted;
  instance.execute = async (action, profile, previous) => {
    await instance.closeHost(previous);
    assert.equal(await inspectHost(session.pid), undefined);
    restarted = { action, profile, root: previous.root };
  };
  await instance.controlRun('Release', true, session.id);
  assert.deepEqual(restarted, { action: 'run', profile: 'Release', root: session.root });
});

test('restoration and close reject reused PIDs, other boots and different executables without touching the live host', async t => {
  const session = await fixture(t);
  for (const mismatch of [{ startTicks: '0' }, { bootId: 'previous-boot' }, { executable: '/unrelated/program' }]) {
    const record = { ...session, identity: { ...session.identity, ...mismatch } };
    const instance = workbench(store(record));
    await instance.restoreHost();
    assert.equal(instance.activeHost, undefined);
    assert.equal(instance.runSession.state, 'exited');
    await stopOwnedHost(new RestoredHost(record.identity), 10);
    assert.ok(await inspectHost(session.pid), 'identity mismatch must not signal the actual host');
  }
});

test('polling a recovered host observes external exit and releases the launch lock', async t => {
  const session = await fixture(t);
  const instance = workbench(store(session));
  await instance.restoreHost();
  await stopOwnedHost(new RestoredHost(session.identity), 100);
  await instance.pollHost();
  assert.equal(instance.activeHost, undefined);
  assert.equal(instance.runSession.state, 'exited');
  await instance.persistenceTask;
  const missing = workbench(store(session));
  await missing.restoreHost();
  assert.equal(missing.activeHost, undefined);
  assert.match(missing.runSession.detail, /准确退出时间未知/);
});

test('restored hosts ignoring graceful close are killed before returning', async t => {
  const session = await fixture(t, true);
  // Wait for the detached Node process to install its SIGTERM handler.
  await new Promise(resolve => setTimeout(resolve, 150));
  const host = new RestoredHost(session.identity);
  await stopOwnedHost(host, 50);
  assert.equal(await inspectHost(session.pid), undefined);
  assert.equal(host.exitCode, 0);
});

test('invalid saved records never authorize process controls and interrupted builds restore as stopped', async () => {
  const base = { id: 'saved', root: '/project', profile: 'Debug', state: 'building' };
  for (const record of [null, {}, { ...base, root: 'relative' }, { ...base, profile: 'Other' },
    { ...base, pid: 0 }, { ...base, startedAt: 'invalid' }, { ...base, identity: { pid: 2 } }]) {
    assert.equal(savedRunSession(record), undefined);
    const instance = workbench(store(record));
    await instance.restoreHost();
    assert.equal(instance.activeHost, undefined);
  }
  const instance = workbench(store(base));
  await instance.restoreHost();
  assert.equal(instance.runSession.state, 'exited');
  assert.equal(instance.activeHost, undefined);
});

test('commands wait for session restoration before accepting another operation', async () => {
  const instance = workbench(store());
  instance.busy = true;
  let finish;
  instance.restoreTask = new Promise(resolve => { finish = resolve; });
  let settled = false;
  const command = instance.execute('run', 'Debug').finally(() => { settled = true; });
  const rejection = assert.rejects(command, /已有操作/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  await rejection;
});

test('session writes stay ordered and a failed persistence attempt can be retried', async () => {
  const storage = store();
  let fail = true;
  const writes = [];
  const instance = workbench({ ...storage, update: async (key, value) => {
    if (fail) { fail = false; throw new Error('temporary write failure'); }
    await new Promise(resolve => setImmediate(resolve));
    writes.push(value.state);
    await storage.update(key, value);
  } });
  instance.runSession = { id: 'saved', root: '/project', profile: 'Debug', state: 'building' };
  await instance.persistRunSession();
  const building = instance.persistRunSession();
  instance.runSession.state = 'starting';
  const starting = instance.persistRunSession();
  instance.runSession.state = 'exited';
  instance.runSession.endedAt = Date.now();
  await instance.persistRunSession();
  await Promise.all([building, starting]);
  assert.deepEqual(writes, ['building', 'starting', 'exited']);
  assert.equal(storage.get(runSessionKey).state, 'exited');
});

test('late exit callbacks from disposed or superseded sessions cannot overwrite saved state', async () => {
  const { EventEmitter } = require('node:events');
  for (const disposed of [true, false]) {
    const instance = workbench(store());
    const previous = { id: 'old', root: '/project', profile: 'Debug', state: 'running' };
    const current = { ...previous, id: 'new' };
    instance.runSession = disposed ? previous : current;
    instance.disposed = disposed;
    const host = new EventEmitter();
    instance.watchHost(host, previous);
    host.emit('exit', 0, null);
    await instance.persistenceTask;
    assert.equal(previous.state, 'running');
    assert.equal(instance.context.workspaceState.get(runSessionKey), undefined);
  }
});
