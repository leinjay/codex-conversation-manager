export function codexIdeThreadUri(extensionId: string, threadId: string): string {
  if (!extensionId.trim()) throw new Error("缺少 Codex VS Code 扩展标识。");
  if (!threadId.trim()) throw new Error("此本地对话没有有效的 thread ID。");
  const normalizedThreadId = threadId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedThreadId)) {
    throw new Error("此本地对话的 thread ID 格式不受 VS Code Codex 路由支持。");
  }
  return `vscode://${extensionId}/local/${encodeURIComponent(normalizedThreadId)}`;
}
