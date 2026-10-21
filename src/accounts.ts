import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import type { AccountQuotaSnapshot, AccountSnapshot, SavedAccount, UsageBucket, UsageSnapshot } from "./types";
import { formatAccountQuota, formatQuotaRefreshTime } from "./quotaStatusBar";

interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface AccountIdentity {
  email: string;
  planType?: string;
  store: string;
}

export interface AccountBackend {
  read(home: string, refresh: boolean, isolated: boolean): Promise<AccountIdentity>;
  login(home: string, signal: AbortSignal): Promise<AccountIdentity>;
  readQuota?(home: string): Promise<{ identity: AccountIdentity; buckets: UsageBucket[] }>;
}

export class AccountAuthenticationError extends Error {}
export class AccountEnvironmentError extends Error {}
export class AccountStorageError extends Error {}
export class AccountCacheMissingError extends AccountStorageError {}

interface PendingSwitch {
  nonce: string;
  id: string;
  email: string;
  home: string;
  phase: "reloadRequired" | "confirmationRequired" | "confirmed";
  requestedAt: number;
}

interface AccountIndex {
  version: 1;
  items: SavedAccount[];
  pending?: PendingSwitch;
}

interface Credentials {
  content: string;
  accountId: string;
  hash: string;
}

function secretKey(id: string): string { return `sponge.accounts.${id}`; }
function emailKey(email: string): string { return email.trim().toLowerCase(); }
function validId(id: string): boolean { return /^[0-9a-f-]{36}$/.test(id); }

function credentials(content: string): Credentials {
  try {
    const raw = JSON.parse(content);
    const tokens = raw?.tokens;
    if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token
      || typeof tokens.refresh_token !== "string" || !tokens.refresh_token
      || typeof tokens.account_id !== "string" || !tokens.account_id) throw new Error();
    return { content, accountId: tokens.account_id, hash: createHash("sha256").update(content).digest("hex") };
  } catch {
    throw new Error("未找到可保存的 ChatGPT 登录状态；仅支持官方 CLI 保存的 ChatGPT 登录，不能保存 API 密钥或临时登录。");
  }
}

async function readCredentials(home: string): Promise<Credentials> {
  const file = join(home, "auth.json");
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error();
    return credentials(await fs.readFile(file, "utf8"));
  } catch {
    throw new Error("无法读取此环境的文件登录缓存。请先用 ChatGPT 登录；系统凭据库或临时登录模式暂不支持保存切换。");
  }
}

async function optionalCredentials(home: string): Promise<Credentials | undefined> {
  try { await fs.lstat(join(home, "auth.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return readCredentials(home);
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

export class AccountManager {
  private index: AccountIndex = { version: 1, items: [] };
  private currentEmail?: string;
  private currentAccountId?: string;
  private currentUsage?: UsageSnapshot;
  private currentUsageAt?: number;
  private quotas = new Map<string, { status: AccountQuotaSnapshot["status"]; buckets: UsageBucket[]; checkedAt?: number }>();
  private quotaRefresh?: Promise<void>;
  private refreshingQuotas = false;
  private stopQuotaRefresh = false;
  private disposed = false;
  private busy = false;
  private message?: string;
  private loginAbort?: AbortController;
  private bootSwitch?: string;
  private verifiedSwitch?: string;
  private confirmedSwitch?: string;
  private readonly root: string;

  constructor(
    storagePath: string,
    private readonly home: string,
    private readonly secrets: Secrets,
    private readonly backend: AccountBackend,
    private readonly changed: () => void,
    private readonly beforeSwitch: () => Promise<void>
  ) { this.root = resolve(storagePath, "accounts"); }

  async initialize(): Promise<void> {
    await this.loadIndex();
    this.bootSwitch = this.index.pending?.nonce;
    this.changed();
  }

  async refreshIndex(): Promise<void> { if (!this.busy) { await this.loadIndex(); this.changed(); } }

  observeUsage(usage?: UsageSnapshot): void {
    if (this.currentUsage !== usage) this.currentUsageAt = usage ? Date.now() : undefined;
    this.currentUsage = usage;
    if (this.currentEmail !== usage?.email) this.currentAccountId = undefined;
    this.currentEmail = usage?.accountStatus === "available" ? usage.email : undefined;
    if (this.currentEmail && this.index.pending && emailKey(this.currentEmail) !== emailKey(this.index.pending.email)) {
      this.verifiedSwitch = undefined;
      this.confirmedSwitch = undefined;
      this.message = "检测到当前账户已变化，请从账户菜单重新选择并核对。";
    }
  }

  snapshot(): AccountSnapshot {
    const pending = this.index.pending;
    const currentId = this.index.items.find(item => emailKey(item.email) === emailKey(this.currentEmail ?? "")
      && (!this.currentAccountId || item.accountId === this.currentAccountId))?.id;
    const currentQuota: AccountQuotaSnapshot | undefined = this.currentUsage
      && emailKey(this.currentUsage.email ?? "") === emailKey(this.currentEmail ?? "") ? {
      status: this.currentUsage.quotaStatus,
      text: this.currentUsage.quotaStatus === "available" ? formatAccountQuota(this.currentUsage.buckets) : undefined,
      checkedAt: this.currentUsageAt,
      refreshText: formatQuotaRefreshTime(this.currentUsageAt)
    } : undefined;
    return {
      items: this.index.items.map(item => {
        const quota = this.quotas.get(item.id);
        return { ...item, quota: item.id === currentId ? currentQuota : quota ? {
          status: quota.status, checkedAt: quota.checkedAt,
          refreshText: formatQuotaRefreshTime(quota.checkedAt),
          text: quota.status === "available" ? formatAccountQuota(quota.buckets) : undefined
        } : undefined };
      }),
      currentId,
      currentQuota,
      refreshingQuotas: this.refreshingQuotas,
      busy: this.busy && !this.refreshingQuotas,
      canCancel: Boolean(this.loginAbort),
      currentEmail: this.currentEmail,
      targetEmail: pending?.email,
      phase: pending && emailKey(pending.email) === emailKey(this.currentEmail ?? "")
        ? this.confirmedSwitch === pending.nonce ? "confirmed"
          : this.verifiedSwitch === pending.nonce ? "confirmationRequired" : "reloadRequired"
        : "unverified",
      message: this.message
    };
  }

  cancelLogin(): void { this.loginAbort?.abort(); }
  dispose(): void { this.disposed = true; this.cancelLogin(); }

  refreshQuotas(): Promise<void> {
    if (this.quotaRefresh) return this.quotaRefresh;
    if (this.busy || this.disposed || !this.backend.readQuota) return Promise.resolve();
    this.stopQuotaRefresh = false;
    this.refreshingQuotas = true;
    this.quotaRefresh = this.exclusive(async () => {
      const active = await optionalCredentials(this.home);
      this.currentAccountId = active?.accountId;
      for (const item of this.index.items) {
        if (this.disposed || this.stopQuotaRefresh) break;
        if (item.accountId === active?.accountId && emailKey(item.email) === emailKey(this.currentEmail ?? "")) continue;
        this.quotas.set(item.id, { status: "loading", buckets: [] });
        this.changed();
        try {
          const saved = await this.loadSaved(item);
          if (saved.accountId !== item.accountId) throw new Error("账户标识不一致。");
          const result = await this.withTemporaryHome(async home => {
            await atomicWrite(join(home, "auth.json"), saved.content);
            try {
              const result = await this.backend.readQuota!(home);
              const updated = await readCredentials(home);
              if (emailKey(result.identity.email) !== emailKey(item.email) || updated.accountId !== item.accountId) {
                throw new Error("额度返回的账户标识不一致。");
              }
              return result;
            } finally {
              // Quota requests can renew credentials even when a later request fails.
              const rotated = await optionalCredentials(home).catch(() => undefined);
              if (rotated?.accountId === saved.accountId && rotated.hash !== saved.hash) {
                await this.storeSaved(item.id, rotated.content);
              }
            }
          });
          this.quotas.set(item.id, { status: result.buckets.length ? "available" : "unavailable", buckets: result.buckets, checkedAt: Date.now() });
          if (item.state !== "saved") { item.state = "saved"; await this.writeIndex(); }
        } catch (error) {
          const reauth = error instanceof AccountAuthenticationError;
          this.quotas.set(item.id, { status: error instanceof AccountCacheMissingError ? "cacheMissing" : reauth ? "reauth" : "error", buckets: [], checkedAt: Date.now() });
          if (reauth && item.state !== "reauth") { item.state = "reauth"; await this.writeIndex(); }
        }
        this.changed();
      }
    }, true).catch(() => {
      for (const item of this.index.items) {
        if (!this.quotas.has(item.id) || this.quotas.get(item.id)?.status === "loading") {
          this.quotas.set(item.id, { status: "error", buckets: [], checkedAt: Date.now() });
        }
      }
    }).finally(() => {
      this.refreshingQuotas = false;
      this.quotaRefresh = undefined;
      this.changed();
    });
    return this.quotaRefresh;
  }

  async saveCurrent(): Promise<void> {
    await this.exclusive(async () => {
      const identity = await this.backend.read(this.home, false, false);
      this.requireFileStore(identity);
      const cache = await readCredentials(this.home);
      await this.save(identity, cache);
      this.currentEmail = identity.email;
      this.currentAccountId = cache.accountId;
      this.message = "当前账户已保存；之后可从账户菜单切换。";
    });
  }

  async add(externalSignal?: AbortSignal): Promise<void> {
    await this.exclusive(async () => {
      this.loginAbort = new AbortController();
      const forwardCancel = () => this.loginAbort?.abort();
      externalSignal?.addEventListener("abort", forwardCancel, { once: true });
      if (externalSignal?.aborted) forwardCancel();
      this.message = "请在浏览器中授权要添加的账户；当前 Codex 账户保持可用。";
      this.changed();
      try {
        await this.withTemporaryHome(async home => {
          const identity = await this.backend.login(home, this.loginAbort!.signal);
          this.requireFileStore(identity);
          const cache = await readCredentials(home);
          await this.save(identity, cache);
          this.message = "账户已安全保存；在账户菜单中选择它即可切换。";
        });
      } finally {
        externalSignal?.removeEventListener("abort", forwardCancel);
        this.loginAbort = undefined;
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(async () => {
      const item = this.find(id);
      // Only the encrypted saved copy is removed. The active CLI login is not logged out.
      await this.secrets.delete(secretKey(item.id));
      this.index.items = this.index.items.filter(account => account.id !== id);
      this.quotas.delete(id);
      if (this.index.pending?.id === id) this.index.pending = undefined;
      await this.writeIndex();
      this.message = "已移除此账户的保存副本，当前登录和本地会话未删除。";
    });
  }

  async switchTo(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const item = this.find(id);
      const previousIdentity = await this.backend.read(this.home, false, false);
      this.requireFileStore(previousIdentity, false);
      const previous = await optionalCredentials(this.home);
      if (emailKey(previousIdentity.email) === emailKey(item.email) && previous?.accountId === item.accountId) {
        await this.save(previousIdentity, previous);
        this.currentEmail = previousIdentity.email;
        this.currentAccountId = previous.accountId;
        this.message = "当前已是此账户，已重新保存当前有效登录副本；如需确认 Codex，请使用账户菜单中的核对操作。";
        return false;
      }
      if (previous && previousIdentity.email) await this.save(previousIdentity, previous);
      const saved = await this.loadSaved(item);
      let candidate: Credentials;
      try {
        candidate = await this.withTemporaryHome(async home => {
          await atomicWrite(join(home, "auth.json"), saved.content);
          let identity: AccountIdentity;
          try { identity = await this.backend.read(home, true, true); }
          catch (error) {
            // A concurrent config/read failure can follow a successful token rotation.
            const rotated = await optionalCredentials(home).catch(() => undefined);
            if (rotated?.accountId === saved.accountId && rotated.hash !== saved.hash) {
              await this.storeSaved(item.id, rotated.content);
            }
            throw error;
          }
          const refreshed = await readCredentials(home);
          if (!identity.email) throw new AccountAuthenticationError("保存的登录已失效。");
          if (emailKey(identity.email) !== emailKey(item.email) || refreshed.accountId !== saved.accountId) {
            throw new Error("登录状态返回的账户与选中的账户不一致。");
          }
          // Preserve rotated refresh tokens before making any change to the active login.
          await this.storeSaved(item.id, refreshed.content);
          item.state = "saved";
          await this.writeIndex();
          return refreshed;
        });
      } catch (error) {
        if (error instanceof AccountEnvironmentError || error instanceof AccountStorageError) throw error;
        if (error instanceof AccountAuthenticationError) {
          item.state = "reauth";
          await this.writeIndex();
          throw new Error("所选账户登录已失效，当前账户未切换。请通过“添加其他账户”重新授权该账户后重试。");
        }
        throw new Error("暂时无法在线核验所选账户，当前账户未切换。请检查网络并重试；不会因网络异常自动要求重新登录。");
      }
      if ((await optionalCredentials(this.home))?.hash !== previous?.hash) {
        throw new Error("其他 Codex 客户端更新了登录状态；为避免覆盖，本次未切换。请结束正在进行的任务后重试。");
      }
      await this.beforeSwitch();
      const previousPending = this.index.pending;
      this.index.pending = { nonce: randomUUID(), id: item.id, email: item.email, home: resolve(this.home), phase: "reloadRequired", requestedAt: Date.now() };
      await this.writeIndex();
      try {
        await atomicWrite(join(this.home, "auth.json"), candidate.content);
        const actual = await this.backend.read(this.home, false, false);
        const actualCache = await readCredentials(this.home);
        if (emailKey(actual.email) !== emailKey(item.email) || actualCache.accountId !== candidate.accountId) throw new Error();
      } catch {
        const actual = await readCredentials(this.home).catch(() => undefined);
        if (actual?.hash === candidate.hash) {
          if (previous) await atomicWrite(join(this.home, "auth.json"), previous.content);
          else await fs.unlink(join(this.home, "auth.json"));
        }
        this.index.pending = previousPending;
        await this.writeIndex();
        throw new Error("切换后的账户核验失败；请刷新并检查当前账户。未覆盖其他客户端随后写入的登录状态。");
      }
      this.currentEmail = item.email;
      this.currentAccountId = candidate.accountId;
      this.message = "CLI 账户已核验，需重载当前窗口，让 Codex 采用新的登录状态。其他 Codex 窗口也需重载。";
      return true;
    });
  }

  async verifyAfterReload(): Promise<void> {
    await this.exclusive(async () => {
      const pending = this.index.pending;
      if (!pending) return;
      if (pending.nonce !== this.bootSwitch) throw new Error("请先重载当前窗口，再核验 Codex 账户。");
      if (resolve(pending.home) !== resolve(this.home)) throw new Error("当前 Codex Home 与切换账户时不同，无法核验；请检查 CLI / 环境。");
      const item = this.find(pending.id);
      const actual = await this.backend.read(this.home, false, false);
      const cache = await readCredentials(this.home);
      if (emailKey(actual.email) !== emailKey(item.email) || item.accountId !== cache.accountId) {
        this.index.pending = undefined;
        await this.writeIndex();
        throw new Error("账户核验不一致：当前 CLI 登录与选中账户不同，请从账户菜单重新选择。");
      }
      // Keep the newest official cache, never restore an old refresh token after a restart.
      await this.storeSaved(item.id, cache.content);
      item.state = "saved";
      this.currentEmail = actual.email;
      this.currentAccountId = cache.accountId;
      this.verifiedSwitch = pending.nonce;
      if (pending.phase === "reloadRequired") pending.phase = "confirmationRequired";
      await this.writeIndex();
      this.message = this.confirmedSwitch === pending.nonce ? "已核对当前账户。" : "CLI 已核验；请核对 Codex 个人菜单中显示的账户。";
    });
  }

  async confirmIde(email: string): Promise<void> {
    await this.exclusive(async () => {
      const pending = this.index.pending;
      if (!pending || this.verifiedSwitch !== pending.nonce) throw new Error("请先切换账户并重载窗口，再核对 Codex 账户。");
      const actual = await this.backend.read(this.home, false, false);
      const cache = await readCredentials(this.home);
      if (emailKey(email) !== emailKey(pending.email) || emailKey(actual.email) !== emailKey(pending.email) || cache.accountId !== this.find(pending.id).accountId) {
        throw new Error("Codex 中显示的邮箱与目标账户不一致，尚未标记为已核对。请重载 Codex 并重新检查。");
      }
      pending.phase = "confirmed";
      this.confirmedSwitch = pending.nonce;
      await this.writeIndex();
      this.message = "Codex 显示的账户已由你核对，且与 CLI 账户一致。";
    });
  }

  private requireFileStore(identity: AccountIdentity, requireAccount = true): void {
    if (identity.store !== "file") throw new Error("当前使用系统凭据库或临时登录模式；此版本仅支持文件登录缓存，不会自动修改你的凭据存储设置。");
    if (requireAccount && !identity.email.trim()) throw new Error("官方服务未返回账户邮箱，无法可靠识别和保存账户。");
  }

  private find(id: string): SavedAccount {
    const item = this.index.items.find(account => account.id === id && validId(id));
    if (!item) throw new Error("账户已移除或不存在，请重新打开账户菜单。");
    return item;
  }

  private async save(identity: AccountIdentity, cache: Credentials): Promise<void> {
    let item = this.index.items.find(account => account.accountId === cache.accountId && emailKey(account.email) === emailKey(identity.email));
    if (!item) {
      item = { id: randomUUID(), email: identity.email.trim(), accountId: cache.accountId, state: "saved", planType: identity.planType };
    }
    await this.storeSaved(item.id, cache.content);
    if (!this.index.items.some(account => account.id === item!.id)) this.index.items.push(item);
    item.state = "saved";
    item.planType = identity.planType;
    await this.writeIndex();
  }

  private async loadSaved(item: SavedAccount): Promise<Credentials> {
    let encoded: string | undefined;
    try { encoded = await this.secrets.get(secretKey(item.id)); }
    catch {
      throw new AccountStorageError("无法访问 VS Code 加密存储。请解锁系统密钥环并完全退出所有 VS Code 进程后重新启动，再重试；这不表示账户授权已失效。");
    }
    if (!encoded) {
      item.state = "cacheMissing";
      await this.writeIndex();
      throw new AccountCacheMissingError("此账户只有邮箱记录，加密登录副本未能读取。请先解锁系统密钥环并完全退出所有 VS Code 进程后重新启动（仅重载窗口不够）。当前仍登录的账户可点“保存当前账户”恢复；其他账户在存储恢复后重试，仍缺失时需重新添加一次。");
    }
    try { return credentials(encoded); }
    catch { throw new AccountStorageError("此账户保存的登录副本格式无效。当前仍登录的账户可重新保存；其他账户需要重新添加，未改变当前登录。"); }
  }

  private async storeSaved(id: string, content: string): Promise<void> {
    try {
      await this.secrets.store(secretKey(id), content);
      if (await this.secrets.get(secretKey(id)) !== content) throw new Error();
    } catch {
      throw new AccountStorageError("VS Code 加密存储写入或回读失败，未确认保存成功。请解锁系统密钥环，完全退出所有 VS Code 进程后重新启动并重试。");
    }
  }

  private async loadIndex(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await fs.readFile(join(this.root, "index.json"), "utf8")) as AccountIndex;
      if (raw.version !== 1 || !Array.isArray(raw.items) || raw.items.some(item => !validId(item.id) || typeof item.email !== "string" || typeof item.accountId !== "string")) throw new Error();
      this.index = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("账户列表无法读取；请保留本机存储并检查文件，未覆盖已有列表。");
      this.index = { version: 1, items: [] };
    }
  }

  private async writeIndex(): Promise<void> { await atomicWrite(join(this.root, "index.json"), JSON.stringify(this.index)); }

  private async withTemporaryHome<T>(run: (home: string) => Promise<T>): Promise<T> {
    const home = await fs.mkdtemp(join(this.root, "login-"));
    await fs.chmod(home, 0o700);
    try { return await run(home); }
    finally {
      const absolute = resolve(home);
      if (absolute.startsWith(this.root + sep) && dirname(absolute) === this.root) {
        try {
          await fs.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
        } catch {
          throw new AccountEnvironmentError("账户临时目录仍被系统占用，未完成切换。请稍后重试；不需要因此重新登录。");
        }
      }
    }
  }

  private async exclusive<T>(run: () => Promise<T>, background = false): Promise<T> {
    if (!background && this.quotaRefresh) {
      this.stopQuotaRefresh = true;
      await this.quotaRefresh;
    }
    if (this.busy) throw new Error("正在处理账户操作，请稍候；浏览器登录可从账户菜单取消。");
    this.busy = true;
    this.changed();
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
    const lockPath = join(this.root, "operation.lock");
    try {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      try { lock = await fs.open(lockPath, "wx", 0o600); }
      catch {
        let stale = false;
        try {
          const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
          }
        } catch {}
        if (stale) {
          await fs.unlink(lockPath).catch(() => {});
          lock = await fs.open(lockPath, "wx", 0o600).catch(() => undefined);
        }
        if (!lock) throw new Error("另一个 VS Code 窗口正在操作账户，请完成或取消该操作后重试。");
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await this.loadIndex();
      return await run();
    } catch (error) {
      if (!background) this.message = error instanceof Error ? error.message : "账户操作未完成，请重试。";
      throw error;
    } finally {
      if (lock) { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
      this.busy = false;
      this.changed();
    }
  }
}
