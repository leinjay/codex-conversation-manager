// Chromium DevTools helper for the installed VS Code, with no test-library dependency.
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.contexts = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
        }
      } else if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params.context;
        this.contexts.set(`${message.sessionId}:${context.id}`, { sessionId: message.sessionId, contextId: context.id });
      } else if (message.method === 'Runtime.executionContextDestroyed') {
        this.contexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
      }
    });
  }
  static async connect(port) {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async discover() {
    const { targetInfos } = await this.send('Target.getTargets');
    this.attached ??= new Set();
    for (const target of targetInfos.filter(t => ['page', 'iframe'].includes(t.type))) {
      if (this.attached.has(target.targetId)) continue;
      const { sessionId } = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      this.attached.add(target.targetId);
      if (target.type === 'page') this.pageSession = sessionId;
      await this.send('Runtime.enable', {}, sessionId);
    }
  }
  async evaluate(context, expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, contextId: context.contextId, returnByValue: true, awaitPromise: true }, context.sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }
  async webview(page) {
    for (let attempt = 0; attempt < 80; attempt++) {
      await this.discover();
      for (const context of this.contexts.values()) {
        try { if (await this.evaluate(context, 'document.body?.dataset.page') === page) return context; } catch { /* Frame navigated. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Webview ${page} not found`);
  }
  async until(context, expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await this.evaluate(context, expression);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Webview condition timed out: ${expression}`);
  }
  async screenshot() {
    return (await this.send('Page.captureScreenshot', { format: 'png' }, this.pageSession)).data;
  }
  close() { this.socket.close(); }
}
module.exports = { CDP };
