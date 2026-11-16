import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export const localDir = join(projectDir, '.local');
export async function privateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, value, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
export async function readConfig(directory = localDir) {
  let config;
  try { config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Run node cli.mjs setup first.');
    throw error;
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid local config; restore .local/config.json.');
  return config;
}
export async function setup({ directory = localDir, port } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let config;
  try { config = await readConfig(directory); }
  catch (error) {
    if (error.message !== 'Run node cli.mjs setup first.') throw error;
    config = { port: 38474, token: randomBytes(32).toString('hex') };
  }
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024–65535.');
    config.port = port;
  }
  await privateWrite(join(directory, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  const [runtime, main, ui] = await Promise.all(['runtime.js', 'main.js', 'ui.html'].map(name =>
    readFile(join(projectDir, 'plugin', name), 'utf8')));
  const folder = join(directory, 'plugin');
  await privateWrite(join(folder, 'code.js'), runtime + '\n' + main);
  await privateWrite(join(folder, 'ui.html'), ui.replace('__LOCAL_CONFIG__', JSON.stringify({
    base: `http://localhost:${config.port}`, token: config.token,
  })));
  const manifest = {
    name: 'Figma Local', id: 'figma-local-development-v1', api: '1.0.0',
    main: 'code.js', ui: 'ui.html', editorType: ['figma'], documentAccess: 'dynamic-page',
    networkAccess: { allowedDomains: ['none'], devAllowedDomains: [`http://localhost:${config.port}`] },
  };
  const path = join(folder, 'manifest.json');
  await privateWrite(path, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest: path, port: config.port, command: `node ${join(projectDir, 'cli.mjs')} start` };
}
