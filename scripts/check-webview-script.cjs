const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "view.ts"), "utf8");
const tick = String.fromCharCode(96);
const start = source.indexOf("return " + tick, source.indexOf("function getHtml"));
const end = source.indexOf(tick + ";", start + 7);
assert.ok(start >= 0 && end > start, "Could not find the webview HTML template.");

const expression = source.slice(start + "return ".length, end + 1);
const html = new Function("nonce", "cspSource", "return " + expression + ";")("smoke_nonce", "vscode-webview:");
const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "Could not find the inline webview script.");
new vm.Script(scriptMatch[1], { filename: "codex-manager-webview.js" });
assert.match(scriptMatch[1], /5小时剩余/);
assert.match(scriptMatch[1], /周剩余/);
assert.match(scriptMatch[1], /可用重置次数/);
assert.match(scriptMatch[1], /availableResetCount/);
assert.match(scriptMatch[1], /usage\.resetCredits/);
assert.match(scriptMatch[1], /过期时间按本机时区显示/);
assert.match(scriptMatch[1], /服务未提供每次重置额度的过期时间/);
assert.match(scriptMatch[1], /服务未提供/);
assert.match(scriptMatch[1], /const remainingPercent = 100 - usedPercent;/);
assert.match(html, /\.bar \{ height: 6px; background: var\(--vscode-panel-border\);/);
assert.match(html, /\.bar > span \{ display: block; height: 100%; background: var\(--vscode-charts-blue\);/);
assert.match(scriptMatch[1], /width:' \+ remainingPercent \+ '%"><\/span><\/div>/);
assert.match(html, /\.token-chart-line \{ fill: none; stroke: var\(--vscode-charts-blue\);/);
assert.match(scriptMatch[1], /id="dailyTokenChartButton"/);
assert.match(scriptMatch[1], /id="dailyTokenListButton"/);
assert.match(scriptMatch[1], /折线图日期按北京时间（Asia\/Shanghai）显示/);
assert.ok(/dailyTokenViewMode === 'chart'\s*\n\s*\? renderDailyTokenChart\(dailyTokenRows\)/.test(scriptMatch[1]), "The daily token chart should be the default view and remain switchable.");
const dateFormatterSource = scriptMatch[1].match(/    function formatBeijingDate\(value\) \{[\s\S]*?\n    \}/);
assert.ok(dateFormatterSource, "Could not find the Beijing date formatter.");
assert.match(dateFormatterSource[0], /timeZone: 'Asia\/Shanghai'/);
const formatBeijingDate = new Function(dateFormatterSource[0] + "\nreturn formatBeijingDate;")();
assert.equal(formatBeijingDate("2026-09-28T15:59:59.000Z"), "2026-09-28");
assert.equal(formatBeijingDate("2026-09-28T16:00:00.000Z"), "2026-09-29", "An instant at midnight in Beijing should use the Beijing calendar date.");
assert.equal(formatBeijingDate("2026-09-29"), "2026-09-29", "Date-only service values should retain their calendar date.");
const chartSource = scriptMatch[1].match(/    function renderDailyTokenChart\(rows\) \{[\s\S]*?\n    \}/);
assert.ok(chartSource, "Could not find the daily token chart renderer.");
const renderDailyTokenChart = new Function("escapeHtml", "formatBeijingDate", chartSource[0] + "\nreturn renderDailyTokenChart;")(
  value => String(value).replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]),
  formatBeijingDate
);
const tokenChart = renderDailyTokenChart([
  { startDate: "2026-09-03", tokens: 15 },
  { startDate: "2026-09-01", tokens: 10 },
  { startDate: "2026-09-02", tokens: 30 }
]);
assert.match(tokenChart, /<svg class="token-chart"[^>]*role="img"/);
assert.match(tokenChart, /<path class="token-chart-line" d="M[0-9.]+ [0-9.]+ L[0-9.]+ [0-9.]+ L[0-9.]+ [0-9.]+"><\/path>/);
assert.ok(tokenChart.indexOf("2026-09-01") < tokenChart.indexOf("2026-09-02"));
assert.ok(tokenChart.indexOf("2026-09-02") < tokenChart.indexOf("2026-09-03"));
assert.match(tokenChart, /30 tokens/);
const beijingTimeChart = renderDailyTokenChart([
  { startDate: "2026-09-28T16:00:00.000Z", tokens: 20 },
  { startDate: "2026-09-28T15:59:59.000Z", tokens: 10 }
]);
assert.ok(beijingTimeChart.indexOf("2026-09-28") < beijingTimeChart.indexOf("2026-09-29"), "Timestamp labels should use Beijing calendar dates.");
assert.match(beijingTimeChart, /<title>2026-09-28：10 tokens<\/title>/);
assert.match(beijingTimeChart, /<title>2026-09-29：20 tokens<\/title>/);
assert.doesNotMatch(beijingTimeChart, /2026-09-28T/);
assert.match(beijingTimeChart, /日期按北京时间显示/);
const thirtyDayRows = Array.from({ length: 31 }, (_, index) => ({
  startDate: new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10),
  tokens: index
}));
const thirtyDayChart = renderDailyTokenChart(thirtyDayRows.reverse());
assert.doesNotMatch(thirtyDayChart, /2026-09-01/);
assert.match(thirtyDayChart, /2026-09-02/);
assert.match(thirtyDayChart, /2026-10-01/);
const gapChart = renderDailyTokenChart([
  { startDate: "2026-09-01", tokens: 10 },
  { startDate: "2026-09-02" },
  { startDate: "2026-09-03", tokens: 20 }
]);
const gapPath = gapChart.match(/class="token-chart-line" d="([^"]*)"/)[1];
assert.match(gapPath, /^M[0-9.]+ [0-9.]+ M[0-9.]+ [0-9.]+$/);
assert.match(renderDailyTokenChart([{ startDate: "2026-09-01" }]), /服务未提供可绘制的每日 token 数值/);
assert.match(renderDailyTokenChart([{ startDate: "<script>alert(1)<\/script>", tokens: 1 }]), /&lt;script&gt;/);
assert.doesNotMatch(renderDailyTokenChart([{ startDate: "<script>alert(1)<\/script>", tokens: 1 }]), /<script>alert/);
const resetCreditDetailsSource = scriptMatch[1].match(/    function renderResetCreditDetails\(credits, availableCount\) \{[\s\S]*?\n    \}/);
assert.ok(resetCreditDetailsSource, "Could not find the reset-credit expiry renderer.");
const renderResetCreditDetails = new Function("escapeHtml", "formatDate", resetCreditDetailsSource[0] + "\nreturn renderResetCreditDetails;")(
  value => String(value).replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]),
  value => Number.isFinite(value) ? `expiry-${value}` : "未提供"
);
const resetCreditExpiryMarkup = renderResetCreditDetails([
  { expiresAt: 1_790_106_068_000 },
  { expiresAt: 1_793_298_000_000 },
  {}
], 3);
assert.equal((resetCreditExpiryMarkup.match(/过期时间：/g) || []).length, 3, "Every available reset credit should have its own expiry row.");
assert.match(resetCreditExpiryMarkup, /第 1 次重置/);
assert.match(resetCreditExpiryMarkup, /过期时间：expiry-1790106068000/);
assert.match(resetCreditExpiryMarkup, /过期时间：未提供/);
assert.match(renderResetCreditDetails(undefined, 2), /服务未提供每次重置额度的过期时间/);
assert.match(renderResetCreditDetails([], 0), /当前没有可用的重置次数/);
assert.match(scriptMatch[1], /Codex Cloud 当前没有返回可显示的任务/);
assert.match(scriptMatch[1], /projectSearch/);
assert.match(scriptMatch[1], /projectSearch\.disabled = cloudOnly/);
assert.match(html, /id="projectFilterHint"/);
assert.match(html, /云端来源不应用项目 \/ 环境筛选/);
assert.match(scriptMatch[1], /toLocaleLowerCase\(\)\.includes\(query\)/);
assert.match(html, /role="combobox"/);
assert.match(html, /role="listbox"/);
assert.match(scriptMatch[1], /updateProjectOptions\(true\)/);
assert.match(scriptMatch[1], /我问过的问题/);
assert.match(scriptMatch[1], /selectQuestion/);
assert.match(scriptMatch[1], /send\('loadQuestions', \{ key \}\)/);
assert.match(scriptMatch[1], /使用打开按钮打开整条会话/);
assert.doesNotMatch(scriptMatch[1], /focusQuestion|jumpToQuestion|定位所选问题/);
assert.match(scriptMatch[1], /更早 10 轮/);
assert.match(scriptMatch[1], /更新 10 轮/);
const excerptSource = scriptMatch[1].match(/    function questionExcerpt\(text, query\) \{[\s\S]*?\n    \}/);
assert.ok(excerptSource, "Could not find the question excerpt formatter.");
const questionExcerpt = new Function(excerptSource[0] + "\nreturn questionExcerpt;")();
assert.equal(questionExcerpt("alpha beta gamma", "beta"), "alpha beta gamma");
assert.match(questionExcerpt("start " + "x".repeat(100) + " TARGET " + "y".repeat(100), "target"), /TARGET/);
const highlightSource = scriptMatch[1].match(/    function highlightMatches\(text, query\) \{[\s\S]*?\n    \}/);
assert.ok(highlightSource, "Could not find the question search highlighter.");
const highlightMatches = new Function("escapeHtml", highlightSource[0] + "\nreturn highlightMatches;")(
  value => String(value).replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character])
);
assert.equal(highlightMatches("Find <needle> safely", "needle"), "Find &lt;<mark>needle</mark>&gt; safely");
const renderQuestionPickerSource = scriptMatch[1].match(/    function renderQuestionPicker\(key\) \{[\s\S]*?\n    \}/);
assert.ok(renderQuestionPickerSource, "Could not find the searchable per-session question dropdown renderer.");
const questionInput = { value: "quota", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
const questionList = { innerHTML: "", hidden: true };
const questionHint = { textContent: "" };
const questionRoot = {
  dataset: { key: "local:one" },
  querySelector(selector) {
    return selector === ".question-search-input" ? questionInput : selector === ".question-options" ? questionList : questionHint;
  }
};
const questionState = {
  status: "loaded",
  questions: [
    { index: 0, text: "Show conversation history" },
    { index: 1, text: "Search my weekly quota reset" },
    { index: 2, text: "Unrelated question" }
  ],
  query: "quota",
  selectedIndex: 1,
  open: true
};
const questionStates = new Map([["local:one", questionState]]);
const questionDocument = { activeElement: null, querySelectorAll: () => [questionRoot] };
const renderQuestionPicker = new Function("document", "questionStates", "questionStateFor", "questionExcerpt", "formatDate", "escapeHtml", "highlightMatches", renderQuestionPickerSource[0] + "\nreturn renderQuestionPicker;")(
  questionDocument,
  questionStates,
  key => questionStates.get(key),
  questionExcerpt,
  () => "2026-09-28",
  value => String(value).replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]),
  highlightMatches
);
renderQuestionPicker("local:one");
assert.equal(questionList.hidden, false);
assert.equal(questionInput.attributes["aria-expanded"], "true");
assert.match(questionList.innerHTML, /weekly <mark>quota<\/mark> reset/);
assert.doesNotMatch(questionList.innerHTML, /Unrelated question/);
assert.match(questionList.innerHTML, /aria-selected="true"/);
assert.match(questionHint.textContent, /已选问题 2/);
questionState.query = "";
renderQuestionPicker("local:one");
assert.match(questionList.innerHTML, /Show conversation history/);
assert.match(questionList.innerHTML, /Unrelated question/);
const projectOptionsSource = scriptMatch[1].match(/    function updateProjectOptions\(open = projectOptionsOpen\) \{[\s\S]*?\n    \}/);
assert.ok(projectOptionsSource, "Could not find the project search dropdown renderer.");
const projectSearch = { value: "TRANS", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
const projectOptions = { innerHTML: "", hidden: true };
const projectElements = { "#projectSearch": projectSearch, "#projectOptions": projectOptions };
const updateProjectOptions = new Function("$", "escapeHtml", "snapshot", "projectOptionsOpen", projectOptionsSource[0] + "\nreturn updateProjectOptions;")(
  selector => projectElements[selector],
  value => String(value).replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]),
  { projectFilter: "D:\\code\\other", projects: ["D:\\code\\transformers", "D:\\code\\other"] },
  false
);
updateProjectOptions(true);
assert.equal(projectOptions.hidden, false, "Typing should open the project results list.");
assert.equal(projectSearch.attributes["aria-expanded"], "true");
assert.ok(projectOptions.innerHTML.includes("D:\\code\\transformers"));
assert.ok(!projectOptions.innerHTML.includes("D:\\code\\other"));
projectSearch.disabled = true;
updateProjectOptions(true);
assert.equal(projectOptions.hidden, true, "The project dropdown should stay closed when its control is disabled for cloud-only results.");
assert.equal(projectOptions.innerHTML, "", "Disabled project choices should not remain visible.");
assert.equal(projectSearch.attributes["aria-expanded"], "false");
const countdownSource = scriptMatch[1].match(/    const resetCountdown = \(value\) => \{[\s\S]*?\n    \};/);
assert.ok(countdownSource, "Could not find the reset countdown formatter.");
const resetCountdown = new Function(countdownSource[0] + "\nreturn resetCountdown;")();
assert.equal(resetCountdown(undefined), "服务未提供");
assert.equal(resetCountdown(Date.now() + 30_000), "约 1 分钟");
assert.equal(resetCountdown(Date.now() + 90 * 60_000), "约 1 小时 30 分钟");
assert.equal(resetCountdown(Date.now() + 36 * 60 * 60_000), "约 1 天 12 小时");
assert.equal(resetCountdown(Date.now() - 1), "已到重置时间，等待刷新用量");
process.stdout.write("Webview JavaScript syntax passed.\n");
