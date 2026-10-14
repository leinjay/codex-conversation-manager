import * as vscode from "vscode";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerSession } from "./appServer";
import { runCli, type CliTarget } from "./cli";
import type { CloudPage, LocalPage, SessionRecord, UsageBucket, UsageResetCredit, UsageSnapshot } from "./types";

const PAGE_SIZE_LOCAL = 25;
const PAGE_SIZE_CLOUD = 20;
const ALL_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"
];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countValue(value: unknown): number | undefined {
  const count = numberValue(value);
  return count !== undefined && Number.isInteger(count) && count >= 0 ? count : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeLocalThread(input: unknown): SessionRecord | undefined {
  const raw = asRecord(input);
  const id = stringValue(raw.id);
  if (!id) return undefined;
  const preview = stringValue(raw.preview);
  const name = stringValue(raw.name);
  const title = name ?? preview?.split(/\r?\n/, 1)[0]?.slice(0, 160) ?? "未命名对话";
  const cwd = stringValue(raw.cwd);
  const status = stringValue(asRecord(raw.status).type);
  const originator = stringValue(raw.originator);
  return {
    key: `local:${id}`,
    source: "local",
    id,
    title,
    preview,
    cwd,
    projectLabel: cwd ?? "未知工作目录",
    sourceLabel: originator ?? stringValue(raw.source),
    status,
    createdAt: timestamp(raw.createdAt),
    updatedAt: timestamp(raw.updatedAt),
    recencyAt: timestamp(raw.recencyAt),
    lastTurnEndedAt: timestamp(raw.lastTurnEndedAt ?? raw.lastTurnCompletedAt),
    raw
  };
}

function normalizeCloudTask(input: unknown): SessionRecord | undefined {
  const raw = asRecord(input);
  const id = stringValue(raw.id);
  if (!id) return undefined;
  const environmentId = stringValue(raw.environment_id);
  const environmentLabel = stringValue(raw.environment_label);
  const url = stringValue(raw.url);
  return {
    key: `cloud:${id}`,
    source: "cloud",
    id,
    title: stringValue(raw.title) ?? stringValue(raw.summary)?.split(/\r?\n/, 1)[0]?.slice(0, 160) ?? "未命名云端会话",
    preview: stringValue(raw.summary),
    projectLabel: environmentLabel ?? environmentId ?? "未知环境",
    status: stringValue(raw.status),
    createdAt: timestamp(raw.created_at),
    updatedAt: timestamp(raw.updated_at),
    recencyAt: timestamp(raw.recency_at),
    url,
    environmentId,
    environmentLabel,
    raw
  };
}

function optionalBucketWindow(value: unknown): UsageBucket["primary"] {
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return undefined;
  return {
    usedPercent: numberValue(raw.usedPercent),
    windowDurationMins: numberValue(raw.windowDurationMins),
    resetsAt: timestamp(raw.resetsAt)
  };
}

function normalizeResetCredits(value: unknown): UsageResetCredit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(item => {
    const credit = asRecord(item);
    if (stringValue(credit.status)?.toLowerCase() !== "available") return [];
    return [{ expiresAt: timestamp(credit.expiresAt) }];
  });
}

function authUnavailableMessage(error: Error): string | undefined {
  const message = error.message.toLowerCase();
  if (/unauthori[sz]ed|not logged|login|authentication|auth mode|requires.*auth|not supported.*auth|chatgpt auth/.test(message)) {
    return "当前 Codex CLI 登录状态或认证方式不支持此账户接口。请在 Codex CLI / ChatGPT 中登录后重试。";
  }
  return undefined;
}

export class CodexDataService {
  private appServer?: AppServerSession;
  private connecting?: Promise<Record<string, unknown>>;
  private connectingPath?: string;
  private connectedPath?: string;
  private metadata?: Record<string, unknown>;

  constructor(private cliTarget: () => CliTarget | undefined) {}

  async connect(): Promise<Record<string, unknown>> {
    const target = this.cliTarget();
    if (!target) throw new Error("未检测到 Codex CLI。请从命令面板配置 Codex CLI 路径。 ");
    if (this.appServer?.isInitialized() && this.metadata && this.connectedPath?.toLowerCase() === target.path.toLowerCase()) return this.metadata;
    if (this.connecting && this.connectingPath?.toLowerCase() === target.path.toLowerCase()) return this.connecting;
    this.appServer?.stop();
    this.appServer = undefined;
    this.metadata = undefined;
    const session = new AppServerSession(target.path);
    this.appServer = session;
    this.connectingPath = target.path;
    this.connecting = session.connect().then(metadata => {
      if (this.appServer === session) {
        this.metadata = metadata;
        this.connectedPath = target.path;
      }
      return metadata;
    }).catch(error => {
      if (this.appServer === session) this.appServer = undefined;
      throw error;
    }).finally(() => {
      if (this.connectingPath?.toLowerCase() === target.path.toLowerCase()) {
        this.connecting = undefined;
        this.connectingPath = undefined;
      }
    });
    return this.connecting;
  }

  async verify(target: CliTarget): Promise<{ version: string; metadata: Record<string, unknown> }> {
    const versionResult = await runCli(target.path, ["--version"], 15_000);
    const version = versionResult.stdout.trim().split(/\r?\n/)[0] || "版本未返回";
    const session = new AppServerSession(target.path);
    try {
      const metadata = await session.connect();
      return { version, metadata };
    } finally {
      session.stop();
    }
  }

  async getLocalPage(cursor?: string | null, sortKey: "created" | "updated" | "active" = "updated", sortDirection: "asc" | "desc" = "desc"): Promise<LocalPage> {
    const server = await this.getAppServer();
    const result = await server.request<Record<string, unknown>>("thread/list", {
      cursor: cursor ?? null,
      limit: PAGE_SIZE_LOCAL,
      sortKey: sortKey === "created" ? "created_at" : sortKey === "active" ? "recency_at" : "updated_at",
      sortDirection,
      sourceKinds: ALL_SOURCE_KINDS,
      archived: false
    });
    const data = Array.isArray(result.data) ? result.data : [];
    const records = data.map(normalizeLocalThread).filter((record): record is SessionRecord => record !== undefined);
    return { records, cursor: stringValue(result.nextCursor) ?? null };
  }

  async getCloudPage(cursor?: string | null): Promise<CloudPage> {
    const target = this.cliTarget();
    if (!target) throw new Error("未检测到 Codex CLI。请先配置 Codex CLI 路径。 ");
    const args = ["cloud", "list", "--json", "--limit", String(PAGE_SIZE_CLOUD)];
    if (cursor) args.push("--cursor", cursor);
    // Some CLI builds create an error.log in their current directory. Keep it out of the
    // workspace and remove that exact CLI-generated file after this read-only request.
    const scratch = mkdtempSync(join(tmpdir(), "sponge-codex-cloud-"));
    let result: Awaited<ReturnType<typeof runCli>>;
    try {
      result = await runCli(target.path, args, 90_000, scratch);
    } finally {
      const generatedLog = join(scratch, "error.log");
      try {
        if (existsSync(generatedLog)) unlinkSync(generatedLog);
      } catch {
        // A locked diagnostic file should not turn a successful cloud read into a failure.
      }
      try {
        rmdirSync(scratch);
      } catch {
        // Only remove the temporary directory when the CLI left no other files in it.
      }
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`Codex Cloud 返回了无法识别的 JSON。${result.stderr.trim() ? ` ${result.stderr.trim()}` : ""}`);
    }
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const records = tasks.map(normalizeCloudTask).filter((record): record is SessionRecord => record !== undefined);
    return { records, cursor: stringValue(payload.cursor) ?? null };
  }

  async getThreadDetails(threadId: string): Promise<Record<string, unknown>> {
    const server = await this.getAppServer();
    const result = await server.request<Record<string, unknown>>("thread/read", { threadId, includeTurns: true });
    return asRecord(result.thread);
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const server = await this.getAppServer();
    await server.request("thread/name/set", { threadId, name });
  }

  async deleteThread(threadId: string): Promise<void> {
    const server = await this.getAppServer();
    try {
      await server.request("thread/delete", { threadId });
    } catch (error) {
      throw new Error(formatThreadDeleteError(error, threadId));
    }
  }

  async getUsage(): Promise<UsageSnapshot> {
    let server: AppServerSession;
    try {
      server = await this.getAppServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        accountStatus: "error", accountMessage: message,
        quotaStatus: "error", quotaMessage: message, buckets: [],
        tokenStatus: "error", tokenMessage: message
      };
    }

    const [accountResult, rateResult, usageResult] = await Promise.allSettled([
      server.request<Record<string, unknown>>("account/read"),
      server.request<Record<string, unknown>>("account/rateLimits/read"),
      server.request<Record<string, unknown>>("account/usage/read")
    ]);

    let accountStatus: UsageSnapshot["accountStatus"] = "unavailable";
    let accountMessage: string | undefined = "Codex 服务未提供账户信息。";
    let email: string | undefined;
    let planType: string | undefined;
    let authType: string | undefined;
    if (accountResult.status === "fulfilled") {
      const account = asRecord(accountResult.value.account);
      authType = stringValue(account.type);
      email = stringValue(account.email);
      planType = stringValue(account.planType);
      if (Object.keys(account).length) {
        accountStatus = "available";
        accountMessage = undefined;
      } else {
        accountStatus = "unavailable";
        accountMessage = accountResult.value.requiresOpenaiAuth === true
          ? "当前 Codex CLI 尚未登录 ChatGPT 账户。"
          : "Codex 服务未提供账户信息。";
      }
    } else {
      const error = accountResult.reason instanceof Error ? accountResult.reason : new Error(String(accountResult.reason));
      accountStatus = authUnavailableMessage(error) ? "unavailable" : "error";
      accountMessage = authUnavailableMessage(error) ?? error.message;
    }

    let quotaStatus: UsageSnapshot["quotaStatus"] = "unavailable";
    let quotaMessage: string | undefined = "Codex 服务未提供配额数据。";
    let buckets: UsageBucket[] = [];
    let availableResetCount: number | undefined;
    let resetCredits: UsageResetCredit[] | undefined;
    if (rateResult.status === "fulfilled") {
      const raw = rateResult.value;
      const resetCreditData = asRecord(raw.rateLimitResetCredits);
      availableResetCount = countValue(resetCreditData.availableCount);
      resetCredits = normalizeResetCredits(resetCreditData.credits);
      const byId = asRecord(raw.rateLimitsByLimitId);
      const source = Object.keys(byId).length ? byId : raw.rateLimits ? { [stringValue(asRecord(raw.rateLimits).limitId) ?? "codex"]: raw.rateLimits } : {};
      buckets = Object.entries(source).map(([key, item]) => {
        const bucket = asRecord(item);
        return {
          key,
          label: stringValue(bucket.limitName) ?? stringValue(bucket.limitId) ?? key,
          primary: optionalBucketWindow(bucket.primary),
          secondary: optionalBucketWindow(bucket.secondary)
        };
      });
      if (buckets.length) {
        quotaStatus = "available";
        quotaMessage = undefined;
        if (!planType) planType = stringValue(asRecord(raw.rateLimits).planType);
      }
    } else {
      const error = rateResult.reason instanceof Error ? rateResult.reason : new Error(String(rateResult.reason));
      quotaStatus = authUnavailableMessage(error) ? "unavailable" : "error";
      quotaMessage = authUnavailableMessage(error) ?? error.message;
    }

    let tokenStatus: UsageSnapshot["tokenStatus"] = "unavailable";
    let tokenMessage: string | undefined = "Codex 服务未提供 token 活动统计。";
    let tokenSummary: UsageSnapshot["tokenSummary"];
    let dailyUsageBuckets: UsageSnapshot["dailyUsageBuckets"];
    if (usageResult.status === "fulfilled") {
      const summary = asRecord(usageResult.value.summary);
      tokenSummary = Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, numberValue(value)]));
      dailyUsageBuckets = Array.isArray(usageResult.value.dailyUsageBuckets)
        ? usageResult.value.dailyUsageBuckets.map(value => {
          const row = asRecord(value);
          return { startDate: stringValue(row.startDate), tokens: numberValue(row.tokens) };
        })
        : undefined;
      if (Object.keys(summary).length || dailyUsageBuckets?.length) {
        tokenStatus = "available";
        tokenMessage = undefined;
      }
    } else {
      const error = usageResult.reason instanceof Error ? usageResult.reason : new Error(String(usageResult.reason));
      tokenStatus = authUnavailableMessage(error) ? "unavailable" : "error";
      tokenMessage = authUnavailableMessage(error) ?? error.message;
    }

    return {
      accountStatus, email, planType, authType, accountMessage,
      quotaStatus, quotaMessage, buckets, availableResetCount, resetCredits,
      tokenStatus, tokenMessage, tokenSummary, dailyUsageBuckets
    };
  }

  codexHome(): string | undefined {
    const result = this.metadata ? stringValue(this.metadata.codexHome) : undefined;
    return result ?? vscode.workspace.getConfiguration("sponge").get<string>("codexHome");
  }

  dispose(): void {
    this.appServer?.stop();
    this.appServer = undefined;
    this.metadata = undefined;
    this.connectedPath = undefined;
  }

  private async getAppServer(): Promise<AppServerSession> {
    if (this.appServer?.isInitialized()) return this.appServer;
    await this.connect();
    if (!this.appServer?.isInitialized()) throw new Error("Codex App Server 未完成初始化。请重新验证 Codex CLI。 ");
    return this.appServer;
  }
}

export function shortError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatThreadDeleteError(error: unknown, threadId: string): string {
  const message = shortError(error);
  if (!/already has an active writer/i.test(message)) return message;
  return `无法删除本地 Codex 对话记录：线程 ${threadId} 仍被 Codex 客户端占用。请在正在打开此会话的 ChatGPT 桌面应用、VS Code Codex 或 Codex CLI 中结束当前任务并关闭该会话，然后刷新列表再重试。App Server 会拒绝删除仍有活动写入锁的线程，以保护会话记录。`;
}
