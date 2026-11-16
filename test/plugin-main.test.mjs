import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('fixed plugin retains document identity and answers duplicate operations without redrawing', async () => {
  const messages = [], storage = new Map(); let calls = 0;
  const figma = { root: { name: 'Scratch', getPluginData: key => storage.get(key), setPluginData: (key, value) => storage.set(key, value) },
    showUI() {}, ui: { postMessage: value => messages.push(value) }, commitUndo() {} };
  const code = await readFile(new URL('../plugin/main.js', import.meta.url), 'utf8');
  const context = vm.createContext({ figma, __html__: '', FigmaLocalRuntime: { async execute() { calls++; return { id: '1:2' }; } } });
  vm.runInContext(code, context);
  await figma.ui.onmessage({ type: 'hello' });
  const documentId = messages[0].document.id;
  await figma.ui.onmessage({ type: 'execute', job: { id: 'same-operation', method: 'create', params: {} } });
  await figma.ui.onmessage({ type: 'execute', job: { id: 'same-operation', method: 'create', params: {} } });
  assert.equal(calls, 1); assert.equal(messages[1].ok, true); assert.equal(messages[2].result.id, '1:2');
  vm.runInContext(code, context);
  await figma.ui.onmessage({ type: 'hello' });
  assert.equal(messages.at(-1).document.id, documentId);
  assert.notEqual(messages.at(-1).sessionId, messages[0].sessionId);
});
