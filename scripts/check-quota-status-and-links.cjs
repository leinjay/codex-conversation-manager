const assert = require("node:assert/strict");
const { buildQuotaStatusBarContent } = require("../dist/quotaStatusBar.js");
const { formatManagerViewTitle } = require("../dist/quotaStatusBar.js");
const { codexIdeThreadUri } = require("../dist/links.js");

const unavailable = buildQuotaStatusBarContent();
assert.match(unavailable.text, /Codex 用量/);
assert.doesNotMatch(unavailable.text, /0%/);
assert.equal(unavailable.title, "Codex 对话管理器 · 账户 读取中 · 配额读取中");

const usage = {
  accountStatus: "available",
  email: "first@example.com",
  quotaStatus: "available",
  buckets: [{
    key: "codex",
    label: "Codex",
    primary: { usedPercent: 18.4, windowDurationMins: 300, resetsAt: 1_800_000_000_000 },
    secondary: { usedPercent: 62.2, windowDurationMins: 10_080, resetsAt: 1_800_000_000_000 }
  }],
  tokenStatus: "unavailable"
};
const content = buildQuotaStatusBarContent(usage, 1_800_000_000_000, 1_800_000_000_000);
const refreshDate = new Date(1_800_000_000_000);
const refreshTime = `${String(refreshDate.getHours()).padStart(2, "0")}:${String(refreshDate.getMinutes()).padStart(2, "0")}`;
assert.equal(formatManagerViewTitle(content.title, 1_800_000_000_000), `${content.title} · [${refreshTime}]`);
assert.equal(formatManagerViewTitle(content.title), `${content.title} · [--:--]`);
for (const invalid of [NaN, Infinity, 9e15]) {
  assert.equal(formatManagerViewTitle(content.title, invalid), `${content.title} · [--:--]`);
}
assert.equal(content.text, "$(pulse) 5小时剩余 82% · 周剩余 38%");
assert.equal(content.title, `Codex 对话管理器 · first · 5h left 82%（${refreshTime}） · wk left 38%（${refreshTime}）`);
assert.doesNotMatch(content.title, /重置|列表刷新|@example/);
assert.match(content.tooltip, /5 小时/);
assert.match(content.tooltip, /7 天/);
assert.match(content.tooltip, /剩余 82%/);
assert.match(content.tooltip, /剩余 38%/);
assert.match(content.tooltip, /上次更新/);

const noPercentage = buildQuotaStatusBarContent({ ...usage, buckets: [{ key: "codex", label: "Codex" }] });
assert.equal(noPercentage.text, "$(dash) Codex 5小时剩余 -- · 周剩余 --");
assert.equal(noPercentage.title, "Codex 对话管理器 · first · 5h left --（--） · wk left --（--）");
assert.doesNotMatch(noPercentage.text, /0%/);

const primaryOnly = buildQuotaStatusBarContent({ ...usage, buckets: [{
  key: "codex",
  label: "Codex",
  primary: { usedPercent: 18, windowDurationMins: 300 }
}] });
assert.equal(primaryOnly.text, "$(pulse) 5小时剩余 82% · 周剩余 --");
assert.match(primaryOnly.title, /wk left --（--）/);

const error = buildQuotaStatusBarContent({ ...usage, quotaStatus: "error", quotaMessage: "未登录" });
assert.match(error.text, /配额错误/);
assert.match(error.title, /配额错误/);
assert.match(error.tooltip, /未登录/);
assert.match(error.title, /· first · 配额错误/, "A quota failure must not hide an available account.");
assert.match(buildQuotaStatusBarContent({ ...usage, quotaStatus: "unavailable" }).title, /· first · 配额不可用/);

for (const [accountStatus, email, expected] of [
  ["available", undefined, "服务未提供"],
  ["available", "  \t ", "服务未提供"],
  ["error", "stale@example.com", "读取失败"],
  ["unavailable", "stale@example.com", "不可用"]
]) {
  const result = buildQuotaStatusBarContent({ ...usage, accountStatus, email });
  assert.ok(result.title.includes(`账户 ${expected} · 5h left 82%`));
  assert.doesNotMatch(result.title, /stale@example\.com/, "An unavailable account must not reuse an old identifier.");
}
assert.match(buildQuotaStatusBarContent({ ...usage, email: "  current@example.com\n" }).title, /· current ·/);
assert.match(buildQuotaStatusBarContent({ ...usage, email: "kongranwei@gmail.com" }).title, /· kongranwei ·/);
assert.match(buildQuotaStatusBarContent({ ...usage, email: "local-login" }).title, /· local-login ·/);

// Day suffixes use the machine's calendar across midnight, month/year boundaries, and DST.
const originalTimezone = process.env.TZ;
const originalSystemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
try {
  process.env.TZ = "Asia/Shanghai";
  function titleAt(now, primaryReset, secondaryReset = primaryReset) {
    return buildQuotaStatusBarContent({ ...usage, buckets: [{
      ...usage.buckets[0],
      primary: { ...usage.buckets[0].primary, resetsAt: primaryReset },
      secondary: { ...usage.buckets[0].secondary, resetsAt: secondaryReset }
    }] }, undefined, new Date(now).getTime()).title;
  }
  assert.equal(titleAt("2026-12-31T23:59:00+08:00", Date.parse("2027-01-01T00:00:00+08:00"), Date.parse("2027-01-07T09:05:00+08:00")),
    "Codex 对话管理器 · first · 5h left 82%（00:00+1d） · wk left 38%（09:05+7d）");
  assert.match(titleAt("2027-01-01T00:00:00+08:00", Date.parse("2027-01-01T00:00:00+08:00")), /5h left 82%（00:00）/);
  assert.match(titleAt("2026-10-31T23:59:00+08:00", Date.parse("2026-11-01T00:01:00+08:00")), /（00:01\+1d）/);
  assert.match(titleAt("2026-10-19T00:01:00+08:00", Date.parse("2026-10-18T23:59:00+08:00")), /（23:59-1d）/);
  for (const invalid of [undefined, NaN, Infinity, 9e15]) {
    assert.match(titleAt("2026-10-19T00:00:00+08:00", invalid), /5h left 82%（--）/);
  }
  process.env.TZ = "America/New_York";
  assert.match(titleAt("2026-03-08T00:01:00-05:00", Date.parse("2026-03-09T23:59:00-04:00")), /（23:59\+1d）/);
  assert.match(titleAt("2026-11-01T00:01:00-04:00", Date.parse("2026-11-02T23:59:00-05:00")), /（23:59\+1d）/);
} finally {
  // On Windows deleting TZ alone can leave Node's native timezone at the last test value.
  process.env.TZ = originalTimezone ?? originalSystemTimezone;
  if (originalTimezone === undefined) delete process.env.TZ;
}

// Exercise the native view title while the view is collapsed, including an account change.
const Module = require("node:module");
const originalLoad = Module._load;
let ManagerWebviewProvider;
try {
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? {} : originalLoad.call(this, request, parent, isMain);
  };
  ({ ManagerWebviewProvider } = require("../dist/view.js"));
} finally {
  Module._load = originalLoad;
}
const provider = new ManagerWebviewProvider({}, () => ({}), () => {});
const collapsedView = {
  visible: false,
  webview: { cspSource: "vscode-webview:", onDidReceiveMessage() {}, postMessage: async () => true },
  onDidDispose() {},
  onDidChangeVisibility() {}
};
provider.resolveWebviewView(collapsedView);
assert.equal(collapsedView.title, `${unavailable.title} · [--:--]`);
provider.setQuotaTitle(content.title);
provider.setListRefreshedAt(1_800_000_000_000);
assert.equal(collapsedView.title, `${content.title} · [${refreshTime}]`);
const nextAccount = buildQuotaStatusBarContent({ ...usage, email: "second@example.com" });
provider.setQuotaTitle(nextAccount.title);
assert.equal(collapsedView.title, `${nextAccount.title} · [${refreshTime}]`);
assert.doesNotMatch(collapsedView.title, /· first ·/);

const threadId = "019f8104-194c-74f1-8c4c-9cefe5bfc4d0";
assert.equal(codexIdeThreadUri("openai.chatgpt", threadId), `vscode://openai.chatgpt/local/${threadId}`);
assert.throws(() => codexIdeThreadUri("openai.chatgpt", "thread/with space"), /格式不受/);
assert.throws(() => codexIdeThreadUri("openai.chatgpt", " "), /thread ID/);

const packageJson = require("../package.json");
const refreshCommand = packageJson.contributes.commands.find(item => item.command === "sponge.sessions.refresh");
assert.equal(refreshCommand.icon, "$(refresh)");
const titleMenuCommands = packageJson.contributes.menus["view/title"].map(item => item.command);
assert.deepEqual(titleMenuCommands, ["sponge.accounts.pick", "sponge.sessions.refresh"]);
assert.equal(packageJson.contributes.menus["view/title"].find(item => item.command === "sponge.sessions.refresh").group, "navigation@1");
assert.equal(packageJson.contributes.menus["view/title"].find(item => item.command === "sponge.accounts.pick").group, "navigation@0");
assert.equal(packageJson.contributes.configurationDefaults, undefined);
for (const command of ["sponge.codex.detectCli", "sponge.codex.configureCliPath", "sponge.codex.verifyCli", "sponge.codex.clearCliPath"]) {
  assert.ok(packageJson.contributes.commands.some(item => item.command === command), `${command} should remain available in the CLI/environment tab and Command Palette.`);
}

process.stdout.write("Quota status-bar formatting and Codex IDE thread links passed.\n");
