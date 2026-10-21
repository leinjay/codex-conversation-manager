const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
  return originalLoad.call(this, request, parent, isMain);
};
const { SessionManager } = require("../dist/sessionManager.js");
const { StartupConversation } = require("../dist/startupConversation.js");
const { formatThreadDeleteError } = require("../dist/dataService.js");
const { startSessionListAutoRefresh, SESSION_LIST_REFRESH_INTERVAL_MS } = require("../dist/autoRefresh.js");

const activeWriterThreadId = "01a0e721-b0f7-7f00-9610-44d0aaa41141";
const activeWriterMessage = formatThreadDeleteError(
  new Error(`thread ${activeWriterThreadId} already has an active writer`),
  activeWriterThreadId
);
assert.match(activeWriterMessage, /仍被 Codex 客户端占用/);
assert.match(activeWriterMessage, /结束当前任务并关闭该会话/);
assert.match(activeWriterMessage, /刷新列表再重试/);
assert.equal(formatThreadDeleteError(new Error("permission denied"), activeWriterThreadId), "permission denied");

function makeRecord(source, index) {
  return {
    key: source + ":" + index,
    source,
    id: source + "-" + index,
    title: "Session " + index,
    projectLabel: source === "local" ? "C:\\repo" : "environment",
    updatedAt: 1_000_000 + index,
    createdAt: 1_000_000 + index,
    recencyAt: 1_000_000 + index,
    raw: {}
  };
}

function pages(records, size) {
  return async cursor => {
    const start = cursor ? Number(cursor) : 0;
    const data = records.slice(start, start + size);
    const next = start + data.length;
    return { records: data, cursor: next < records.length ? String(next) : null };
  };
}

function fakeData(localRecords, cloudRecords, failLocal = false) {
  const localPage = pages(localRecords, 25);
  const cloudPage = pages(cloudRecords, 20);
  return {
    async getLocalPage(cursor) {
      if (failLocal) throw new Error("local source unavailable");
      return localPage(cursor);
    },
    getCloudPage: cursor => cloudPage(cursor),
    async getUsage() { return undefined; },
    dispose() {}
  };
}

async function main() {
  let scheduledCallback;
  let scheduledDelay;
  let timerDisposed = false;
  let refreshRuns = 0;
  const refreshErrors = [];
  let releaseFirstRefresh;
  const firstRefresh = new Promise(resolve => { releaseFirstRefresh = resolve; });
  const autoRefreshTimer = startSessionListAutoRefresh(
    () => {
      refreshRuns += 1;
      if (refreshRuns === 1) return firstRefresh;
      if (refreshRuns === 2) return Promise.reject(new Error("refresh failed"));
      return Promise.resolve();
    },
    error => refreshErrors.push(error.message),
    (callback, intervalMs) => {
      scheduledCallback = callback;
      scheduledDelay = intervalMs;
      return { dispose() { timerDisposed = true; } };
    }
  );
  assert.equal(scheduledDelay, SESSION_LIST_REFRESH_INTERVAL_MS);
  assert.equal(scheduledDelay, 15 * 60_000, "Session records should refresh every 15 minutes.");
  const flushRefresh = () => new Promise(resolve => setImmediate(resolve));
  scheduledCallback();
  await flushRefresh();
  assert.equal(refreshRuns, 1);
  scheduledCallback();
  await flushRefresh();
  assert.equal(refreshRuns, 1, "The timer should not start a second list refresh while one is running.");
  releaseFirstRefresh();
  await flushRefresh();
  scheduledCallback();
  await flushRefresh();
  assert.equal(refreshRuns, 2);
  assert.deepEqual(refreshErrors, ["refresh failed"]);
  scheduledCallback();
  await flushRefresh();
  assert.equal(refreshRuns, 3, "The timer should continue after reporting a failed refresh.");
  autoRefreshTimer.dispose();
  assert.equal(timerDisposed, true, "The timer should be disposed with the extension.");

  const cli = { source: "PATH", path: "codex.exe", hostEnvironment: "Windows" };
  const local = Array.from({ length: 60 }, (_, index) => makeRecord("local", 60 - index));
  let lastEmittedRefreshTime;
  const manager = new SessionManager(fakeData(local, []), () => cli, snapshot => {
    lastEmittedRefreshTime = snapshot.listRefreshedAt;
  });
  await manager.initialize();
  assert.ok(Number.isFinite(manager.snapshot().listRefreshedAt), "The initial session load should expose its completion time.");
  assert.equal(lastEmittedRefreshTime, manager.snapshot().listRefreshedAt, "A completed list refresh should emit its timestamp for the manager bar.");
  const initialRefreshTime = manager.snapshot().listRefreshedAt;
  await manager.refreshList();
  assert.ok(manager.snapshot().listRefreshedAt >= initialRefreshTime, "A manual list refresh should update the completion time.");
  assert.equal(lastEmittedRefreshTime, manager.snapshot().listRefreshedAt, "Manual refresh completion should emit the timestamp shown in the manager bar.");
  let managerRefreshCallback;
  const managerRefreshTimer = startSessionListAutoRefresh(
    () => manager.refreshList(),
    error => { throw error; },
    callback => {
      managerRefreshCallback = callback;
      return { dispose() {} };
    }
  );
  managerRefreshCallback();
  await flushRefresh();
  assert.equal(lastEmittedRefreshTime, manager.snapshot().listRefreshedAt, "A scheduled list refresh should emit its completion time to the manager bar.");
  managerRefreshTimer.dispose();
  const duplicatePathRecords = [
    { ...makeRecord("local", 700), projectLabel: "D:\\code\\transformers" },
    { ...makeRecord("local", 700), title: "Duplicate transport row", projectLabel: "D:\\code\\transformers" },
    { ...makeRecord("local", 701), title: "Session 700", projectLabel: "D:\\code\\transformers" }
  ];
  const duplicatePathManager = new SessionManager(
    fakeData(duplicatePathRecords, []),
    () => cli,
    () => {},
    "D:\\code\\transformers"
  );
  await duplicatePathManager.initialize();
  const duplicatePathSnapshot = duplicatePathManager.snapshot();
  assert.equal(duplicatePathSnapshot.projectFilter, "D:\\code\\transformers");
  assert.equal(duplicatePathSnapshot.totalLoaded, 2, "Repeated IDs within one App Server page should be stored only once.");
  assert.equal(duplicatePathSnapshot.records.length, 2);
  assert.equal(new Set(duplicatePathSnapshot.records.map(record => record.id)).size, 2);
  assert.ok(duplicatePathSnapshot.records.every(record => record.title === "Session 700"), "A distinct thread with the same title should remain visible while the repeated ID is removed.");

  let releaseConcurrentRead;
  const concurrentRead = new Promise(resolve => { releaseConcurrentRead = resolve; });
  const concurrentRefreshData = fakeData([makeRecord("local", 601)], []);
  const getConcurrentLocalPage = concurrentRefreshData.getLocalPage;
  let concurrentLocalReads = 0;
  concurrentRefreshData.getLocalPage = async cursor => {
    concurrentLocalReads += 1;
    if (concurrentLocalReads === 2) await concurrentRead;
    return getConcurrentLocalPage(cursor);
  };
  const concurrentManager = new SessionManager(concurrentRefreshData, () => cli, () => {});
  await concurrentManager.initialize();
  const firstConcurrentRefresh = concurrentManager.refreshList();
  const secondConcurrentRefresh = concurrentManager.refreshList();
  assert.equal(concurrentLocalReads, 2, "Concurrent manual and scheduled requests should share one in-flight list refresh.");
  releaseConcurrentRead();
  await Promise.all([firstConcurrentRefresh, secondConcurrentRefresh]);
  assert.equal(concurrentLocalReads, 2);
  assert.equal(manager.snapshot().records.length, 20);
  assert.equal(manager.snapshot().pageIndex, 0);

  await manager.nextPage();
  assert.equal(manager.snapshot().pageIndex, 1);
  assert.equal(manager.snapshot().records.length, 20);
  assert.equal(manager.snapshot().records[0].key, "local:40");

  await manager.nextPage();
  assert.equal(manager.snapshot().pageIndex, 2);
  assert.equal(manager.snapshot().records.length, 20);
  assert.equal(manager.snapshot().records[0].key, "local:20");

  await manager.nextPage();
  assert.equal(manager.snapshot().pageIndex, 2, "The pager advanced past the final page.");
  assert.equal(manager.snapshot().hasMore, false);

  const alternateSourceManager = new SessionManager(
    fakeData([], Array.from({ length: 3 }, (_, index) => makeRecord("cloud", index)), true),
    () => cli,
    () => {}
  );
  await alternateSourceManager.initialize();
  assert.equal(alternateSourceManager.snapshot().records.length, 3);
  assert.match(alternateSourceManager.snapshot().errors.local, /unavailable/);
  assert.equal(alternateSourceManager.snapshot().records[0].source, "cloud");

  const lockedRecord = makeRecord("local", 501);
  const lockedData = fakeData([lockedRecord], []);
  lockedData.deleteThread = async () => { throw new Error("already has an active writer"); };
  const lockedManager = new SessionManager(lockedData, () => cli, () => {});
  await lockedManager.initialize();
  await assert.rejects(lockedManager.delete(lockedManager.snapshot().records[0]), /active writer/);
  assert.equal(lockedManager.snapshot().records[0].id, lockedRecord.id, "A rejected deletion must leave the local conversation visible.");

  const pathVariants = [
    { ...makeRecord("local", 1), projectLabel: "d:\\code\\transformers" },
    { ...makeRecord("local", 2), projectLabel: "D:\\code\\transformers" },
    { ...makeRecord("local", 3), projectLabel: "/workspace/App" },
    { ...makeRecord("local", 4), projectLabel: "/workspace/app" }
  ];
  const projectManager = new SessionManager(fakeData(pathVariants, []), () => cli, () => {}, "d:\\code\\transformers");
  await projectManager.initialize();
  const projects = projectManager.snapshot().projects;
  assert.equal(projects.length, 3, "Case variants of a Windows path should appear only once while POSIX paths remain case-sensitive.");
  assert.ok(projects.includes("D:\\code\\transformers"), "The drive letter should display in uppercase.");
  assert.ok(projects.includes("/workspace/App"));
  assert.ok(projects.includes("/workspace/app"));
  assert.equal(projectManager.snapshot().projectFilter, "D:\\code\\transformers", "The current workspace project should be selected by default when present.");
  assert.equal(projectManager.snapshot().filteredCount, 2, "The default workspace filter should include Windows path case variants.");
  const noWorkspaceMatch = new SessionManager(fakeData(pathVariants, []), () => cli, () => {}, "D:\\other-project");
  await noWorkspaceMatch.initialize();
  assert.equal(noWorkspaceMatch.snapshot().projectFilter, "D:\\other-project", "Keep the current workspace filter even when it has no conversation.");
  assert.equal(noWorkspaceMatch.snapshot().records.length, 0, "Never substitute sessions belonging to other projects.");
  assert.ok(noWorkspaceMatch.snapshot().projects.includes("D:\\other-project"), "An empty project remains selectable.");
  await noWorkspaceMatch.refresh();
  assert.equal(noWorkspaceMatch.snapshot().records.length, 0, "Refresh must retain the empty workspace selection.");
  const olderProjectRecords = Array.from({ length: 26 }, (_, index) => makeRecord("local", index + 1));
  olderProjectRecords[25].projectLabel = "D:\\workspace\\current";
  const olderWorkspaceProject = new SessionManager(fakeData(olderProjectRecords, []), () => cli, () => {}, "d:\\workspace\\current");
  await olderWorkspaceProject.initialize();
  assert.equal(olderWorkspaceProject.snapshot().projectFilter, "D:\\workspace\\current", "The default project should be found after scanning beyond the initial page.");
  assert.equal(olderWorkspaceProject.snapshot().filteredCount, 1);
  let persistedFilters;
  const savedLocal = [
    { ...makeRecord('local', 51), title: 'Wanted newest', projectLabel: '/workspace/current' },
    { ...makeRecord('local', 42), title: 'Wanted oldest', projectLabel: '/workspace/current' },
    { ...makeRecord('local', 100), title: 'Wanted another project', projectLabel: '/workspace/other' },
    { ...makeRecord('local', 1), title: 'Excluded title', projectLabel: '/workspace/current' }
  ];
  const savedManager = new SessionManager(fakeData(savedLocal, []), () => cli, () => {}, '/workspace/current', undefined, filters => { persistedFilters = filters; });
  await savedManager.initialize();
  await savedManager.setSource('local');
  await savedManager.setSearch('Wanted');
  await savedManager.setSort('created', 'asc');
  const expectedKeys = savedManager.snapshot().records.map(row => row.key);
  assert.deepEqual(expectedKeys, ['local:42', 'local:51']);
  const initialStates = [];
  const reopened = new SessionManager(fakeData(savedLocal, []), () => cli, snapshot => initialStates.push(snapshot), '/workspace/current', persistedFilters);
  await reopened.initialize();
  assert.deepEqual(reopened.filters(), persistedFilters);
  assert.deepEqual(reopened.snapshot().records.map(row => row.key), expectedKeys, 'Reopening restores every filter and the selected ordering.');
  assert.ok(initialStates.every(snapshot => snapshot.records.every(row => row.projectLabel === '/workspace/current' && row.title.includes('Wanted'))), 'Do not flash unfiltered records during initialization.');
  await reopened.refreshList();
  assert.deepEqual(reopened.snapshot().records.map(row => row.key), expectedKeys, 'Refresh keeps search, source, project, and sorting.');
  await reopened.setProject('/workspace/empty');
  await reopened.refreshList();
  assert.equal(reopened.snapshot().projectFilter, '/workspace/empty');
  assert.equal(reopened.snapshot().records.length, 0);
  const resetAll = new SessionManager(fakeData(savedLocal, []), () => cli, () => {}, '/workspace/current', { projectFilter: '' });
  await resetAll.initialize();
  assert.equal(resetAll.snapshot().filteredCount, savedLocal.length, 'An explicitly saved all-projects choice must survive reopening.');

  const opened = [];
  const startup = new StartupConversation(true, async () => {}, async row => { opened.push(row.key); });
  await startup.restore(() => savedManager.snapshot());
  await startup.restore(() => savedManager.snapshot());
  assert.deepEqual(opened, ['local:42'], 'Startup opens only the first filtered and sorted result, exactly once.');
  await savedManager.refreshList();
  await startup.restore(() => savedManager.snapshot());
  assert.equal(opened.length, 1, 'Refresh never changes the selected Codex conversation.');
  await new StartupConversation(true, async () => {}, async () => { throw new Error('Should not open from empty results'); }).restore(() => reopened.snapshot());
  await new StartupConversation(false, async () => {}, async () => { throw new Error('Should not open in a remote/no-project workspace'); }).restore(() => savedManager.snapshot());
  const cloudFirst = { ...savedManager.snapshot(), records: [makeRecord('cloud', 1), ...savedManager.snapshot().records] };
  await new StartupConversation(true, async () => {}, async () => { throw new Error('Never skip the first result to open another local result'); }).restore(() => cloudFirst);
  let releasePreparation;
  const cancelled = new StartupConversation(true, () => new Promise(resolve => { releasePreparation = resolve; }), async () => { throw new Error('User interaction must win over startup selection'); });
  const restoring = cancelled.restore(() => savedManager.snapshot());
  cancelled.cancel();
  releasePreparation();
  await restoring;
  let currentSnapshot = savedManager.snapshot();
  const changedDuringPrepare = new StartupConversation(true, async () => { currentSnapshot = { ...currentSnapshot, records: [] }; }, async () => { throw new Error('Do not open a record that no longer matches'); });
  await changedDuringPrepare.restore(() => currentSnapshot);

  let releaseOldPage;
  let localRequests = 0;
  const concurrentSort = new SessionManager({ ...fakeData([], []), getLocalPage: async () => {
    localRequests++;
    if (localRequests === 1) return new Promise(resolve => { releaseOldPage = resolve; });
    return { records: [makeRecord('local', 2)], cursor: null };
  } }, () => cli, () => {});
  const initializing = concurrentSort.initialize();
  await concurrentSort.setSort('created', 'asc');
  releaseOldPage({ records: [makeRecord('local', 999)], cursor: null });
  await initializing;
  assert.deepEqual(concurrentSort.snapshot().records.map(row => row.key), ['local:2'], 'Ignore late page responses belonging to a previous sort/list generation.');
  await projectManager.setProject("D:\\code\\transformers");
  assert.equal(projectManager.snapshot().filteredCount, 2, "Case variants of a Windows path should filter as one project.");

  const cloudEnvironments = Array.from({ length: 3 }, (_, index) => ({ ...makeRecord("cloud", index), projectLabel: "cloud-environment-" + index }));
  const sourceAwareProjectManager = new SessionManager(fakeData(pathVariants, cloudEnvironments), () => cli, () => {}, "D:\\code\\transformers");
  await sourceAwareProjectManager.initialize();
  assert.equal(sourceAwareProjectManager.snapshot().filteredCount, 2, "The selected project should filter the combined source view.");
  await sourceAwareProjectManager.setSource("cloud");
  assert.equal(sourceAwareProjectManager.snapshot().filteredCount, cloudEnvironments.length, "Cloud-only view should ignore the saved local project filter.");
  assert.equal(sourceAwareProjectManager.snapshot().projectFilter, "D:\\code\\transformers", "Switching to cloud should preserve the project selection for later local views.");
  await sourceAwareProjectManager.setProject("cloud-environment-0");
  assert.equal(sourceAwareProjectManager.snapshot().filteredCount, cloudEnvironments.length, "Project changes should not restrict a cloud-only view.");
  await sourceAwareProjectManager.setSource("local");
  assert.equal(sourceAwareProjectManager.snapshot().filteredCount, 2, "Returning to local should restore the saved project filter.");

  const cloudRecordsAfterStartup = [];
  const cloudRefreshManager = new SessionManager(fakeData([makeRecord("local", 87)], cloudRecordsAfterStartup), () => cli, () => {});
  await cloudRefreshManager.initialize();
  assert.equal(cloudRefreshManager.snapshot().totalLoaded, 1);
  cloudRecordsAfterStartup.push(makeRecord("cloud", 88));
  await cloudRefreshManager.setSource("cloud");
  assert.equal(cloudRefreshManager.snapshot().filteredCount, 1, "Selecting Cloud should reload its first page and show tasks created after startup.");
  assert.equal(cloudRefreshManager.snapshot().totalLoaded, 1, "Cloud-only loaded counts should exclude local records.");
  assert.ok(Number.isFinite(cloudRefreshManager.snapshot().listRefreshedAt), "Reloading Cloud on source selection should update the list refresh time.");

  const detailRecord = makeRecord("local", 77);
  const detailData = fakeData([detailRecord], []);
  detailData.getThreadDetails = async () => ({
    preview: "Question preview",
    turns: [
      {
        startedAt: 1_700_000_000_000,
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Find the quota reset time" }, { type: "image", data: "private-image-data" }] },
          { type: "reasoning", text: "private reasoning" },
          { type: "agentMessage", phase: "analysis", text: "private assistant analysis" },
          { type: "commandExecution", command: "private command" },
          { type: "agentMessage", phase: "final_answer", text: "The reset time is shown in account usage." },
          { type: "agentMessage", phase: "commentary", text: "I am checking the account usage page." }
        ]
      },
      {
        startedAt: "2026-09-28T10:00:00Z",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Can I search these questions?" }] },
          { type: "agentMessage", text: "Yes, the question list is searchable." }
        ]
      }
    ]
  });
  const detailManager = new SessionManager(detailData, () => cli, () => {});
  await detailManager.initialize();
  const visibleRecord = detailManager.snapshot().records[0];
  const questionList = await detailManager.listQuestions(visibleRecord);
  assert.deepEqual(questionList, [
    { index: 0, text: "Find the quota reset time\n（图片）", startedAt: 1_700_000_000_000 },
    { index: 1, text: "Can I search these questions?", startedAt: "2026-09-28T10:00:00Z" }
  ], "The per-session question list should contain every user message and exclude assistant, reasoning, and tool content.");
  assert.doesNotMatch(JSON.stringify(questionList), /private-image-data|private reasoning|private assistant analysis|private command/);
  const detailPayload = await detailManager.openDetails(visibleRecord);
  assert.deepEqual(detailPayload.detail.turns, [
    {
      startedAt: 1_700_000_000_000,
      messages: [
        { role: "user", text: "Find the quota reset time\n（图片）" },
        { role: "assistant", text: "The reset time is shown in account usage." },
        { role: "assistant", text: "I am checking the account usage page." }
      ]
    },
    {
      startedAt: "2026-09-28T10:00:00Z",
      messages: [
        { role: "user", text: "Can I search these questions?" },
        { role: "assistant", text: "Yes, the question list is searchable." }
      ]
    }
  ], "Local details should retain ordered user questions and assistant replies while excluding tool and reasoning items.");
  assert.doesNotMatch(JSON.stringify(detailPayload), /private-image-data|private reasoning|private assistant analysis|private command/);
  assert.equal(detailPayload.detail.preview, "Question preview");
  process.stdout.write("Session pagination and independent-source fallback passed.\n");
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
