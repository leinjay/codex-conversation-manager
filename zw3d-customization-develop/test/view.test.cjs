const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise messages and timer callbacks without opening VS Code or a browser.
function dashboard(savedState) {
  let now = 10_000;
  let html = '';
  let elapsed = [];
  let tick;
  const listeners = {};
  const messages = [];
  const appListeners = {};
  let uiState = savedState;
  let focused;
  let timerId = 0;
  const timeouts = new Map();
  const partials = new Map();
  const app = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      elapsed = [...value.matchAll(/data-run-elapsed="(\w+)">([^<]+)/g)]
        .map(match => ({ dataset: { runElapsed: match[1] }, textContent: match[2] }));
    },
    querySelectorAll(selector) { return selector === '[data-run-elapsed]' ? elapsed : []; },
    querySelector(selector) {
      if (!partials.has(selector)) partials.set(selector, { focus: () => { focused = selector; } });
      return partials.get(selector);
    },
    addEventListener(type, callback) { appListeners[type] = callback; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/view.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message), getState: () => uiState, setState: value => { uiState = value; } }),
    document: { body: { dataset: {} }, getElementById: () => app },
    window: { addEventListener: (type, callback) => { listeners[type] = callback; } },
    Date: class extends Date { static now() { return now; } },
    setInterval: (callback, milliseconds) => { assert.equal(milliseconds, 1000); tick = callback; },
    setTimeout: (callback, milliseconds) => { const id = ++timerId; timeouts.set(id, { callback, at: now + milliseconds }); return id; },
    clearTimeout: id => timeouts.delete(id)
  });
  return {
    state: (runSession, busy = false, hostRunning = Boolean(runSession?.pid && !runSession.endedAt), extra = {}) =>
      listeners.message({ data: { type: 'state', project: { name: 'Demo', root: '/demo' }, runSession, busy, hostRunning, ...extra } }),
    tick: milliseconds => {
      now += milliseconds;
      tick();
      for (const [id, timer] of timeouts) {
        if (timer.at <= now) { timeouts.delete(id); timer.callback(); }
      }
    },
    time: profile => elapsed.find(element => element.dataset.runElapsed === profile).textContent,
    card: profile => html.slice(html.indexOf(`data-run-profile="${profile}"`)).split('<div class="build-panel"')[0].split('</section>')[0],
    select: profile => appListeners.click({ target: { closest: selector => selector === '[data-build-profile]' ? { dataset: { buildProfile: profile } } : null } }),
    search: value => appListeners.input({ target: { id: 'project-command-search', value } }),
    partial: selector => partials.get(selector),
    openUi: (file, root, disabled = false) => appListeners.click({ target: { closest: selector => selector === 'button[data-ui-file]' ? { dataset: { uiFile: file, uiRoot: root }, disabled } : null } }),
    key: (profile, key) => {
      let prevented = false;
      appListeners.keydown({ key, preventDefault: () => { prevented = true; }, target: { closest: () => ({ dataset: { buildProfile: profile } }) } });
      return prevented;
    },
    saved: () => uiState,
    focused: () => focused,
    html: () => html,
    messages
  };
}

test('run cards start idle and switch between play and stop with session state', () => {
  const view = dashboard();
  view.state();
  for (const profile of ['Release', 'Debug']) {
    assert.match(view.card(profile), /class="run-state">未运行/);
    assert.match(view.card(profile), new RegExp(`data-action="run${profile}"[^>]*><svg`));
    assert.match(view.card(profile), new RegExp(`data-action="restart${profile}"[^>]* disabled`));
    assert.equal(view.time(profile), '00:00:00');
  }
  const session = { id: 'owned', profile: 'Debug', state: 'running', pid: 123, startedAt: 10_000 };
  view.state(session);
  assert.match(view.card('Debug'), /class="run-state">已启动/);
  assert.match(view.card('Debug'), /data-action="stopDebug" data-run-id="owned"[^>]*><svg/);
  assert.match(view.card('Debug'), /data-action="restartDebug" data-run-id="owned"[^>]*><svg/);
  assert.match(view.card('Release'), /class="run-state">未运行/);
  view.state({ ...session, state: 'exited', endedAt: 12_000 });
  assert.match(view.card('Debug'), /class="run-state">未运行/);
  assert.match(view.card('Debug'), /data-action="runDebug"/);
  assert.doesNotMatch(view.card('Debug'), /data-action="stopDebug"/);
  assert.match(view.card('Debug'), /data-action="restartDebug"[^>]* disabled/);
  view.state({ id: 'failed', profile: 'Debug', state: 'failed', endedAt: 12_000, detail: '编译失败 <error>' });
  assert.match(view.card('Debug'), /class="run-state">未运行/);
  assert.match(view.card('Debug'), /编译失败 &lt;error&gt;/);
  assert.match(view.card('Debug'), /data-action="restartDebug"[^>]* disabled/);
  view.state({ id: 'pending', profile: 'Debug', state: 'building' }, true);
  assert.match(view.card('Debug'), /data-action="runDebug"[^>]* disabled/);
  assert.match(view.card('Debug'), /data-action="restartDebug" data-run-id="pending"[^>]* disabled/);
});

test('file card omits the filename and separate UI block, keeping its path and Designer links in plugin rows', () => {
  const view = dashboard();
  const entries = [
    { library: 'Box.so', command: '!Box', ui: { file: '/demo/forms/Box.ui', relative: 'forms/Box.ui' } },
    { library: 'Box.so', command: '~Plain' }
  ];
  view.state(undefined, false, false, { projectCommands: { root: '/demo', entries }, fileContext: { root: '/demo', file: '/demo/main.cpp', entries } });
  assert.doesNotMatch(view.html(), /class="file-name"|class="related-ui"|可能关联 UI|data-action="designer"/);
  assert.match(view.html(), /class="path file-context-path"[^>]*>\/demo\/main.cpp<\/p>/);
  assert.match(view.html(), /可能提供插件/);
  assert.match(view.html(), /title="用 Qt Designer 打开 forms\/Box.ui"/);
  assert.equal((view.html().match(/Box.so:!Box/g) || []).length, 4); // title and code in two sections
  assert.equal((view.html().match(/class="plugin-entry-icon"/g) || []).length, 2);
  assert.match(view.html(), /data-ui-file="\/demo\/forms\/Box.ui" data-ui-root="\/demo"[^>]*>Box.ui<\/button>/);
  assert.match(view.html(), /Box.so:~Plain/);
  assert.match(view.html(), /未关联 UI/);
  assert.doesNotMatch(view.html(), /id="project-command-search"/);
  view.openUi('/demo/forms/Box.ui', '/demo');
  assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))), { action: 'openUiDesigner', file: '/demo/forms/Box.ui', root: '/demo' });
  const count = view.messages.length;
  view.openUi('/demo/forms/Box.ui', '/demo', true);
  assert.equal(view.messages.length, count);
});

test('more than three project rows enable fuzzy search while displaying at most three rows', () => {
  const view = dashboard();
  const entries = ['Alpha', 'Beta', 'Gamma', 'FilletBox', '界面'].map(name => ({ library: 'Plugin.so', command: '~' + name, ui: { file: `/demo/forms/${name}.ui`, relative: `forms/${name}.ui` } }));
  view.state(undefined, false, false, { projectCommands: { root: '/demo', entries } });
  assert.match(view.html(), /id="project-command-search"/);
  const project = view.html().split('id="project-command-list">')[1].split('<small')[0];
  assert.equal((project.match(/class="plugin-entry"/g) || []).length, 3);
  assert.doesNotMatch(project, /FilletBox/);
  view.search('FLBX');
  assert.match(view.partial('#project-command-list').innerHTML, /Plugin.so:~FilletBox/);
  assert.match(view.partial('#project-command-count').textContent, /匹配 1 条/);
  view.search('plugin 界');
  assert.match(view.partial('#project-command-list').innerHTML, /界面.ui/);
  view.search('no-such-command');
  assert.match(view.partial('#project-command-list').innerHTML, /未找到匹配/);
  view.search('');
  assert.equal((view.partial('#project-command-list').innerHTML.match(/class="plugin-entry"/g) || []).length, 3);
  view.state(undefined, false, false, { projectCommands: { root: '/demo', entries: entries.slice(0, 3) } });
  assert.doesNotMatch(view.html(), /id="project-command-search"/);
});

test('row content and search strings are escaped and filtering survives ordinary state refreshes', () => {
  const view = dashboard();
  const entries = ['Alpha', 'Beta', 'Gamma', '<script>'].map(name => ({ library: 'Plugin.so', command: '~' + name, ui: { file: `/demo/"${name}.ui`, relative: `"${name}.ui` } }));
  view.state(undefined, false, false, { projectCommands: { root: '/demo', entries } });
  view.search('<script>');
  assert.doesNotMatch(view.partial('#project-command-list').innerHTML, /<script>/);
  assert.match(view.partial('#project-command-list').innerHTML, /&lt;script&gt;/);
  view.state(undefined, false, false, { projectCommands: { root: '/demo', entries } });
  assert.match(view.html(), /value="&lt;script&gt;"/);
  assert.doesNotMatch(view.html(), /<script>/);
});

test('header profile text switches and keeps the current type first without sending a build command', () => {
  const view = dashboard();
  const extra = { project: { name: 'Demo', root: '/demo', buildProfile: 'Debug', cmakeArgsByProfile: { Release: '-DOPT=ON', Debug: '-DTRACE=ON' } } };
  view.state(undefined, false, false, extra);
  assert.equal((view.html().match(/<section aria-labelledby="build-heading">/g) || []).length, 1);
  assert.doesNotMatch(view.html(), /<button[^>]*data-build-profile/);
  assert.doesNotMatch(view.html(), /class="build-tabs"/);
  assert.ok(view.html().indexOf('id="build-heading"') < view.html().indexOf('id="build-tab-Debug"'));
  assert.ok(view.html().indexOf('id="build-tab-Debug"') < view.html().indexOf('id="build-tab-Release"'));
  assert.match(view.html(), /id="build-tab-Debug"[^>]*aria-selected="true"/);
  assert.match(view.html(), /id="build-panel-Release"[^>]* hidden/);
  assert.match(view.html(), /data-action="configureCmakeDebug"[^>]*-DTRACE=ON/);
  view.select('Release');
  assert.ok(view.html().indexOf('id="build-tab-Release"') < view.html().indexOf('id="build-tab-Debug"'));
  assert.match(view.html(), /id="build-tab-Release"[^>]*aria-selected="true"/);
  assert.match(view.html(), /id="build-panel-Debug"[^>]* hidden/);
  assert.doesNotMatch(view.html(), /id="build-panel-Release"[^>]* hidden/);
  assert.match(view.html(), /class="build-directory"[^>]*>build_release/);
  assert.match(view.html(), /data-action="configureCmakeRelease"[^>]*-DOPT=ON/);
  assert.equal(view.focused(), '#build-tab-Release');
  assert.equal(view.saved().buildProfile, 'Release');
  assert.equal(view.messages.filter(message => message.action !== 'ready').length, 0);
  view.state(undefined, false, false, extra);
  assert.match(view.html(), /id="build-tab-Release"[^>]*aria-selected="true"/, 'background refresh preserves the chosen tab');
  const reloaded = dashboard(view.saved());
  reloaded.state(undefined, false, false, extra);
  assert.match(reloaded.html(), /id="build-tab-Release"[^>]*aria-selected="true"/);
  reloaded.state(undefined, false, false, { project: { name: 'Other', root: '/other', buildProfile: 'Debug' } });
  assert.match(reloaded.html(), /id="build-tab-Debug"[^>]*aria-selected="true"/, 'a different project uses its configured build profile');
});

test('keyboard profile selection works when ZW3D is closed and stays locked while it is open', () => {
  const view = dashboard();
  view.state();
  view.select('Release');
  assert.equal(view.key('Release', 'ArrowRight'), true);
  assert.equal(view.focused(), '#build-tab-Debug');
  assert.equal(view.key('Debug', 'End'), true);
  assert.equal(view.focused(), '#build-tab-Release');
  assert.equal(view.key('Release', 'Home'), true);
  assert.equal(view.focused(), '#build-tab-Release');
  assert.equal(view.key('Release', 'ArrowLeft'), true);
  assert.equal(view.focused(), '#build-tab-Debug');
  assert.equal(view.key('Release', 'Enter'), true);
  assert.equal(view.focused(), '#build-tab-Release');
  assert.equal(view.key('Debug', ' '), true);
  assert.equal(view.focused(), '#build-tab-Debug');
  const session = { id: 'owned', profile: 'Release', state: 'running', pid: 123, startedAt: 10_000 };
  view.state(session);
  assert.match(view.html(), /id="build-tab-Release"[^>]*aria-selected="true"/);
  assert.match(view.html(), /title="Release · ZW3D 已启动"/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'End', 'Enter', ' ']) {
    view.key(key === 'Enter' || key === ' ' ? 'Debug' : 'Release', key);
    assert.match(view.html(), /id="build-tab-Release"[^>]*aria-selected="true"/);
    assert.equal(view.focused(), '#build-tab-Release');
  }
  view.tick(1000);
  assert.equal(view.time('Release'), '00:00:01');
  assert.match(view.card('Release'), /data-action="stopRelease" data-run-id="owned"[^>]*><svg/);
  view.state({ ...session, state: 'exited', endedAt: 11_000 });
  view.select('Debug');
  assert.match(view.html(), /id="build-tab-Debug"[^>]*aria-selected="true"/);
});

test('an open host blocks profile changes and restores the normal status exactly ten seconds after the last attempt', () => {
  const view = dashboard();
  view.state();
  assert.doesNotMatch(view.html(), /class="build-running-hint"/);
  for (const profile of ['Release', 'Debug']) {
    const other = profile === 'Release' ? 'Debug' : 'Release';
    const session = { id: `owned-${profile}`, profile, state: 'running', pid: 123, startedAt: 10_000 };
    view.state(session);
    const saved = JSON.stringify(view.saved());
    view.select(other);
    assert.match(view.html(), new RegExp(`id="build-tab-${profile}"[^>]*aria-selected="true"`));
    assert.match(view.html(), new RegExp(`class="build-directory"[^>]*>build_${profile.toLowerCase()}`));
    assert.match(view.html(), new RegExp(`ZW3D 已通过 ${profile} 启动，无法切换构建类型，请先关闭 ZW3D。`));
    assert.equal(JSON.stringify(view.saved()), saved, 'rejected selection must not alter the remembered type');
    view.tick(6000);
    view.state(session);
    view.select(other); // Another attempt restarts the ten second notice.
    view.tick(9999);
    view.state(session); // Background refresh must retain the active notice.
    assert.match(view.html(), /无法切换构建类型/);
    view.tick(1);
    assert.doesNotMatch(view.html(), /无法切换构建类型/);
    assert.match(view.html(), new RegExp(`ZW3D 已通过 ${profile} 启动。`));
    view.state({ ...session, state: 'paused' });
    view.select(other);
    assert.match(view.html(), /无法切换构建类型/);
    view.state({ ...session, state: 'exited', endedAt: 12_000 });
    assert.doesNotMatch(view.html(), /class="build-running-hint"/);
    view.select(other);
    assert.match(view.html(), new RegExp(`id="build-tab-${other}"[^>]*aria-selected="true"`));
    view.tick(10000);
    assert.doesNotMatch(view.html(), /class="build-running-hint"/, 'old timers cannot resurrect notices after exit');
  }
  view.state(undefined, false, true, { hostProfile: 'Release' });
  view.select('Debug');
  assert.match(view.html(), /无法切换构建类型/);
  view.tick(10000);
  assert.match(view.html(), /ZW3D 已通过 Release 启动。/);
  assert.equal(view.messages.filter(message => message.action !== 'ready').length, 0);
});

test('restoration and command updates keep the displayed type on the running host', () => {
  const view = dashboard({ profileRoot: '/demo', buildProfile: 'Debug' });
  const session = { id: 'owned', profile: 'Release', state: 'running', pid: 123, startedAt: 10_000 };
  view.state(session, false, true, { selectedAction: 'buildDebug' });
  assert.match(view.html(), /id="build-tab-Release"[^>]*aria-selected="true"/);
  view.select('Debug');
  assert.match(view.html(), /无法切换构建类型/);
  view.state({ ...session, id: 'new-session' });
  assert.doesNotMatch(view.html(), /无法切换构建类型/, 'a different session clears the old notice');
});

test('commands selecting a different build profile reveal its tab without later refreshes undoing manual switches', () => {
  const view = dashboard();
  view.state();
  view.state(undefined, false, false, { selectedAction: 'buildRelease' });
  assert.match(view.html(), /id="build-tab-Release"[^>]*aria-selected="true"/);
  view.select('Debug');
  view.state(undefined, false, false, { selectedAction: 'buildRelease' });
  assert.match(view.html(), /id="build-tab-Debug"[^>]*aria-selected="true"/);
});

test('a running host disables start and restart in the other build profile until it exits', () => {
  const view = dashboard();
  for (const profile of ['Release', 'Debug']) {
    const other = profile === 'Release' ? 'Debug' : 'Release';
    const session = { id: 'owned', profile, state: 'running', pid: 123, startedAt: 10_000 };
    for (const state of ['running', 'paused', 'stopping']) {
      view.state({ ...session, state });
      assert.match(view.card(other), new RegExp(`data-action="run${other}"[^>]* disabled`));
      assert.match(view.card(other), new RegExp(`data-action="restart${other}"[^>]* disabled`));
    }
    view.state(session);
    assert.match(view.card(profile), new RegExp(`data-action="stop${profile}"[^>]*><svg`));
    assert.match(view.card(profile), new RegExp(`data-action="restart${profile}"[^>]*><svg`));
    view.state({ ...session, state: 'exited', endedAt: 12_000 });
    assert.match(view.card(other), new RegExp(`data-action="run${other}"[^>]*><svg`));
    assert.match(view.card(other), new RegExp(`data-action="restart${other}"[^>]* disabled`));
  }
  // Switching projects hides the previous session card but must keep its launch lock.
  view.state(undefined, false, true);
  for (const profile of ['Release', 'Debug']) {
    assert.match(view.card(profile), new RegExp(`data-action="run${profile}"[^>]* disabled`));
    assert.match(view.card(profile), new RegExp(`data-action="restart${profile}"[^>]* disabled`));
  }
  view.state();
  assert.match(view.card('Release'), /data-action="runRelease"[^>]*><svg/);
  assert.match(view.card('Debug'), /data-action="runDebug"[^>]*><svg/);
});

test('elapsed time ticks independently each second, includes hours and freezes after exit', () => {
  const view = dashboard();
  const session = { id: 'owned', profile: 'Debug', state: 'running', pid: 123, startedAt: 10_000 };
  view.state(session);
  const html = view.html();
  view.tick(1000);
  assert.equal(view.time('Debug'), '00:00:01');
  view.tick(1000);
  assert.equal(view.time('Debug'), '00:00:02');
  assert.equal(view.time('Release'), '00:00:00');
  assert.equal(view.html(), html, 'ticking must not rebuild the dashboard');
  view.tick(3_598_000);
  assert.equal(view.time('Debug'), '01:00:00');
  view.state(session);
  assert.equal(view.time('Debug'), '01:00:00', 'state refresh must preserve elapsed time');
  view.state({ ...session, state: 'exited', endedAt: 3_610_000 });
  view.tick(1000);
  assert.equal(view.time('Debug'), '01:00:00');
  view.state({ ...session, state: 'exited', endedAt: 360_010_000 });
  assert.equal(view.time('Debug'), '100:00:00');
  view.state({ ...session, id: 'new-session', startedAt: 3_611_000 });
  assert.equal(view.time('Debug'), '00:00:00', 'new launches reset the timer');
});
