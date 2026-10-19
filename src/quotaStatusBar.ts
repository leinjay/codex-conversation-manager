import type { UsageBucket, UsageSnapshot } from "./types";

export interface QuotaStatusBarContent {
  text: string;
  tooltip: string;
  title: string;
}

export function formatManagerViewTitle(quotaTitle: string, listRefreshedAt?: number): string {
  const date = validDate(listRefreshedAt);
  return `${quotaTitle} · [${date ? clockTime(date) : "--:--"}]`;
}

function validDate(value?: number): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface QuotaWindow {
  label: string;
  kind: "primary" | "secondary";
  remainingPercent: number;
  resetsAt?: number;
}

function quotaWindows(buckets: UsageBucket[]): QuotaWindow[] {
  const result: QuotaWindow[] = [];
  for (const bucket of buckets) {
    for (const [kind, key, window] of [["primary", "主要窗口", bucket.primary], ["secondary", "次要窗口", bucket.secondary]] as const) {
      if (typeof window?.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
      const duration = window.windowDurationMins;
      const durationLabel = typeof duration === "number" && Number.isFinite(duration)
        ? duration >= 1440 && duration % 1440 === 0
          ? `${duration / 1440} 天`
          : duration >= 60 && duration % 60 === 0
            ? `${duration / 60} 小时`
            : `${duration} 分钟`
        : key;
      result.push({
        label: `${bucket.label} · ${durationLabel}`,
        kind,
        remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent))),
        resetsAt: window.resetsAt
      });
    }
  }
  return result;
}

function resetTime(value: number | undefined, now: number): string {
  const date = validDate(value);
  const today = validDate(now);
  if (!date || !today) return "--";
  // Compare local calendar dates, not elapsed hours: a DST day can have 23 or 25 hours.
  const calendarDay = (day: Date): number => Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  const days = Math.round((calendarDay(date) - calendarDay(today)) / 86_400_000);
  const suffix = days === 0 ? "" : `${days > 0 ? "+" : ""}${days}d`;
  return `${clockTime(date)}${suffix}`;
}

export function formatAccountQuota(buckets: UsageBucket[], now = Date.now()): string {
  const windows = quotaWindows(buckets);
  const summary = (kind: QuotaWindow["kind"], label: string): string => {
    const window = windows.filter(item => item.kind === kind)
      .sort((left, right) => left.remainingPercent - right.remainingPercent)[0];
    return `${label} ${window ? `${window.remainingPercent}%` : "--"} (${resetTime(window?.resetsAt, now)})`;
  };
  return `${summary("primary", "5h Left")} · ${summary("secondary", "Wk Left")}`;
}

function managerAccountTitle(usage?: UsageSnapshot): string {
  let account = "读取中";
  if (usage) {
    account = usage.accountStatus === "available"
      ? usage.email?.replace(/\s+/g, " ").trim() || "服务未提供"
      : usage.accountStatus === "error" ? "读取失败" : "不可用";
  }
  if (usage?.accountStatus === "available" && usage.email?.trim()) {
    const separator = account.lastIndexOf("@");
    return `Codex 对话管理器 · ${separator > 0 ? account.slice(0, separator) : account}`;
  }
  return `Codex 对话管理器 · 账户 ${account}`;
}

export function buildQuotaStatusBarContent(usage?: UsageSnapshot, refreshedAt?: number, now = Date.now()): QuotaStatusBarContent {
  const titlePrefix = managerAccountTitle(usage);
  if (!usage) {
    return {
      text: "$(sync~spin) Codex 用量",
      tooltip: "正在读取 Codex 配额。点击查看账户用量。",
      title: `${titlePrefix} · 配额读取中`
    };
  }
  if (usage.quotaStatus !== "available") {
    const isError = usage.quotaStatus === "error";
    const label = isError ? "$(warning) Codex 配额错误" : "$(dash) Codex 配额不可用";
    return {
      text: label,
      tooltip: `${usage.quotaMessage || "服务未提供配额数据。"}\n点击查看账户用量。`,
      title: `${titlePrefix} · ${isError ? "配额错误" : "配额不可用"}`
    };
  }

  const windows = quotaWindows(usage.buckets);
  if (!windows.length) {
    return {
      text: "$(dash) Codex 5小时剩余 -- · 周剩余 --",
      tooltip: "Codex 服务未提供可计算剩余比例的窗口数据；不会将缺失数据显示为 0%。\n点击查看账户用量。",
      title: `${titlePrefix} · 5h left --（--） · wk left --（--）`
    };
  }

  const remainingFor = (kind: QuotaWindow["kind"]): string => {
    const values = windows.filter(window => window.kind === kind).map(window => window.remainingPercent);
    return values.length ? `${Math.min(...values)}%` : "--";
  };
  const windowFor = (kind: QuotaWindow["kind"]): QuotaWindow | undefined => windows
    .filter(window => window.kind === kind)
    .sort((left, right) => left.remainingPercent - right.remainingPercent)[0];
  const windowSummary = `5小时剩余 ${remainingFor("primary")} · 周剩余 ${remainingFor("secondary")}`;
  const title = `${titlePrefix} · 5h left ${remainingFor("primary")}（${resetTime(windowFor("primary")?.resetsAt, now)}） · wk left ${remainingFor("secondary")}（${resetTime(windowFor("secondary")?.resetsAt, now)}）`;
  const tooltip = [
    "Codex 配额剩余比例（状态栏与管理器标题显示五小时和周窗口；以下列出全部配额窗口）",
    ...windows.map(window => `${window.label}：剩余 ${window.remainingPercent}%${window.resetsAt ? ` · 重置 ${new Date(window.resetsAt).toLocaleString()}` : ""}`),
    ...(refreshedAt ? [`上次更新：${new Date(refreshedAt).toLocaleTimeString()}`] : []),
    "点击打开账户用量详情。"
  ].join("\n");
  return {
    text: `$(pulse) ${windowSummary}`,
    tooltip,
    title
  };
}
