import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { serveMcp } from '../lib/mcp.mjs';

const request = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
async function exchange(chunks, client = {}, outputFactory) {
  const input = new PassThrough(); let captured = '';
  const output = outputFactory ? outputFactory(value => { captured += value; }) : new Writable({ write(chunk, encoding, done) { captured += chunk; done(); } });
  const running = serveMcp({ client, input, output });
  for (const chunk of chunks) input.write(chunk);
  input.end(); await running;
  return captured.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('negotiates supported versions, ignores notifications and lists safe tools', async () => {
  const responses = await exchange([
    request(1, 'initialize', { protocolVersion: '2024-11-05' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    request('new', 'initialize', { protocolVersion: '2099-01-01' }), request(0, 'ping'), request(3, 'tools/list')
  ]);
  assert.deepEqual(responses.map(r => r.id), [1, 'new', 0, 3]);
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[1].result.protocolVersion, '2025-06-18');
  assert.deepEqual(responses[2].result, {});
  assert.deepEqual(responses[3].result.tools.map(t => t.name), ['figma_sessions', 'figma_call', 'figma_operation', 'figma_ack']);
  assert.match(responses[3].result.tools[1].description, /never blindly replay/);
});

test('delegates explicit targets and retry IDs unchanged, with serialized async replies', async () => {
  const calls = []; const args = { sessionId: 's1', documentId: 'd1', method: 'create', params: { template: 'pill', name: '中文' }, operationId: 'same-id', out: '/tmp/a.svg', waitMs: 20 };
  const client = { sessions: async () => ({ sessions: [] }), call: async a => { calls.push(a); await new Promise(resolve => setImmediate(resolve)); return { id: a.operationId }; }, operation: async id => ({ id }), ack: async (id, note) => ({ id, note }) };
  const bytes = Buffer.from(request('call', 'tools/call', { name: 'figma_call', arguments: args }));
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  const responses = await exchange([
    bytes.subarray(0, split), bytes.subarray(split), request(2, 'tools/call', { name: 'figma_sessions' }),
    request(3, 'tools/call', { name: 'figma_operation', arguments: { operationId: 'same-id' } }),
    request(4, 'tools/call', { name: 'figma_ack', arguments: { operationId: 'same-id', note: 'Inspected affected nodes; plugin idle.' } })
  ], client, capture => new Writable({ write(chunk, encoding, done) { setImmediate(() => { capture(chunk.toString()); done(); }); } }));
  assert.deepEqual(calls, [args]); assert.deepEqual(responses.map(r => r.id), ['call', 2, 3, 4]);
  assert.deepEqual(JSON.parse(responses[3].result.content[0].text), { id: 'same-id', note: 'Inspected affected nodes; plugin idle.' });
});

test('rejects malformed requests and unsafe create retries without invoking the client', async () => {
  let invoked = false;
  const responses = await exchange(['{bad json}\n', '[1,2]\n', request({}, 'ping'), request('unknown', 'missing'), request(4, 'tools/call', { name: 'missing' }), request(5, 'tools/call', { name: 'figma_call', arguments: { sessionId: 's', documentId: 'd', method: 'create', params: {} } }), request(6, 'ping', [])], { call() { invoked = true; } });
  assert.equal(invoked, false);
  assert.deepEqual(responses.map(r => r.error.code), [-32700, -32600, -32600, -32601, -32602, -32602, -32602]);
  assert.deepEqual(responses.slice(0, 3).map(r => r.id), [null, null, null]);
  assert.match(responses[5].error.message, /operationId/);
});

test('reports client failures as tool errors and recovers after an oversized line', async () => {
  const responses = await exchange(['x'.repeat(1024 * 1024), 'x\n', request('error', 'tools/call', { name: 'figma_sessions' }), request(null, 'ping').trimEnd()], { sessions() { throw new Error('Bridge unavailable'); } });
  assert.equal(responses[0].error.code, -32600);
  assert.equal(responses[1].result.isError, true);
  assert.equal(responses[1].result.content[0].text, 'Bridge unavailable');
  assert.deepEqual(responses[2], { jsonrpc: '2.0', id: null, result: {} });
});
