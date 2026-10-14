import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";

export interface CliTarget {
  path: string;
  source: "configured" | "chatgpt" | "PATH";
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
}

export function configuredCliPath(): string | undefined {
  const configured = vscode.workspace.getConfiguration("sponge").get<string>("codexCliPath", "").trim();
  return configured || undefined;
}

export function findCliOnPath(): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = resolve(directory.replace(/^"|"$/g, ""), name);
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function findChatGptBundledCli(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const extensionPath = vscode.extensions.getExtension("openai.chatgpt")?.extensionPath;
  if (!extensionPath) return undefined;

  const binPath = join(extensionPath, "bin");
  try {
    const directories = readdirSync(binPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith("windows-"))
      .map(entry => entry.name);
    const preferredArchitecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    directories.sort((left, right) => {
      const leftPreferred = left.toLowerCase().endsWith(preferredArchitecture);
      const rightPreferred = right.toLowerCase().endsWith(preferredArchitecture);
      return Number(rightPreferred) - Number(leftPreferred) || left.localeCompare(right);
    });
    for (const directory of directories) {
      const candidate = join(binPath, directory, "codex.exe");
      if (isRunnableFile(candidate)) return candidate;
    }
  } catch {
    // The Codex extension may not be installed, or its package layout may differ.
  }
  return undefined;
}

export function resolveCliTarget(): CliTarget | undefined {
  const configured = configuredCliPath();
  if (configured) return { path: resolve(configured), source: "configured" };
  const bundled = findChatGptBundledCli();
  if (bundled) return { path: bundled, source: "chatgpt" };
  const path = findCliOnPath();
  return path ? { path, source: "PATH" } : undefined;
}

export function isRunnableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function spawnCli(path: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
  const extension = extname(path).toLowerCase();
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const command = ["&", powershellQuote(path), ...args.map(powershellQuote), "; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }"].join(" ");
    return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], options) as ChildProcessWithoutNullStreams;
  }
  const executable = isAbsolute(path) ? path : path;
  return spawn(executable, args, options) as ChildProcessWithoutNullStreams;
}

export function spawnAppServer(path: string): ChildProcessWithoutNullStreams {
  return spawnCli(path, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"] });
}

export function runCli(path: string, args: string[], timeoutMs = 60_000, cwd?: string): Promise<CliRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCli(path, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new Error(`命令超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 12_000_000) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        rejectPromise(new Error("Codex CLI 输出超过 12 MB，已停止读取。"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-24_000);
    });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(stderr.trim() || `Codex CLI 退出，代码 ${code ?? "未知"}`));
    });
  });
}

export function pathDisplay(target: CliTarget | undefined): string {
  return target?.path ?? "未检测到 Codex CLI";
}

export function cliSearchCandidatesForHelp(): string[] {
  return process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex.bat"]
    : [join("$PATH", "codex")];
}
