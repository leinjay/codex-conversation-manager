import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnAppServer, type AppServerProcessOptions } from "./cli";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class AppServerSession {
  private child?: ChildProcessWithoutNullStreams;
  private lineBuffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = "";
  private closed = false;
  private childClosed = false;
  private stopping?: Promise<void>;
  private initialized = false;
  private startupError?: Error;
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();

  constructor(private readonly cliPath: string, private readonly options: AppServerProcessOptions = {}) {}

  async connect(): Promise<Record<string, unknown>> {
    this.child = spawnAppServer(this.cliPath, this.options);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.acceptChunk(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_000);
    });
    this.child.once("error", error => {
      this.startupError = error;
      this.failAll(error);
    });
    this.child.once("close", code => {
      this.childClosed = true;
      this.closed = true;
      const error = new Error(this.stderr.trim() || `Codex App Server 已退出（代码 ${code ?? "未知"}）`);
      this.startupError = error;
      this.failAll(error);
    });

    try {
      const result = await this.request<Record<string, unknown>>("initialize", {
        clientInfo: {
          name: "sponge_codex_conversation_manager",
          title: "Sponge Codex Conversation Manager",
          version: "0.1.0"
        }
      }, 15_000);
      this.send({ method: "initialized", params: {} });
      this.initialized = true;
      return result;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed || !this.child || this.child.killed) {
      throw this.startupError ?? new Error("Codex App Server 尚未运行。请检查 Codex CLI 路径并重新验证。 ");
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求 ${method} 超时。`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer
      });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  isInitialized(): boolean {
    return this.initialized && !this.closed;
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  stop(): void {
    this.closed = true;
    this.initialized = false;
    this.failAll(new Error("Codex App Server 已关闭。"));
    this.notificationListeners.clear();
    if (this.child && !this.child.killed) this.child.kill();
  }

  stopAndWait(timeoutMs = 5000): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child || this.childClosed) {
      this.stop();
      return Promise.resolve();
    }
    this.stopping = new Promise<void>((resolve, reject) => {
      const onClose = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        child.removeListener("close", onClose);
        reject(new Error("等待 Codex 账户校验进程退出超时。"));
      }, timeoutMs);
      // Register before kill: Windows releases SQLite handles only after process exit.
      child.once("close", onClose);
      this.stop();
    });
    return this.stopping;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child || this.closed) throw new Error("Codex App Server 连接已关闭。");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private acceptChunk(chunk: string): void {
    this.lineBuffer += chunk;
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      newline = this.lineBuffer.indexOf("\n");
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (message.id === undefined) {
        if (message.method) {
          for (const listener of this.notificationListeners) listener(message.method, message.params);
        }
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const suffix = message.error.data === undefined ? "" : ` (${JSON.stringify(message.error.data)})`;
        pending.reject(new Error(`${message.error.message ?? "App Server 请求失败"}${suffix}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
