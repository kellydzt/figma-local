import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../lib/client.mjs';

test('client saves exported bytes without returning base64 and refuses unrelated overwrite', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'figma-local-client-'));
  let submitted;
  const data = Buffer.from('<svg/>').toString('base64');
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test');
    if (req.method === 'POST') { let body = ''; for await (const c of req) body += c; submitted = JSON.parse(body); }
    const result = { id: submitted?.operationId || 'export-1', method: 'export', status: 'completed',
      result: { format: 'SVG', mime: 'image/svg+xml', width: 100, height: 40, ...(req.url.includes('result=1') ? { data } : {}) } };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const client = createClient({ port: server.address().port, token: 'test', exportDir: dir });
  const output = await client.call({ sessionId: 's', documentId: 'd', method: 'export', params: { nodeId: '1:2' }, operationId: 'export-1' });
  assert.equal(submitted.documentId, 'd'); assert.equal(output.result.data, undefined);
  assert.equal(await readFile(output.result.path, 'utf8'), '<svg/>');
  await client.operation('export-1');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(output.result.path, 'user content');
  await assert.rejects(client.operation('export-1'), /already exists/);
  assert.equal(await readFile(output.result.path, 'utf8'), 'user content');
});
