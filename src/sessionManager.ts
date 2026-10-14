import type { CliStatus, ManagerSnapshot, SessionRecord, SessionSource, SourceErrors, UsageSnapshot } from "./types";
import { CodexDataService, shortError } from "./dataService";

const PAGE_SIZE = 20;
const MAX_SCAN_PAGES_PER_ACTION = 15;

type SourceFilter = ManagerSnapshot["sourceFilter"];
type SortKey = ManagerSnapshot["sortKey"];
type Direction = ManagerSnapshot["sortDirection"];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const raw = asRecord(value);
  if (typeof raw.text === "string") return raw.text;
  const type = typeof raw.type === "string" ? raw.type.toLocaleLowerCase("en-US") : "";
  if (/image|picture|photo/.test(type)) return "（图片）";
  if (/audio|speech|sound/.test(type)) return "（音频）";
  if (/file|attachment/.test(type)) return "（附件）";
  return raw.content === undefined ? "" : contentText(raw.content);
}

function transcriptTimestamp(value: unknown): number | string | undefined {
  return typeof value === "number" && Number.isFinite(value) || typeof value === "string" ? value : undefined;
}

function normalizedWindowsPath(value: string): string | undefined {
  const normalized = value.replace(/\//g, "\\");
  return /^[a-z]:\\/i.test(normalized) || normalized.startsWith("\\\\") ? normalized : undefined;
}

function projectIdentity(value: string): string {
  const windowsPath = normalizedWindowsPath(value);
  return windowsPath ? `windows:${windowsPath.toLocaleLowerCase("en-US")}` : `label:${value}`;
}

function displayProjectLabel(value: string): string {
  const windowsPath = normalizedWindowsPath(value);
  if (!windowsPath) return value;
  return /^[a-z]:\\/i.test(windowsPath)
    ? windowsPath[0].toUpperCase() + windowsPath.slice(1)
    : windowsPath;
}

function uniqueProjectLabels(records: SessionRecord[]): string[] {
  const labels = new Map<string, string>();
  for (const record of records) {
    const identity = projectIdentity(record.projectLabel);
    const candidate = displayProjectLabel(record.projectLabel);
    const existing = labels.get(identity);
    if (existing === undefined || candidate < existing) labels.set(identity, candidate);
  }
  return [...labels.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export class SessionManager {
  private localRecords: SessionRecord[] = [];
  private cloudRecords: SessionRecord[] = [];
  private localCursor?: string | null;
  private cloudCursor?: string | null;
  private localLoaded = false;
  private cloudLoaded = false;
  private localHasMore = true;
  private cloudHasMore = true;
  private sourceFilter: SourceFilter = "all";
  private projectFilter = "";
  private search = "";
  private sortKey: SortKey = "updated";
  private sortDirection: Direction = "desc";
  private pageIndex = 0;
  private loading = false;
  private usage?: UsageSnapshot;
  private readonly errors: SourceErrors = {};
  private message?: string;
  private scanLimitHit = false;
  private listRefreshedAt?: number;
  private listRefreshPromise?: Promise<void>;

  constructor(
    private readonly data: CodexDataService,
    private readonly getCliStatus: () => CliStatus,
    private readonly onChange: (snapshot: ManagerSnapshot) => void,
    private readonly preferredProject?: string
  ) {}

  snapshot(): ManagerSnapshot {
    const matching = this.getMatchingRecords();
    const start = this.pageIndex * PAGE_SIZE;
    const projects = uniqueProjectLabels([...this.localRecords, ...this.cloudRecords]);
    return {
      records: matching.slice(start, start + PAGE_SIZE).map(record => ({ ...record, raw: {} })),
      projects,
      sourceFilter: this.sourceFilter,
      projectFilter: this.projectFilter,
      search: this.search,
      sortKey: this.sortKey,
      sortDirection: this.sortDirection,
      pageIndex: this.pageIndex,
      pageSize: PAGE_SIZE,
      totalLoaded: this.sourceFilter === "local"
        ? this.localRecords.length
        : this.sourceFilter === "cloud"
          ? this.cloudRecords.length
          : this.localRecords.length + this.cloudRecords.length,
      filteredCount: matching.length,
      hasMore: matching.length > start + PAGE_SIZE || this.canLoadMoreForFilter(),
      errors: { ...this.errors },
      usage: this.usage,
      listRefreshedAt: this.listRefreshedAt,
      cli: this.getCliStatus(),
      loading: this.loading,
      message: this.message
    };
  }

  async initialize(): Promise<void> {
    this.loading = true;
    this.changed();
    const tasks: Promise<void>[] = [this.refreshListInternal(), this.refreshUsageInternal()];
    await Promise.all(tasks);
    const findPreferredProject = (): string | undefined => this.preferredProject
      ? uniqueProjectLabels([...this.localRecords, ...this.cloudRecords])
        .find(project => projectIdentity(project) === projectIdentity(this.preferredProject!))
      : undefined;
    let matchingProject = findPreferredProject();
    let scannedPages = 0;
    while (!matchingProject && this.preferredProject && this.localHasMore && scannedPages < MAX_SCAN_PAGES_PER_ACTION) {
      if (!await this.loadSource("local")) break;
      scannedPages += 1;
      matchingProject = findPreferredProject();
    }
    if (matchingProject && !this.projectFilter) {
      this.projectFilter = matchingProject;
      this.pageIndex = 0;
      this.scanLimitHit = false;
      this.loading = true;
      this.changed();
      await this.ensureVisiblePageFilled();
    }
    this.listRefreshedAt = Date.now();
    this.loading = false;
    this.changed();
  }

  async refresh(): Promise<void> {
    await this.refreshList();
    await this.refreshUsage();
  }

  async refreshList(): Promise<void> {
    if (this.listRefreshPromise) return this.listRefreshPromise;
    const refreshPromise = this.refreshListFromSources();
    this.listRefreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.listRefreshPromise === refreshPromise) this.listRefreshPromise = undefined;
    }
  }

  private async refreshListFromSources(): Promise<void> {
    this.loading = true;
    this.message = undefined;
    this.resetRecords();
    this.changed();
    await Promise.all([this.loadSource("local"), this.loadSource("cloud")]);
    await this.ensureVisiblePageFilled();
    this.listRefreshedAt = Date.now();
    this.loading = false;
    this.changed();
  }

  async refreshUsage(): Promise<void> {
    this.usage = undefined;
    this.changed();
    await this.refreshUsageInternal();
    this.changed();
  }

  async setSearch(value: string): Promise<void> {
    this.search = value.trim();
    this.pageIndex = 0;
    this.scanLimitHit = false;
    this.message = undefined;
    this.loading = true;
    this.changed();
    await this.ensureVisiblePageFilled();
    this.loading = false;
    this.changed();
  }

  async setSource(value: SourceFilter): Promise<void> {
    const refreshCloud = value === "cloud" && this.sourceFilter !== "cloud";
    this.sourceFilter = value;
    this.pageIndex = 0;
    this.scanLimitHit = false;
    this.message = undefined;
    this.loading = true;
    if (refreshCloud) {
      this.cloudRecords = [];
      this.cloudCursor = undefined;
      this.cloudLoaded = false;
      this.cloudHasMore = true;
      this.errors.cloud = undefined;
    }
    this.changed();
    await this.ensureVisiblePageFilled();
    if (refreshCloud) this.listRefreshedAt = Date.now();
    this.loading = false;
    this.changed();
  }

  async setProject(value: string): Promise<void> {
    if (this.sourceFilter === "cloud") return;
    this.projectFilter = value;
    this.pageIndex = 0;
    this.scanLimitHit = false;
    this.message = undefined;
    this.loading = true;
    this.changed();
    await this.ensureVisiblePageFilled();
    this.loading = false;
    this.changed();
  }

  async setSort(key: SortKey, direction: Direction): Promise<void> {
    this.sortKey = key;
    this.sortDirection = direction;
    this.pageIndex = 0;
    this.message = undefined;
    this.scanLimitHit = false;
    this.loading = true;
    this.resetRecords();
    this.changed();
    await Promise.all([this.loadSource("local"), this.loadSource("cloud")]);
    await this.ensureVisiblePageFilled();
    this.loading = false;
    this.changed();
  }

  async nextPage(): Promise<void> {
    const currentCount = this.getMatchingRecords().length;
    const targetPage = this.pageIndex + 1;
    const targetStart = targetPage * PAGE_SIZE;
    const targetEnd = targetStart + PAGE_SIZE;
    if (currentCount >= targetEnd) {
      this.pageIndex = targetPage;
      this.message = undefined;
      this.changed();
      return;
    }
    if (!this.canLoadMoreForFilter()) return;
    this.loading = true;
    this.scanLimitHit = false;
    this.message = undefined;
    this.changed();
    await this.ensureMatches(targetEnd);
    if (this.getMatchingRecords().length > targetStart) {
      this.pageIndex = targetPage;
    }
    this.loading = false;
    if (this.scanLimitHit) this.message = "已继续扫描一批较早会话。若仍未找到目标，请再次选择“下一页 / 继续扫描”。";
    this.changed();
  }

  async previousPage(): Promise<void> {
    if (this.pageIndex === 0) return;
    this.pageIndex -= 1;
    this.message = undefined;
    this.changed();
  }

  async openDetails(record: SessionRecord): Promise<Record<string, unknown>> {
    if (record.source === "cloud") {
      return { cloud: true, record: this.publicRecord(record), detailAvailable: false };
    }
    const detail = await this.data.getThreadDetails(record.id);
    return { cloud: false, record: this.publicRecord(record), detailAvailable: true, detail: this.publicDetails(detail) };
  }

  async listQuestions(record: SessionRecord): Promise<Array<{ index: number; text: string; startedAt?: number | string }>> {
    if (record.source !== "local") throw new Error("Codex Cloud 列表没有提供完整的问题内容。");
    const detail = await this.data.getThreadDetails(record.id);
    const questions: Array<{ index: number; text: string; startedAt?: number | string }> = [];
    const turns = Array.isArray(detail.turns) ? detail.turns : [];
    for (const value of turns) {
      const turn = asRecord(value);
      const startedAt = transcriptTimestamp(turn.startedAt);
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (const itemValue of items) {
        const item = asRecord(itemValue);
        if (item.type !== "userMessage") continue;
        questions.push({
          index: questions.length,
          text: contentText(item.content).trim() || "（此问题包含非文本内容）",
          ...(startedAt === undefined ? {} : { startedAt })
        });
      }
    }
    return questions;
  }

  findRecord(key: string): SessionRecord | undefined {
    return [...this.localRecords, ...this.cloudRecords].find(record => record.key === key);
  }

  async rename(record: SessionRecord, value: string): Promise<void> {
    if (record.source !== "local") throw new Error("云端会话当前未提供经验证的服务端重命名接口。");
    const name = value.trim();
    if (!name) throw new Error("名称不能为空。");
    await this.data.renameThread(record.id, name);
    await this.refreshList();
    this.message = "对话名称已更新。";
    this.changed();
  }

  async delete(record: SessionRecord): Promise<void> {
    if (record.source !== "local") throw new Error("云端会话不支持本地删除操作。");
    await this.data.deleteThread(record.id);
    await this.refreshList();
    this.message = "本地 Codex 对话记录已删除。";
    this.changed();
  }

  clearMessage(): void {
    this.message = undefined;
    this.changed();
  }

  emit(): void {
    this.changed();
  }

  dispose(): void {
    this.data.dispose();
  }

  private async refreshListInternal(): Promise<void> {
    this.resetRecords();
    await Promise.all([this.loadSource("local"), this.loadSource("cloud")]);
    await this.ensureVisiblePageFilled();
  }

  private async refreshUsageInternal(): Promise<void> {
    try {
      this.usage = await this.data.getUsage();
    } catch (error) {
      const message = shortError(error);
      this.usage = {
        accountStatus: "error", accountMessage: message,
        quotaStatus: "error", quotaMessage: message, buckets: [],
        tokenStatus: "error", tokenMessage: message
      };
    }
  }

  private resetRecords(): void {
    this.localRecords = [];
    this.cloudRecords = [];
    this.localCursor = undefined;
    this.cloudCursor = undefined;
    this.localLoaded = false;
    this.cloudLoaded = false;
    this.localHasMore = true;
    this.cloudHasMore = true;
    this.errors.local = undefined;
    this.errors.cloud = undefined;
    this.pageIndex = 0;
    this.scanLimitHit = false;
  }

  private async loadSource(source: SessionSource): Promise<boolean> {
    if (source === "local" && (!this.localHasMore || (this.localLoaded && this.localCursor === null))) return false;
    if (source === "cloud" && (!this.cloudHasMore || (this.cloudLoaded && this.cloudCursor === null))) return false;
    const cursor = source === "local" ? this.localCursor : this.cloudCursor;
    try {
      if (source === "local") {
        const page = await this.data.getLocalPage(cursor, this.sortKey, this.sortDirection);
        this.addUnique(this.localRecords, page.records);
        this.localLoaded = true;
        this.localHasMore = Boolean(page.cursor) && page.cursor !== cursor;
        this.localCursor = page.cursor ?? null;
      } else {
        const page = await this.data.getCloudPage(cursor);
        this.addUnique(this.cloudRecords, page.records);
        this.cloudLoaded = true;
        this.cloudHasMore = Boolean(page.cursor) && page.cursor !== cursor;
        this.cloudCursor = page.cursor ?? null;
      }
      this.errors[source] = undefined;
      return true;
    } catch (error) {
      this.errors[source] = shortError(error);
      if (source === "local") {
        this.localLoaded = true;
        this.localHasMore = false;
      } else {
        this.cloudLoaded = true;
        this.cloudHasMore = false;
      }
      return false;
    }
  }

  private async ensureVisiblePageFilled(): Promise<void> {
    await this.ensureMatches((this.pageIndex + 1) * PAGE_SIZE);
  }

  private async ensureMatches(requiredCount: number): Promise<void> {
    let loadedPages = 0;
    while (this.getMatchingRecords().length < requiredCount && this.canLoadMoreForFilter() && loadedPages < MAX_SCAN_PAGES_PER_ACTION) {
      const sources = this.sourcesToLoad();
      if (!sources.length) break;
      const loaded = await Promise.all(sources.map(source => this.loadSource(source)));
      if (!loaded.some(Boolean)) break;
      loadedPages += 1;
      this.changed();
    }
    this.scanLimitHit = this.getMatchingRecords().length < requiredCount && this.canLoadMoreForFilter() && loadedPages >= MAX_SCAN_PAGES_PER_ACTION;
  }

  private sourcesToLoad(): SessionSource[] {
    const sources: SessionSource[] = [];
    if ((this.sourceFilter === "all" || this.sourceFilter === "local") && this.localHasMore) sources.push("local");
    if ((this.sourceFilter === "all" || this.sourceFilter === "cloud") && this.cloudHasMore) sources.push("cloud");
    return sources;
  }

  private canLoadMoreForFilter(): boolean {
    return this.sourcesToLoad().length > 0;
  }

  private getMatchingRecords(): SessionRecord[] {
    const query = this.search.toLocaleLowerCase();
    return [...this.localRecords, ...this.cloudRecords]
      .filter(record => this.sourceFilter === "all" || record.source === this.sourceFilter)
      .filter(record => this.sourceFilter === "cloud" || !this.projectFilter || projectIdentity(record.projectLabel) === projectIdentity(this.projectFilter))
      .filter(record => !query || record.title.toLocaleLowerCase().includes(query))
      .sort((a, b) => {
        const aTime = this.sortValue(a);
        const bTime = this.sortValue(b);
        if (aTime === undefined && bTime === undefined) return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        if (aTime === undefined) return 1;
        if (bTime === undefined) return -1;
        const order = aTime - bTime;
        return this.sortDirection === "asc" ? order : -order;
      });
  }

  private sortValue(record: SessionRecord): number | undefined {
    if (this.sortKey === "created") return record.createdAt;
    if (this.sortKey === "active") return record.recencyAt ?? record.updatedAt;
    return record.updatedAt;
  }

  private addUnique(target: SessionRecord[], records: SessionRecord[]): void {
    const known = new Set(target.map(record => record.key));
    for (const record of records) {
      if (known.has(record.key)) continue;
      known.add(record.key);
      target.push(record);
    }
  }

  private publicRecord(record: SessionRecord): Record<string, unknown> {
    const { raw: _raw, ...safe } = record;
    return safe;
  }

  private publicDetails(detail: Record<string, unknown>): Record<string, unknown> {
    const allowed = ["id", "name", "preview", "cwd", "createdAt", "updatedAt", "recencyAt", "source", "originator", "status", "modelProvider", "model", "lastTurnEndedAt", "lastTurnCompletedAt"];
    const safe = Object.fromEntries(allowed.filter(key => detail[key] !== undefined).map(key => [key, detail[key]]));
    if (!Array.isArray(detail.turns)) return safe;

    const turns = detail.turns.map(value => {
      const turn = asRecord(value);
      const items = Array.isArray(turn.items) ? turn.items : [];
      const messages = items.flatMap(value => {
        const item = asRecord(value);
        if (item.type === "userMessage") {
          const text = contentText(item.content).trim() || "（此问题包含非文本内容）";
          return [{ role: "user", text }];
        }
        const phase = typeof item.phase === "string" ? item.phase.toLocaleLowerCase("en-US") : "";
        const visiblePhase = !phase || phase === "final_answer" || phase === "commentary";
        if (item.type === "agentMessage" && visiblePhase && typeof item.text === "string" && item.text.trim()) {
          return [{ role: "assistant", text: item.text }];
        }
        return [];
      });
      return {
        startedAt: transcriptTimestamp(turn.startedAt),
        messages
      };
    }).filter(turn => turn.messages.length > 0);
    return { ...safe, turns };
  }

  private changed(): void {
    this.onChange(this.snapshot());
  }
}
