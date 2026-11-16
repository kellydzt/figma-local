#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setup, readConfig, localDir } from './lib/setup.mjs';
import { createClient } from './lib/client.mjs';

const help = `Figma Local · Node 22+, no dependencies

  node cli.mjs setup [--port 38474]   Generate the paired development plugin
  node cli.mjs start                 Run the local bridge (keep terminal open)
  node cli.mjs sessions              List connected files and their IDs
  node cli.mjs call METHOD FILE      Execute params from a JSON file (or - for stdin)
      --session ID --document ID     Explicit target from sessions
      [--id OPERATION_ID]            Reuse this ID when recovering the SAME request
      [--out FILE] [--wait 30000]    Export path; wait 0–60000ms
  node cli.mjs operation ID          Query a submitted operation
  node cli.mjs ack ID "review note"  Acknowledge an inspected failed/unknown write
  node cli.mjs mcp                   Serve optional MCP on stdio (bridge must run)

Methods: inspect, fonts, create, update, page.create, export, run.
Examples and limitations: README.md. setup never edits Codex configuration.
`;
function parse(argv) {
  const positional = [], options = {};
  const allowed = new Set(['port', 'session', 'document', 'id', 'out', 'wait']);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (!allowed.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`);
    options[key] = argv[++i];
  }
  return { positional, options };
}
async function input(path) {
  if (path !== '-') return readFile(resolve(path), 'utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 2 * 1024 * 1024) throw new Error('Input exceeds 2 MiB.');
  }
  return value;
}
async function main() {
  if (process.argv.length === 2 || ['--help', '-h', 'help'].includes(process.argv[2])) { process.stdout.write(help); return; }
  const { positional: [command, first, second], options } = parse(process.argv.slice(2));
  const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (command === 'setup') { print(await setup({ port: options.port === undefined ? undefined : Number(options.port) })); return; }
  const config = await readConfig();
  if (command === 'start') {
    const { startBridge } = await import('./lib/bridge.mjs');
    const bridge = await startBridge({ ...config, stateDir: join(localDir, 'operations') });
    process.stderr.write(`Figma Local listening on http://127.0.0.1:${bridge.port}\nRun Figma Local in the target Figma file. Ctrl+C stops the bridge.\n`);
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await bridge.close(); process.exit(0); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    return;
  }
  const client = createClient(config);
  if (command === 'mcp') {
    const { serveMcp } = await import('./lib/mcp.mjs');
    await serveMcp({ client }); return;
  }
  if (command === 'sessions') { print(await client.sessions()); return; }
  if (command === 'operation' && first) { print(await client.operation(first)); return; }
  if (command === 'ack' && first && second) { print(await client.ack(first, second)); return; }
  if (command === 'call' && first && second) {
    const record = await client.call({ sessionId: options.session, documentId: options.document,
      method: first, params: JSON.parse(await input(second)), operationId: options.id,
      out: options.out, waitMs: options.wait === undefined ? undefined : Number(options.wait) });
    print(record);
    if (['failed', 'unknown'].includes(record.status)) process.exitCode = 2;
    return;
  }
  throw new Error('Unknown or incomplete command. Run node cli.mjs --help.');
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
