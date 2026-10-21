const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const extensionRoot = path.join(os.homedir(), ".vscode", "extensions");
let chatGptExtensionPath = process.env.SPONGE_SMOKE_CHATGPT_EXTENSION_PATH;
if (!chatGptExtensionPath) {
  try {
    chatGptExtensionPath = fs.readdirSync(extensionRoot)
      .filter(name => name.startsWith("openai.chatgpt-"))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
    if (chatGptExtensionPath) chatGptExtensionPath = path.join(extensionRoot, chatGptExtensionPath);
  } catch {}
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: { getConfiguration: () => ({ get: () => "" }) },
      extensions: { getExtension: id => id === "openai.chatgpt" && chatGptExtensionPath ? { extensionPath: chatGptExtensionPath } : undefined }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { resolveCliTarget, runCli } = require("../dist/cli.js");
const { AppServerSession } = require("../dist/appServer.js");
const { CodexDataService } = require("../dist/dataService.js");
const { SessionManager } = require("../dist/sessionManager.js");
const { buildQuotaStatusBarContent } = require("../dist/quotaStatusBar.js");
const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

function hashFile(file) {
  if (!fs.existsSync(file)) return undefined;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  const resolved = resolveCliTarget();
  assert.ok(resolved, "No Codex CLI found in the ChatGPT extension or PATH; configure it before this smoke test.");
  const target = resolved.path;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sponge-cli-shim-"));
  const shim = path.join(directory, "codex.cmd");
  const workspaceLog = path.join(process.cwd(), "error.log");
  const originalLogHash = hashFile(workspaceLog);
  let server;
  let service;

  try {
    fs.writeFileSync(shim, '@echo off\r\n"' + target + '" %*\r\n', "ascii");
    const version = await runCli(shim, ["--version"], 15_000);
    assert.match(version.stdout.trim(), /^codex-cli/i, "The Windows command shim did not return a Codex CLI version.");

    server = new AppServerSession(shim);
    const metadata = await server.connect();
    assert.ok(metadata.platformFamily, "The command shim did not initialize Codex App Server.");
    const local = await server.request("thread/list", {
      limit: 10,
      sortKey: "created_at",
      sortDirection: "desc",
      sourceKinds,
      archived: false
    });
    assert.ok(Array.isArray(local.data), "App Server thread/list did not return a data array.");
    const hasUnicodeTitle = typeof local.data[0]?.name === "string" && /[^\x00-\x7F]/.test(local.data[0].name);
    server.stop();
    server = undefined;

    service = new CodexDataService(() => ({ path: shim, source: "configured" }));
    const detailManager = new SessionManager(service, () => ({ path: shim, source: "configured", hostEnvironment: "Windows" }), () => {});
    let transcriptTurnCount = 0;
    let transcriptQuestionCount = 0;
    for (const thread of local.data ?? []) {
      if (typeof thread.id !== "string") continue;
      const record = { key: `local:${thread.id}`, source: "local", id: thread.id, title: "Smoke test", projectLabel: "local", raw: {} };
      const questions = await detailManager.listQuestions(record);
      assert.ok(Array.isArray(questions), "thread/read did not return a question list for the session picker.");
      const payload = await detailManager.openDetails(record);
      assert.ok(Array.isArray(payload.detail.turns), "thread/read did not return turns for the local conversation preview.");
      transcriptTurnCount = payload.detail.turns.length;
      transcriptQuestionCount = questions.length;
      assert.ok(payload.detail.turns.flatMap(turn => turn.messages).every(message => (message.role === "user" || message.role === "assistant") && typeof message.text === "string"), "Transcript normalization included a non-conversation item.");
      if (transcriptQuestionCount) break;
    }
    const cloud = await service.getCloudPage();
    assert.ok(Array.isArray(cloud.records), "The Codex Cloud CLI page was not parsed.");
    const usage = await service.getUsage();
    assert.ok(["available", "unavailable", "error"].includes(usage.quotaStatus), "The App Server quota status was not normalized.");
    assert.ok(usage.availableResetCount === undefined || (Number.isInteger(usage.availableResetCount) && usage.availableResetCount >= 0), "The reset-credit count was not normalized as a non-negative integer.");
    assert.ok(usage.resetCredits === undefined || Array.isArray(usage.resetCredits), "Per-credit reset expiry data was not normalized as a list.");
    assert.ok((usage.resetCredits ?? []).every(credit => credit.expiresAt === undefined || Number.isFinite(credit.expiresAt)), "A reset-credit expiry was not normalized as a timestamp.");
    const quotaStatus = buildQuotaStatusBarContent(usage);
    if (usage.quotaStatus === "available") {
      assert.match(quotaStatus.text, /5小时/);
      assert.match(quotaStatus.text, /周/);
      assert.match(quotaStatus.title, /5小时/);
      assert.match(quotaStatus.title, /周/);
    }

    assert.equal(hashFile(workspaceLog), originalLogHash, "Cloud CLI output changed the workspace error.log.");
    process.stdout.write(JSON.stringify({
      versionRead: true,
      defaultSource: resolved.source,
      appServerInitialized: true,
      localListReturned: local.data.length,
      transcriptTurnCount,
      transcriptQuestionCount,
      nonAsciiTitleReturned: hasUnicodeTitle,
      cloudPageReturned: true,
      cloudTaskCount: cloud.records.length,
      quotaStatus: usage.quotaStatus,
      quotaWindowCount: usage.buckets.length,
      availableResetCount: usage.availableResetCount,
      availableResetCreditDetails: usage.resetCredits?.length,
      resetCreditExpiryCount: usage.resetCredits?.filter(credit => Number.isFinite(credit.expiresAt)).length,
      quotaIndicatorText: quotaStatus.text,
      managerTitle: quotaStatus.title,
      workspaceLogUnchanged: true
    }) + "\n");
  } finally {
    server?.stop();
    service?.dispose();
    try { fs.unlinkSync(shim); } catch {}
    try { fs.rmdirSync(directory); } catch {}
  }
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
