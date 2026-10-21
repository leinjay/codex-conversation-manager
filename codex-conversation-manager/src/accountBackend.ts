import { AppServerSession } from "./appServer";
import type { AccountBackend, AccountIdentity } from "./accounts";
import { AccountAuthenticationError, AccountEnvironmentError } from "./accounts";
import type { CliTarget } from "./cli";
import { normalizeQuotaBuckets } from "./quota";
import type { UsageBucket } from "./types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

class AuthFlowError extends Error {}

function authenticationFailure(error: unknown): boolean {
  return error instanceof Error && /401|unauthori[sz]ed|invalid.grant|refresh.token.*(?:expired|revoked|reused)|token.*has expired/i.test(error.message);
}

export class CodexAccountBackend implements AccountBackend {
  constructor(private readonly target: () => CliTarget | undefined, private readonly openAuth: (url: string) => Promise<void>) {}

  async readQuota(home: string): Promise<{ identity: AccountIdentity; buckets: UsageBucket[] }> {
    const session = this.session(home, true);
    try {
      await session.connect();
      let identity = await this.readFrom(session, false);
      if (!identity.email) throw new AccountAuthenticationError("保存的登录已失效。");
      let raw: Record<string, unknown>;
      try { raw = await session.request<Record<string, unknown>>("account/rateLimits/read"); }
      catch (error) {
        if (!authenticationFailure(error)) throw error;
        // Renew an expired access token once before treating the saved login as invalid.
        identity = await this.readFrom(session, true);
        if (!identity.email) throw new AccountAuthenticationError("保存的登录已失效。");
        raw = await session.request<Record<string, unknown>>("account/rateLimits/read");
      }
      return { identity, buckets: normalizeQuotaBuckets(raw) };
    } catch (error) {
      if (error instanceof AccountAuthenticationError || authenticationFailure(error)) {
        throw new AccountAuthenticationError("保存的 ChatGPT 登录已失效，需要重新授权。");
      }
      throw new Error("账户额度读取失败，请稍后刷新重试。");
    } finally { await this.close(session); }
  }

  async read(home: string, refresh: boolean, isolated: boolean): Promise<AccountIdentity> {
    const session = this.session(home, isolated);
    try {
      await session.connect();
      return await this.readFrom(session, refresh);
    } catch (error) {
      if (authenticationFailure(error)) {
        throw new AccountAuthenticationError("保存的 ChatGPT 登录已失效，需要重新授权。");
      }
      if (error instanceof Error && error.message.startsWith("当前")) throw error;
      throw new Error("无法核验官方 CLI 的 ChatGPT 账户；请检查网络和登录状态后重试。");
    } finally { await this.close(session); }
  }

  async login(home: string, signal: AbortSignal): Promise<AccountIdentity> {
    const session = this.session(home, true);
    let loginId: string | undefined;
    let unsubscribe = () => {};
    let timer: NodeJS.Timeout | undefined;
    let abort = () => {};
    try {
      if (signal.aborted) throw new AuthFlowError("已取消添加账户。");
      await session.connect();
      if (signal.aborted) throw new AuthFlowError("已取消添加账户。");
      const completed = new Promise<void>((resolve, reject) => {
        const fail = (message: string) => reject(new AuthFlowError(message));
        unsubscribe = session.onNotification((method, value) => {
          if (method !== "account/login/completed") return;
          const params = record(value);
          if (loginId && params.loginId !== loginId) return;
          if (params.success === true) resolve();
          else fail("账户授权未成功，请重新添加账户。当前账户未改变。");
        });
        abort = () => fail("已取消添加账户。");
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => fail("授权等待已超时；请重新添加账户。"), 5 * 60_000);
      });
      // A cancellation or early notification can precede the login-start response.
      void completed.catch(() => {});
      const result = await session.request<Record<string, unknown>>("account/login/start", { type: "chatgpt" });
      loginId = typeof result.loginId === "string" ? result.loginId : undefined;
      if (signal.aborted) throw new AuthFlowError("已取消添加账户。");
      if (typeof result.authUrl !== "string") throw new AuthFlowError("CLI 未提供浏览器授权地址；请更新 Codex 插件后重试。");
      const url = new URL(result.authUrl);
      if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com", "auth0.openai.com"].includes(url.hostname)) {
        throw new AuthFlowError("CLI 返回了无法确认的授权地址，未打开浏览器。");
      }
      await this.openAuth(url.toString());
      await completed;
      const identity = await this.readFrom(session, false);
      if (signal.aborted) throw new AuthFlowError("已取消添加账户。");
      return identity;
    } catch (error) {
      if (error instanceof AuthFlowError) throw error;
      throw new Error("添加账户未完成，请检查默认浏览器、网络及官方登录状态后重试；当前账户未改变。");
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (loginId && signal.aborted) {
        await session.request("account/login/cancel", { loginId }, 2000).catch(() => {});
      }
      await this.close(session);
    }
  }

  private async close(session: AppServerSession): Promise<void> {
    try { await session.stopAndWait(); }
    catch {
      throw new AccountEnvironmentError("账户校验进程尚未退出，未完成切换。请稍后重试；不需要因此重新登录。");
    }
  }

  private session(home: string, isolated: boolean): AppServerSession {
    const target = this.target();
    if (!target) throw new Error("当前未找到 Codex CLI，请先在 CLI / 环境中完成检测。");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    for (const key of ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"]) {
      if (!isolated && env[key]) throw new Error("当前环境由外部令牌或 API 密钥控制登录，无法使用已保存的 ChatGPT 账户切换。");
      if (isolated) delete env[key];
    }
    return new AppServerSession(target.path, { env, config: isolated ? ['cli_auth_credentials_store="file"'] : [] });
  }

  private async readFrom(session: AppServerSession, refresh: boolean): Promise<AccountIdentity> {
    const [result, configResult] = await Promise.all([
      session.request<Record<string, unknown>>("account/read", { refreshToken: refresh }),
      session.request<Record<string, unknown>>("config/read", { includeLayers: false })
    ]);
    const account = record(result.account);
    const config = record(configResult.config);
    const store = typeof config.cli_auth_credentials_store === "string" ? config.cli_auth_credentials_store : "file";
    if (result.account == null) return { email: "", store };
    if (account.type !== "chatgpt" || typeof account.email !== "string" || !account.email.trim()) {
      throw new Error("当前 CLI 没有可核验的 ChatGPT 邮箱，请完成官方登录；API 密钥登录暂不支持保存切换。");
    }
    return { email: account.email.trim(), planType: typeof account.planType === "string" ? account.planType : undefined, store };
  }
}
