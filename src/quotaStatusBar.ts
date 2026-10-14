import type { UsageBucket, UsageSnapshot } from "./types";

export interface QuotaStatusBarContent {
  text: string;
  tooltip: string;
  title: string;
}

export function formatManagerViewTitle(quotaTitle: string, listRefreshedAt?: number): string {
  let time = "--";
  if (typeof listRefreshedAt === "number" && Number.isFinite(listRefreshedAt)) {
    const date = new Date(listRefreshedAt);
    const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    time = `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
  }
  return `${quotaTitle} · 列表刷新 ${time}`;
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

function resetTime(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const date = new Date(value);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hour}:${minute}`;
}

export function buildQuotaStatusBarContent(usage?: UsageSnapshot, refreshedAt?: number): QuotaStatusBarContent {
  if (!usage) {
    return {
      text: "$(sync~spin) Codex 用量",
      tooltip: "正在读取 Codex 配额。点击查看账户用量。",
      title: "Codex 对话管理器 · 配额读取中"
    };
  }
  if (usage.quotaStatus !== "available") {
    const isError = usage.quotaStatus === "error";
    const label = isError ? "$(warning) Codex 配额错误" : "$(dash) Codex 配额不可用";
    return {
      text: label,
      tooltip: `${usage.quotaMessage || "服务未提供配额数据。"}\n点击查看账户用量。`,
      title: `Codex 对话管理器 · ${isError ? "配额错误" : "配额不可用"}`
    };
  }

  const windows = quotaWindows(usage.buckets);
  if (!windows.length) {
    return {
      text: "$(dash) Codex 5小时剩余 -- · 周剩余 --",
      tooltip: "Codex 服务未提供可计算剩余比例的窗口数据；不会将缺失数据显示为 0%。\n点击查看账户用量。",
      title: "Codex 对话管理器 · 5小时剩余 --（重置 --） · 周剩余 --（重置 --）"
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
  const title = `Codex 对话管理器 · 5小时剩余 ${remainingFor("primary")}（重置 ${resetTime(windowFor("primary")?.resetsAt)}） · 周剩余 ${remainingFor("secondary")}（重置 ${resetTime(windowFor("secondary")?.resetsAt)}）`;
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
