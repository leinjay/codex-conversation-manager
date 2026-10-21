const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: { getConfiguration: () => ({ get: () => "" }) },
      extensions: { getExtension: () => undefined }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { AppServerSession } = require("../dist/appServer.js");
const { CodexDataService } = require("../dist/dataService.js");
Module._load = originalLoad;

let rateLimitResetCredits = {
  availableCount: 3,
  credits: [
    { id: "ignored-id", status: "available", expiresAt: 1_790_106_068 },
    { status: "AVAILABLE", expiresAt: "2026-10-15T00:00:00.000Z" },
    { status: "used", expiresAt: 1_800_000_000 },
    { status: "available", expiresAt: "invalid" }
  ]
};

AppServerSession.prototype.connect = async function () {
  this.mockInitialized = true;
  return { platformFamily: "windows" };
};
AppServerSession.prototype.isInitialized = function () {
  return this.mockInitialized === true;
};
AppServerSession.prototype.request = async function (method) {
  if (method === "account/read") return { account: { type: "chatgpt", planType: "plus" } };
  if (method === "account/rateLimits/read") {
    return {
      rateLimitResetCredits,
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_790_107_000 }
        }
      }
    };
  }
  if (method === "account/usage/read") return { summary: {} };
  throw new Error(`Unexpected App Server request: ${method}`);
};

async function main() {
  const service = new CodexDataService(() => ({ path: "codex", source: "configured" }));
  try {
    const usage = await service.getUsage();
    assert.equal(usage.availableResetCount, 3);
    assert.deepEqual(usage.resetCredits, [
      { expiresAt: 1_790_106_068_000 },
      { expiresAt: Date.parse("2026-10-15T00:00:00.000Z") },
      { expiresAt: undefined }
    ], "Only available credits should be exposed, and each expiry should normalize to milliseconds.");

    rateLimitResetCredits = { availableCount: 3 };
    const missingDetails = await service.getUsage();
    assert.equal(missingDetails.availableResetCount, 3);
    assert.equal(missingDetails.resetCredits, undefined, "Missing per-credit details must remain unavailable rather than inferred.");
  } finally {
    service.dispose();
  }
  process.stdout.write("Reset-credit expiry normalization passed.\n");
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
