const assert = require("node:assert/strict");
const { buildQuotaStatusBarContent } = require("../dist/quotaStatusBar.js");
const { formatManagerViewTitle } = require("../dist/quotaStatusBar.js");
const { codexIdeThreadUri } = require("../dist/links.js");

const unavailable = buildQuotaStatusBarContent();
assert.match(unavailable.text, /Codex 用量/);
assert.doesNotMatch(unavailable.text, /0%/);
assert.equal(unavailable.title, "Codex 对话管理器 · 配额读取中");

const usage = {
  accountStatus: "available",
  quotaStatus: "available",
  buckets: [{
    key: "codex",
    label: "Codex",
    primary: { usedPercent: 18.4, windowDurationMins: 300, resetsAt: 1_800_000_000_000 },
    secondary: { usedPercent: 62.2, windowDurationMins: 10_080, resetsAt: 1_800_000_000_000 }
  }],
  tokenStatus: "unavailable"
};
const content = buildQuotaStatusBarContent(usage, 1_800_000_000_000);
const refreshDate = new Date(1_800_000_000_000);
const refreshTime = `${refreshDate.getMonth() + 1}/${refreshDate.getDate()} ${refreshDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
assert.equal(formatManagerViewTitle(content.title, 1_800_000_000_000), `${content.title} · 列表刷新 ${refreshTime}`);
assert.equal(formatManagerViewTitle(content.title), `${content.title} · 列表刷新 --`);
assert.equal(content.text, "$(pulse) 5小时剩余 82% · 周剩余 38%");
assert.match(content.title, /^Codex 对话管理器 · 5小时剩余 82%（重置 \d+\/\d+ \d{2}:\d{2}） · 周剩余 38%（重置 \d+\/\d+ \d{2}:\d{2}）$/);
assert.match(content.tooltip, /5 小时/);
assert.match(content.tooltip, /7 天/);
assert.match(content.tooltip, /剩余 82%/);
assert.match(content.tooltip, /剩余 38%/);
assert.match(content.tooltip, /上次更新/);

const noPercentage = buildQuotaStatusBarContent({ ...usage, buckets: [{ key: "codex", label: "Codex" }] });
assert.equal(noPercentage.text, "$(dash) Codex 5小时剩余 -- · 周剩余 --");
assert.equal(noPercentage.title, "Codex 对话管理器 · 5小时剩余 --（重置 --） · 周剩余 --（重置 --）");
assert.doesNotMatch(noPercentage.text, /0%/);

const primaryOnly = buildQuotaStatusBarContent({ ...usage, buckets: [{
  key: "codex",
  label: "Codex",
  primary: { usedPercent: 18, windowDurationMins: 300 }
}] });
assert.equal(primaryOnly.text, "$(pulse) 5小时剩余 82% · 周剩余 --");
assert.match(primaryOnly.title, /周剩余 --（重置 --）/);

const error = buildQuotaStatusBarContent({ ...usage, quotaStatus: "error", quotaMessage: "未登录" });
assert.match(error.text, /配额错误/);
assert.match(error.title, /配额错误/);
assert.match(error.tooltip, /未登录/);

const threadId = "019f8104-194c-74f1-8c4c-9cefe5bfc4d0";
assert.equal(codexIdeThreadUri("openai.chatgpt", threadId), `vscode://openai.chatgpt/local/${threadId}`);
assert.throws(() => codexIdeThreadUri("openai.chatgpt", "thread/with space"), /格式不受/);
assert.throws(() => codexIdeThreadUri("openai.chatgpt", " "), /thread ID/);

const packageJson = require("../package.json");
const refreshCommand = packageJson.contributes.commands.find(item => item.command === "sponge.sessions.refresh");
assert.equal(refreshCommand.icon, "$(refresh)");
const titleMenuCommands = packageJson.contributes.menus["view/title"].map(item => item.command);
assert.deepEqual(titleMenuCommands, ["sponge.sessions.refresh"]);
assert.equal(packageJson.contributes.menus["view/title"][0].group, "navigation@1");
assert.equal(packageJson.contributes.configurationDefaults, undefined);
for (const command of ["sponge.codex.detectCli", "sponge.codex.configureCliPath", "sponge.codex.verifyCli", "sponge.codex.clearCliPath"]) {
  assert.ok(packageJson.contributes.commands.some(item => item.command === command), `${command} should remain available in the CLI/environment tab and Command Palette.`);
}

process.stdout.write("Quota status-bar formatting and Codex IDE thread links passed.\n");
