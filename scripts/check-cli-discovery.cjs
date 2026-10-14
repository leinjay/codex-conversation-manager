const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

let configuredPath = "";
let extensionPath;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: { getConfiguration: () => ({ get: () => configuredPath }) },
      extensions: { getExtension: id => id === "openai.chatgpt" && extensionPath ? { extensionPath } : undefined }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { findChatGptBundledCli, resolveCliTarget } = require("../dist/cli.js");

function writeFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "test executable");
}

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sponge-cli-discovery-"));
  const previousPath = process.env.PATH;
  try {
    extensionPath = path.join(temp, "chatgpt-extension");
    const bundledCli = path.join(extensionPath, "bin", "windows-x86_64", "codex.exe");
    const pathCli = path.join(temp, "path", "codex.exe");
    const configuredCli = path.join(temp, "configured", "codex.exe");
    writeFile(bundledCli);
    writeFile(pathCli);
    writeFile(configuredCli);
    process.env.PATH = path.dirname(pathCli);

    assert.equal(findChatGptBundledCli(), bundledCli, "The ChatGPT extension's bundled Windows CLI was not discovered.");
    assert.deepEqual(resolveCliTarget(), { path: bundledCli, source: "chatgpt" }, "The bundled ChatGPT CLI should take precedence over PATH.");

    configuredPath = configuredCli;
    assert.deepEqual(resolveCliTarget(), { path: configuredCli, source: "configured" }, "An explicit user path should take precedence over automatic discovery.");

    configuredPath = "";
    extensionPath = undefined;
    assert.deepEqual(resolveCliTarget(), { path: pathCli, source: "PATH" }, "PATH should be used when the bundled CLI is unavailable.");

    process.stdout.write(JSON.stringify({ bundledDefault: true, configuredOverride: true, pathFallback: true }) + "\n");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main();
