import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startBridge } from '../lib/bridge.mjs';

const TOKEN = 'test-pairing-token-long-enough';
async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'figma-local-test-'));
  let bridge = await startBridge({ port: 0, token: TOKEN, stateDir, pollMs: 15, jobTimeoutMs: 5000, sessionTtlMs: 5000, ...options });
  const sessionId = randomUUID(), documentId = randomUUID();
  t.after(async () => { await bridge.close(); await rm(stateDir, { recursive: true, force: true }); });
  async function request(route, data, { headers = {}, raw, method } = {}) {
    if (headers.Host) return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: bridge.port, path: route, headers: { Authorization: 'Bearer ' + TOKEN, ...headers } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
      });
      req.on('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${bridge.port}${route}`, {
      method: method ?? (data === undefined && raw === undefined ? 'GET' : 'POST'),
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...headers },
      body: raw ?? (data === undefined ? undefined : JSON.stringify(data)),
    });
    return { status: response.status, value: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  const connect = (sid = sessionId, doc = documentId) => request('/v1/connect', { sessionId: sid, document: { id: doc, name: 'Test document' } });
  const submit = (method = 'create', params = {}, extras = {}) => request('/v1/operations', { sessionId, documentId, operationId: randomUUID(), method, params, ...extras });
  const poll = (sid = sessionId) => request('/v1/poll', { sessionId: sid });
  const result = (id, ok = true, value = { done: true }, sid = sessionId) => request('/v1/result', { sessionId: sid, operationId: id, ok, ...(ok ? { result: value } : { error: value }) });
  return { stateDir, request, connect, submit, poll, result, sessionId, documentId,
    async restart() { await bridge.close(); bridge = await startBridge({ port: 0, token: TOKEN, stateDir, pollMs: 15, jobTimeoutMs: 5000, sessionTtlMs: 5000, ...options }); },
  };
}
async function eventually(read, predicate) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail('Condition did not become true within 2.5 seconds');
}

test('loopback security, input validation and bounded JSON', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/health', undefined, { headers: { Authorization: '' } })).status, 200);
  assert.equal((await f.request('/v1/sessions', undefined, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.request('/v1/sessions', undefined, { headers: { Host: 'attacker.test' } })).status, 403);
  assert.equal((await f.request('/v1/sessions', undefined, { headers: { Origin: 'https://figma.com.evil.test' } })).status, 403);
  assert.equal((await f.request('/v1/sessions', undefined, { headers: { Origin: 'null' } })).headers.get('access-control-allow-origin'), 'null');
  const preflight = await f.request('/v1/connect', undefined, { method: 'OPTIONS', headers: { Origin: 'null', Authorization: '', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  assert.equal((await f.request('/v1/connect', {}, { raw: '{invalid' })).status, 400);
  assert.equal((await f.request('/v1/connect', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.connect()).status, 200);
  assert.equal((await f.submit('delete-everything')).status, 400);
  assert.equal((await f.submit('create', {}, { operationId: '../../escape' })).status, 400);
  assert.equal((await f.submit('create', [])).status, 400);
  assert.equal((await f.submit('create', {}, { sessionId: undefined })).status, 400);
  const oversized = '{"data":"' + 'x'.repeat(12 * 1024 * 1024) + '"}';
  assert.equal((await f.request('/v1/operations', {}, { raw: oversized })).status, 413);
  assert.equal((await readdir(f.stateDir)).filter(name => name.endsWith('.json')).length, 0);
  await assert.rejects(startBridge({ token: TOKEN, host: '0.0.0.0' }), /loopback/);
});

test('writes serialize per document and IDs identify content independently of session', async t => {
  const f = await fixture(t);
  await f.connect();
  assert.equal((await f.connect(randomUUID())).status, 409);
  assert.equal((await f.connect()).status, 200);
  const first = (await f.submit('create', { b: 2, a: 1 })).value;
  const second = (await f.submit()).value;
  assert.equal((await f.poll()).value.job.id, first.id);
  assert.equal((await f.poll()).value.job, null);
  assert.equal((await f.result(first.id)).status, 200);
  assert.equal((await f.poll()).value.job.id, second.id);
  const same = await f.submit('create', { a: 1, b: 2 }, { operationId: first.id, sessionId: randomUUID() });
  assert.equal(same.status, 200);
  assert.equal(same.value.status, 'completed');
  assert.equal((await f.submit('create', { a: 9 }, { operationId: first.id })).status, 409);
  assert.equal((await f.submit('create', { a: 1, b: 2 }, { operationId: first.id, documentId: randomUUID() })).status, 409);
  const saved = JSON.parse(await readFile(path.join(f.stateDir, first.id + '.json'), 'utf8'));
  assert.equal(saved.status, 'completed');
  assert.ok(saved.startedAt);
});

test('failed writes require explicit review but permit inspection', async t => {
  const f = await fixture(t);
  await f.connect();
  const write = (await f.submit()).value;
  await f.poll();
  await f.result(write.id, false, { message: 'Some nodes were created before failure.' });
  assert.equal((await f.submit()).status, 409);
  const read = (await f.submit('inspect')).value;
  assert.equal((await f.poll()).value.job.id, read.id);
  await f.result(read.id);
  assert.equal((await f.request(`/v1/operations/${write.id}/ack`, { note: ' ' })).status, 400);
  const ack = await f.request(`/v1/operations/${write.id}/ack`, { note: 'Inspected the canvas and removed the partial node.' });
  assert.equal(ack.value.requiresReview, false);
  assert.ok(ack.value.acknowledgedAt);
  assert.equal((await f.submit()).status, 202);
});

test('timeouts remain active and late results reconcile only their own job', async t => {
  const f = await fixture(t, { jobTimeoutMs: 35 });
  await f.connect();
  const write = (await f.submit()).value;
  await f.poll();
  await eventually(() => f.request(`/v1/operations/${write.id}`), response => response.value.status === 'unknown');
  assert.equal((await f.request('/v1/sessions')).value.sessions[0].busy, true);
  assert.equal((await f.request(`/v1/operations/${write.id}/ack`, { note: 'Checked' })).status, 409);
  assert.equal((await f.submit()).status, 409);
  const inspect = (await f.submit('inspect')).value;
  assert.equal((await f.poll()).value.job, null);
  assert.equal((await f.result(write.id)).value.status, 'completed');
  assert.equal((await f.result(write.id)).status, 200);
  assert.equal((await f.result(write.id, false, { message: 'Different outcome' })).status, 409);
  assert.equal((await f.poll()).value.job.id, inspect.id);
  assert.equal((await f.request('/v1/sessions')).value.sessions[0].uncertainOperations.length, 0);
});

test('disconnect quarantines queued work, preserves barriers on reconnect and accepts late results', async t => {
  const f = await fixture(t, { sessionTtlMs: 75 });
  await f.connect();
  const first = (await f.submit()).value;
  const queued = (await f.submit()).value;
  await f.poll();
  await eventually(() => f.request('/v1/sessions'), response => response.value.sessions.length === 0);
  assert.equal((await f.request(`/v1/operations/${queued.id}`)).value.status, 'unknown');
  assert.equal((await f.poll()).status, 404);
  const sid = randomUUID();
  const connected = await f.connect(sid);
  assert.deepEqual(new Set(connected.value.uncertainOperations), new Set([first.id, queued.id]));
  assert.equal((await f.poll(sid)).value.job, null);
  assert.equal((await f.submit('create', {}, { sessionId: sid })).status, 409);
  assert.equal((await f.result(queued.id)).status, 409);
  assert.equal((await f.result(first.id)).value.status, 'completed');
  await f.request(`/v1/operations/${queued.id}/ack`, { note: 'Reviewed after reconnect.' });
  const newer = (await f.submit('create', {}, { sessionId: sid })).value;
  assert.equal((await f.poll(sid)).value.job.id, newer.id);
  await f.result(first.id);
  assert.equal((await f.request('/v1/sessions')).value.sessions[0].busy, true);
});

test('restart marks all unfinished work unknown and never replays writes', async t => {
  const f = await fixture(t);
  await f.connect();
  const running = (await f.submit()).value;
  const queued = (await f.submit()).value;
  await f.poll();
  await f.restart();
  const original = await f.submit('create', {}, { operationId: running.id, sessionId: randomUUID() });
  assert.equal(original.status, 200);
  assert.equal(original.value.status, 'unknown');
  assert.equal((await f.request(`/v1/operations/${queued.id}`)).value.status, 'unknown');
  const sid = randomUUID();
  await f.connect(sid);
  assert.equal((await f.poll(sid)).value.job, null);
  assert.equal((await f.submit('create', {}, { sessionId: sid })).status, 409);
  const read = (await f.submit('inspect', {}, { sessionId: sid })).value;
  assert.equal((await f.poll(sid)).value.job.id, read.id);
  await f.result(read.id, true, {}, sid);
  await f.result(running.id);
  const sessions = (await f.request('/v1/sessions')).value.sessions;
  assert.deepEqual(sessions[0].uncertainOperations, [queued.id]);
});

test('export bytes require explicit result retrieval', async t => {
  const f = await fixture(t);
  await f.connect();
  const operation = (await f.submit('export', { nodeId: '1:2' })).value;
  await f.poll();
  const bytes = Buffer.from('test svg').toString('base64');
  await f.result(operation.id, true, { data: bytes, mime: 'image/svg+xml', format: 'SVG' });
  const status = (await f.request(`/v1/operations/${operation.id}`)).value;
  assert.equal(status.result.data, undefined);
  assert.equal(status.result.mime, 'image/svg+xml');
  assert.equal(status.resultOmitted, true);
  const full = (await f.request(`/v1/operations/${operation.id}?result=1`)).value;
  assert.equal(full.result.data, bytes);
});

test('storage failure prevents dispatch and preserves the last durable record', async t => {
  const f = await fixture(t);
  await f.connect();
  const operation = (await f.submit()).value;
  const backup = f.stateDir + '-backup';
  await rename(f.stateDir, backup);
  await writeFile(f.stateDir, 'make the state directory unwritable as a directory');
  t.after(async () => { await rm(backup, { recursive: true, force: true }); });
  const poll = await f.poll();
  assert.equal(poll.status, 503);
  assert.equal((await f.request(`/v1/operations/${operation.id}`)).value.status, 'queued');
  assert.equal((await f.submit()).status, 503);
  const durable = JSON.parse(await readFile(path.join(backup, operation.id + '.json'), 'utf8'));
  assert.equal(durable.status, 'queued');
});

test('another process cannot rewrite the live operation store during startup', async t => {
  const f = await fixture(t);
  await f.connect();
  const operation = (await f.submit()).value;
  await f.poll();
  const before = await readFile(path.join(f.stateDir, operation.id + '.json'), 'utf8');
  await assert.rejects(startBridge({ token: TOKEN, port: 0, stateDir: f.stateDir }), /already owned/);
  assert.equal(await readFile(path.join(f.stateDir, operation.id + '.json'), 'utf8'), before);
  assert.equal((await f.result(operation.id)).value.status, 'completed');
});

test('stale owner locks recover and failed startup releases its lock', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'figma-local-lock-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  await writeFile(path.join(stateDir, '.bridge.lock'), JSON.stringify({ pid: exited.pid, nonce: randomUUID() }));
  const corrupt = path.join(stateDir, randomUUID() + '.json');
  await writeFile(corrupt, '{broken');
  await assert.rejects(startBridge({ token: TOKEN, port: 0, stateDir }), SyntaxError);
  assert.equal((await readdir(stateDir)).includes('.bridge.lock'), false);
  await rm(corrupt);
  const bridge = await startBridge({ token: TOKEN, port: 0, stateDir });
  await bridge.close();
  assert.equal((await readdir(stateDir)).includes('.bridge.lock'), false);
});
