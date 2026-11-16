import { StringDecoder } from 'node:string_decoder';

const methods = ['inspect', 'fonts', 'create', 'update', 'page.create', 'export', 'run'];
const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
const MAX_LINE_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const identifier = { type: 'string', minLength: 1 };
const tools = [
  { name: 'figma_sessions', description: 'List live local Figma plugin sessions. Inspect first, then keep explicit session, document and node IDs in subsequent calls. Check busy state before acting.', inputSchema: schema({}) },
  { name: 'figma_call', description: 'Call the shared Figma runtime. Inspect first and use explicit sessionId, documentId and affected node IDs; never infer a target from another document. Create requires operationId: reuse the same ID and unchanged payload for retries. Failed or unknown writes may be partial: inspect affected nodes and check the operation; never blindly replay. Advanced run executes native JavaScript inside Figma, not on the host, and is not a security sandbox. Export can save to an explicit local out path.', inputSchema: schema({ sessionId: identifier, documentId: identifier, method: { type: 'string', enum: methods }, params: { type: 'object', additionalProperties: true }, operationId: identifier, out: identifier, waitMs: { type: 'integer', minimum: 0 } }, ['sessionId', 'documentId', 'method', 'params']) },
  { name: 'figma_operation', description: 'Read an existing operation by its explicit ID. Unknown or failed writes must not be blindly replayed; inspect affected nodes using the original session/document IDs before deciding what happened.', inputSchema: schema({ operationId: identifier }) },
  { name: 'figma_ack', description: 'Acknowledge a reviewed failed or unknown write; this does not retry or undo it. Only acknowledge after inspecting the affected nodes in the explicit document and verifying the plugin is idle with figma_sessions. Include a concrete review note.', inputSchema: schema({ operationId: identifier, note: identifier }) }
];

function validateArguments(tool, args) {
  if (!object(args)) throw new Error('Tool arguments must be an object');
  const definition = tool.inputSchema;
  for (const key of Object.keys(args)) if (!Object.hasOwn(definition.properties, key)) throw new Error(`Unknown argument: ${key}`);
  for (const key of definition.required) if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = definition.properties[key];
    if (rule.type === 'string' && !nonempty(value)) throw new Error(`${key} must be a nonempty string`);
    if (rule.type === 'object' && !object(value)) throw new Error(`${key} must be an object`);
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${key} must be a nonnegative safe integer`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Unsupported ${key}: ${value}`);
  }
  if (tool.name === 'figma_call' && args.method === 'create' && !nonempty(args.operationId)) throw new Error('create requires an explicit operationId; reuse it for retries');
}

/** Newline-delimited MCP JSON-RPC; all writes are awaited to keep stdout protocol-only. */
export async function serveMcp({ client, input = process.stdin, output = process.stdout }) {
  const send = value => new Promise((resolve, reject) => output.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()));
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  async function handle(line) {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch { return error(null, -32700, 'Parse error'); }
    const hasId = object(request) && Object.hasOwn(request, 'id');
    const validId = hasId && (request.id === null || typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id)));
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (hasId && !validId)) return error(validId ? request.id : null, -32600, 'Invalid Request');
    if (!hasId) return; // Notifications, including initialized, never receive responses.
    const { id, method } = request;
    if (request.params !== undefined && !object(request.params)) return error(id, -32602, 'params must be an object');
    const params = request.params || {};
    let result;
    if (method === 'initialize') result = { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions.at(-1), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'figma-local', version: '0.1.0' } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools };
    else if (method === 'tools/call') {
      const tool = tools.find(tool => tool.name === params.name);
      if (!tool) return error(id, -32602, 'Unknown tool');
      const args = params.arguments === undefined ? {} : params.arguments;
      try { validateArguments(tool, args); } catch (failure) { return error(id, -32602, failure.message); }
      try {
        let value;
        if (tool.name === 'figma_sessions') value = await client.sessions();
        else if (tool.name === 'figma_call') value = await client.call(args);
        else if (tool.name === 'figma_operation') value = await client.operation(args.operationId);
        else value = await client.ack(args.operationId, args.note);
        result = { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
      } catch (failure) { result = { isError: true, content: [{ type: 'text', text: String(failure?.message || failure) }] }; }
    } else return error(id, -32601, 'Method not found');
    return send({ jsonrpc: '2.0', id, result });
  }
  const decoder = new StringDecoder('utf8');
  let pending = '', pendingBytes = 0, dropping = false;
  async function consume(chunk) {
    for (let start = 0; start < chunk.length;) {
      const end = chunk.indexOf('\n', start), hasNewline = end !== -1;
      const part = chunk.slice(start, hasNewline ? end : chunk.length);
      if (!dropping) {
        pendingBytes += Buffer.byteLength(part);
        if (pendingBytes > MAX_LINE_BYTES) { pending = ''; dropping = true; await error(null, -32600, 'Request exceeds 1 MiB limit'); }
        else pending += part;
      }
      if (hasNewline) { if (!dropping) await handle(pending); pending = ''; pendingBytes = 0; dropping = false; }
      start = hasNewline ? end + 1 : chunk.length;
    }
  }
  for await (const chunk of input) await consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  await consume(decoder.end());
  if (!dropping && pending.trim()) await handle(pending);
}
