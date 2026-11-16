import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 12 * 1024 * 1024;
const METHODS = new Set(['inspect', 'fonts', 'export', 'create', 'update', 'page.create', 'run']);
const READS = new Set(['inspect', 'fonts', 'export']);
const STATES = new Set(['queued', 'running', 'completed', 'failed', 'unknown']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const validId = value => typeof value === 'string' && SAFE_ID.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const validMessage = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
const fail = (status, message, code = 'invalid_request') => Object.assign(new Error(message), { status, code });
const isWrite = op => !READS.has(op.method);
const stamp = () => new Date().toISOString();

function canonical(value, depth = 0) {
  if (depth > 64) throw fail(400, 'JSON nesting exceeds 64 levels.');
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}

function recordView(op, includeResult = false) {
  if (op.method !== 'export' || includeResult || !plain(op.result) || !('data' in op.result)) return op;
  const { data, ...metadata } = op.result;
  return { ...op, result: metadata, resultOmitted: true };
}

function permittedOrigin(origin) {
  if (origin === undefined || origin === 'null') return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && ((url.protocol === 'https:' && (url.hostname === 'figma.com' || url.hostname.endsWith('.figma.com')))
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Content-Type must be application/json.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > LIMIT) { req.resume(); throw fail(413, 'JSON body exceeds 12 MiB.'); }
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Malformed JSON.'); }
  if (!plain(parsed)) throw fail(400, 'Request body must be a JSON object.');
  canonical(parsed);
  return parsed;
}

async function directoryLock(stateDir) {
  const filename = path.join(stateDir, '.bridge.lock');
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await writeFile(filename, owner, { flag: 'wx', mode: 0o600 });
      return async () => { if (await readFile(filename, 'utf8').catch(() => '') === owner) await unlink(filename); };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let previous;
    try { previous = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let old;
    try { old = JSON.parse(previous); } catch { throw new Error('Bridge state is locked; lock ownership is incomplete. Retry after the other startup finishes.'); }
    if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || !validId(old.nonce)) throw new Error('Invalid bridge state lock; inspect .bridge.lock before restarting.');
    try { process.kill(old.pid, 0); throw new Error(`Bridge state is already owned by process ${old.pid}.`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    // A permanent per-generation marker ensures two stale-lock recoverers cannot unlink a new owner's lock.
    try { await writeFile(path.join(stateDir, '.bridge.reaped-' + old.nonce), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await readFile(filename, 'utf8').catch(() => '') !== previous) continue;
      throw new Error('Stale bridge lock recovery is in progress or was interrupted; inspect .bridge.lock before restarting.');
    }
    if (await readFile(filename, 'utf8').catch(() => '') === previous) await unlink(filename);
  }
  throw new Error('Could not acquire bridge state lock.');
}

/** Start a paired loopback bridge. Importing this module has no side effects. */
export async function startBridge({ port = 38474, token, stateDir = path.resolve('.local/operations'), host = '127.0.0.1', pollMs = 20000, jobTimeoutMs = 60000, sessionTtlMs = 65000 } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Bridge must bind a loopback IP address.');
  if (typeof token !== 'string' || token.length < 16 || token.length > 512 || /\s/.test(token)) throw new Error('A pairing token of 16–512 non-whitespace characters is required.');
  for (const value of [pollMs, jobTimeoutMs, sessionTtlMs]) if (!Number.isFinite(value) || value < 1) throw new Error('Timeouts must be positive milliseconds.');
  const operations = new Map(), sessions = new Map(), active = new Map();
  let serial = Promise.resolve(), storageFault, closing = false, closePromise;
  const locked = fn => { const next = serial.then(fn); serial = next.catch(() => {}); return next; };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const releaseLock = await directoryLock(stateDir);
  try {

  async function save(op) {
    const file = path.join(stateDir, op.id + '.json');
    const temporary = file + '.' + randomUUID() + '.tmp';
    const serialized = JSON.stringify(op);
    if (Buffer.byteLength(serialized) > LIMIT + 4096) throw fail(413, 'Combined operation parameters and result exceed the 12 MiB storage budget.');
    try {
      await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      storageFault = error;
      await unlink(temporary).catch(() => {});
      throw fail(503, 'Operation storage failed; restart the bridge after fixing storage. No further jobs will be dispatched.', 'storage_failure');
    }
    operations.set(op.id, op);
    return op;
  }

  for (const filename of (await readdir(stateDir)).filter(file => file.endsWith('.json')).sort()) {
    const raw = await readFile(path.join(stateDir, filename));
    if (raw.length > LIMIT + 4096) throw new Error('Oversized operation record: ' + filename);
    const op = JSON.parse(raw);
    if (!plain(op) || !validId(op.id) || filename !== op.id + '.json' || !METHODS.has(op.method) || !STATES.has(op.status)
      || !validText(op.documentId) || !validId(op.sessionId) || !plain(op.params) || !validText(op.createdAt) || !validText(op.updatedAt)) throw new Error('Invalid operation record: ' + filename);
    canonical(op);
    if (op.status === 'queued' || op.status === 'running') {
      await save({ ...op, status: 'unknown', updatedAt: stamp(), requiresReview: isWrite(op), error: { message: 'Bridge restarted before completion. This operation will not be replayed.' } });
    } else operations.set(op.id, op);
  }

  const reviewIds = documentId => [...operations.values()].filter(op => op.documentId === documentId && op.requiresReview && !op.acknowledgedAt).map(op => op.id);
  const healthy = () => { if (storageFault) throw fail(503, 'Operation storage failed; restart after fixing storage.', 'storage_failure'); };
  const live = sessionId => {
    const session = sessions.get(sessionId);
    if (!session || Date.now() - session.lastSeen >= sessionTtlMs) throw fail(404, 'Session is not live. Select a connected document.', 'session_unavailable');
    return session;
  };
  function reply(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  function finishPoll(session, value = { job: null }) {
    const pending = session.poll;
    if (!pending) return;
    session.poll = undefined;
    clearTimeout(pending.timer);
    reply(pending.res, 200, value);
  }

  async function expire() {
    for (const [sessionId, session] of sessions) {
      if (Date.now() - session.lastSeen < sessionTtlMs) continue;
      sessions.delete(sessionId);
      finishPoll(session);
      for (const op of operations.values()) {
        if (op.sessionId !== sessionId || !['queued', 'running'].includes(op.status) && active.get(op.documentId) !== op.id) continue;
        await save({ ...op, status: 'unknown', updatedAt: stamp(), requiresReview: isWrite(op), error: { message: 'Plugin session disconnected before completion. This operation will not be replayed.' } });
        if (active.get(op.documentId) === op.id) active.delete(op.documentId);
      }
    }
  }

  async function dispatch(session) {
    healthy();
    if (!session.poll || session.poll.res.destroyed || sessions.get(session.sessionId) !== session || Date.now() - session.lastSeen >= sessionTtlMs || active.has(session.document.id)) return;
    const uncertain = reviewIds(session.document.id).length > 0;
    const op = [...operations.values()].find(item => item.sessionId === session.sessionId && item.documentId === session.document.id && item.status === 'queued' && (!uncertain || !isWrite(item)));
    if (!op) return;
    clearTimeout(session.poll.timer);
    const next = await save({ ...op, status: 'running', startedAt: stamp(), updatedAt: stamp() });
    if (!session.poll || session.poll.res.destroyed || Date.now() - session.lastSeen >= sessionTtlMs) {
      await save({ ...next, status: 'unknown', requiresReview: isWrite(next), updatedAt: stamp(), error: { message: 'Plugin poll ended before dispatch was confirmed. This operation will not be replayed.' } });
      finishPoll(session);
      return;
    }
    active.set(op.documentId, op.id);
    finishPoll(session, { job: { id: next.id, method: next.method, params: next.params } });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address()?.port;
      const acceptedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
      if (!acceptedHosts.has(req.headers.host?.toLowerCase())) throw fail(403, 'Host is not this loopback bridge.', 'forbidden_host');
      if (!permittedOrigin(req.headers.origin)) throw fail(403, 'Origin is not allowed.', 'forbidden_origin');
      if (req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
      }
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { name: 'figma-local', version: '0.1.0' });
      if (!url.pathname.startsWith('/v1/')) throw fail(404, 'Route not found.', 'not_found');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
      const supplied = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from('Bearer ' + token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail(401, 'Valid pairing token required.', 'unauthorized');
      if (closing) throw fail(503, 'Bridge is closing.');
      const data = req.method === 'POST' ? await body(req) : undefined;
      await locked(async () => {
        const match = url.pathname.match(/^\/v1\/operations\/([A-Za-z0-9_-]+)(\/ack)?$/);
        // Deduplication and status reads remain available if the original session has died.
        if (req.method === 'GET' && match && !match[2]) {
          const op = operations.get(match[1]);
          if (!op) throw fail(404, 'Operation not found.', 'not_found');
          return reply(res, 200, recordView(op, url.searchParams.get('result') === '1'));
        }
        if (req.method === 'POST' && url.pathname === '/v1/operations') {
          if ((data.operationId !== undefined && !validId(data.operationId)) || !validId(data.sessionId) || !validText(data.documentId) || !METHODS.has(data.method) || !plain(data.params)) throw fail(400, 'Invalid operation ID, session, document, method or params.');
          const existing = data.operationId && operations.get(data.operationId);
          if (existing) {
            if (existing.documentId !== data.documentId || existing.method !== data.method || canonical(existing.params) !== canonical(data.params)) throw fail(409, 'Operation ID already has different content.', 'id_conflict');
            return reply(res, 200, recordView(existing));
          }
        }
        healthy();
        await expire();
        if (req.method === 'GET' && url.pathname === '/v1/sessions') {
          return reply(res, 200, { sessions: [...sessions.values()].map(session => ({ sessionId: session.sessionId, document: session.document, lastSeen: new Date(session.lastSeen).toISOString(), busy: active.has(session.document.id), uncertainOperations: reviewIds(session.document.id) })) });
        }
        if (req.method === 'POST' && url.pathname === '/v1/connect') {
          const doc = data.document;
          if (!validId(data.sessionId) || !plain(doc) || !validText(doc.id) || !validText(doc.name, 1024) || (doc.fileKey !== undefined && !validText(doc.fileKey))) throw fail(400, 'Invalid session or document identity.');
          const existing = sessions.get(data.sessionId);
          if (existing && (existing.document.id !== doc.id || existing.document.fileKey !== doc.fileKey)) throw fail(409, 'Session already identifies a different document.', 'session_conflict');
          if ([...sessions.values()].some(item => item.sessionId !== data.sessionId && item.document.id === doc.id)) throw fail(409, 'Document already has a live plugin session.', 'document_conflict');
          const session = existing || { sessionId: data.sessionId };
          session.document = { id: doc.id, name: doc.name, ...(doc.fileKey === undefined ? {} : { fileKey: doc.fileKey }) };
          session.lastSeen = Date.now();
          sessions.set(data.sessionId, session);
          return reply(res, 200, { sessionId: data.sessionId, document: session.document, uncertainOperations: reviewIds(doc.id) });
        }
        if (req.method === 'POST' && url.pathname === '/v1/poll') {
          if (!validId(data.sessionId)) throw fail(400, 'Invalid session ID.');
          const session = live(data.sessionId);
          if (session.poll) throw fail(409, 'A poll is already pending for this session.', 'poll_conflict');
          session.lastSeen = Date.now();
          const pending = { res, timer: setTimeout(() => finishPoll(session), pollMs) };
          pending.timer.unref();
          session.poll = pending;
          res.on('close', () => { if (session.poll === pending) { clearTimeout(pending.timer); session.poll = undefined; } });
          await dispatch(session);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/v1/operations') {
          const session = live(data.sessionId);
          if (session.document.id !== data.documentId) throw fail(409, 'Session does not identify the selected document.', 'document_conflict');
          if (!READS.has(data.method) && reviewIds(data.documentId).length) throw fail(409, 'Review and acknowledge uncertain writes in this document before submitting another write.', 'review_required');
          const now = stamp();
          const op = await save({ id: data.operationId || randomUUID(), sessionId: data.sessionId, documentId: data.documentId, method: data.method, params: data.params, status: 'queued', createdAt: now, updatedAt: now });
          await dispatch(session);
          return reply(res, 202, recordView(operations.get(op.id)));
        }
        if (req.method === 'POST' && url.pathname === '/v1/result') {
          if (!validId(data.sessionId) || !validId(data.operationId) || typeof data.ok !== 'boolean' || (!data.ok && (!plain(data.error) || !validMessage(data.error.message, 16384)))) throw fail(400, 'Invalid operation result.');
          const op = operations.get(data.operationId);
          if (!op || op.sessionId !== data.sessionId || !op.startedAt) throw fail(409, 'Result does not match an issued operation.', 'result_conflict');
          if (['completed', 'failed'].includes(op.status)) {
            if ((op.status === 'completed') !== data.ok || canonical(data.ok ? op.result : op.error) !== canonical(data.ok ? data.result ?? null : data.error)) throw fail(409, 'Operation already has a different result.', 'result_conflict');
            return reply(res, 200, recordView(op));
          }
          const next = { ...op, status: data.ok ? 'completed' : 'failed', updatedAt: stamp(), requiresReview: !data.ok && isWrite(op) };
          delete next.error;
          if (data.ok) next.result = data.result ?? null;
          else next.error = data.error;
          await save(next);
          if (active.get(op.documentId) === op.id) active.delete(op.documentId);
          const session = sessions.get(op.sessionId);
          if (session) { session.lastSeen = Date.now(); await dispatch(session); }
          return reply(res, 200, recordView(next));
        }
        if (req.method === 'POST' && match?.[2]) {
          const op = operations.get(match[1]);
          if (!op) throw fail(404, 'Operation not found.', 'not_found');
          if (!validMessage(data.note, 4096)) throw fail(400, 'A non-empty review note is required.');
          if (!isWrite(op) || !['failed', 'unknown'].includes(op.status) || active.get(op.documentId) === op.id) throw fail(409, 'Only inactive failed or unknown writes can be acknowledged.', 'ack_conflict');
          if (op.acknowledgedAt) return reply(res, 200, recordView(op));
          const next = await save({ ...op, requiresReview: false, acknowledgedAt: stamp(), acknowledgement: data.note, updatedAt: stamp() });
          for (const session of sessions.values()) if (session.document.id === op.documentId) await dispatch(session);
          return reply(res, 200, recordView(next));
        }
        throw fail(404, 'Route not found.', 'not_found');
      });
    } catch (error) {
      reply(res, error.status || 500, { error: { message: error.status ? error.message : 'Internal bridge error.', code: error.code || 'internal_error' } });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const timer = setInterval(() => locked(async () => {
    if (closing || storageFault) return;
    await expire();
    for (const id of active.values()) {
      const op = operations.get(id);
      if (op.status === 'running' && Date.now() - Date.parse(op.startedAt) >= jobTimeoutMs) await save({ ...op, status: 'unknown', updatedAt: stamp(), requiresReview: isWrite(op), error: { message: 'Execution timed out. It may still be running; do not retry.' } });
    }
  }).catch(() => {}), Math.max(5, Math.min(1000, sessionTtlMs / 3, jobTimeoutMs / 3)));
  timer.unref();
  return {
    server, port: server.address().port,
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(timer);
        await locked(async () => { for (const session of sessions.values()) finishPoll(session); });
        try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { await releaseLock(); }
      })();
      return closePromise;
    },
  };
  } catch (error) { await releaseLock(); throw error; }
}
