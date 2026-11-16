import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { projectDir } from './setup.mjs';

export function createClient({ port, token, exportDir = join(projectDir, 'exports') }) {
  const base = `http://127.0.0.1:${port}`;
  async function request(path, body) {
    let response;
    try {
      response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    } catch (error) {
      throw new Error(`Local service unavailable (${error.message}). Run npm start. If a write was submitted, query its operation ID before retrying.`);
    }
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || `HTTP ${response.status}`);
    return result;
  }
  async function materialize(record, out) {
    if (record.method !== 'export' || record.status !== 'completed') return record;
    const full = record.result?.data ? record : await request(`/v1/operations/${encodeURIComponent(record.id)}?result=1`);
    if (typeof full.result?.data !== 'string') throw new Error('Export completed without image bytes. Inspect the operation.');
    const { data, ...metadata } = full.result;
    const extension = metadata.format === 'SVG' ? 'svg' : 'png';
    const path = resolve(out || join(exportDir, `${record.id}.${extension}`));
    await mkdir(dirname(path), { recursive: true });
    // Avoid silently replacing an existing user file. Identical repeat exports are okay.
    const bytes = Buffer.from(data, 'base64');
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const { readFile } = await import('node:fs/promises');
      if (!(await readFile(path)).equals(bytes)) throw new Error(`Export destination already exists: ${path}`);
    }
    return { ...full, result: { ...metadata, path, bytes: bytes.length }, resultOmitted: undefined };
  }
  return {
    sessions: () => request('/v1/sessions'),
    operation: async id => materialize(await request(`/v1/operations/${encodeURIComponent(id)}`)),
    ack: (id, note) => request(`/v1/operations/${encodeURIComponent(id)}/ack`, { note }),
    async call({ sessionId, documentId, method, params = {}, operationId = randomUUID(), out, waitMs = 30000 }) {
      if (!sessionId || !documentId) throw new Error('Explicit --session and --document are required; run sessions first.');
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('waitMs must be between 0 and 60000.');
      let record;
      try { record = await request('/v1/operations', { sessionId, documentId, method, params, operationId }); }
      catch (error) { throw new Error(`${error.message} Operation ID: ${operationId}`); }
      const deadline = Date.now() + waitMs;
      while (['queued', 'running'].includes(record.status) && Date.now() < deadline) {
        await delay(Math.min(250, Math.max(1, deadline - Date.now())));
        try { record = await request(`/v1/operations/${encodeURIComponent(operationId)}`); }
        catch (error) { throw new Error(`${error.message} Operation ID: ${operationId}`); }
      }
      try { return await materialize(record, out); }
      catch (error) { throw new Error(`${error.message} Operation ID: ${operationId}`); }
    },
  };
}
