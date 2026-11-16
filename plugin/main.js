/* Persistent native entry point. Bundled after runtime.js by setup. */
(() => {
  let document, active = null;
  const receipts = new Map();
  const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  const sessionId = 'session-' + uid();
  figma.showUI(__html__, { width: 320, height: 272, themeColors: true });
  function identity() {
    if (document) return document;
    let id = figma.root.getPluginData('figma-local-document-id');
    if (!id) {
      id = uid();
      figma.root.setPluginData('figma-local-document-id', id);
    }
    document = { id: figma.fileKey ? 'file:' + figma.fileKey : 'local:' + id,
      name: figma.root.name, ...(figma.fileKey ? { fileKey: figma.fileKey } : {}) };
    return document;
  }
  figma.ui.onmessage = async message => {
    if (message.type === 'hello') {
      try { figma.ui.postMessage({ type: 'ready', sessionId, document: identity() }); }
      catch (error) { figma.ui.postMessage({ type: 'init-error', error: String(error.message || error) }); }
      return;
    }
    if (message.type !== 'execute' || typeof message.job?.id !== 'string') return;
    const job = message.job;
    if (receipts.has(job.id)) { figma.ui.postMessage(receipts.get(job.id)); return; }
    if (active) {
      figma.ui.postMessage({ type: 'result', operationId: job.id, ok: false,
        error: { message: 'Another operation is still running. Inspect before retrying.' } });
      return;
    }
    active = job.id;
    let response;
    try {
      const result = await globalThis.FigmaLocalRuntime.execute(figma, job.method, job.params || {});
      // Detach native handles and reject non-JSON results before returning them.
      const json = JSON.stringify(result === undefined ? null : result);
      if (json.length > 11 * 1024 * 1024) throw new Error('Result too large; return IDs or export a smaller region.');
      response = { type: 'result', operationId: job.id, ok: true, result: JSON.parse(json) };
      if (!['inspect', 'fonts', 'export'].includes(job.method)) figma.commitUndo();
    } catch (error) {
      response = { type: 'result', operationId: job.id, ok: false, error: {
        message: String(error.message || error),
        ...(error.createdNodeIds ? { createdNodeIds: error.createdNodeIds } : {}),
      } };
    } finally { active = null; }
    receipts.set(job.id, response);
    if (receipts.size > 32) receipts.delete(receipts.keys().next().value);
    figma.ui.postMessage(response);
  };
})();
