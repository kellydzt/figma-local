import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../plugin/runtime.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const execute = context.FigmaLocalRuntime.execute;
const copy = value => JSON.parse(JSON.stringify(value));
const pngHeader = (width, height) => {
  const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); return bytes;
};

// Minimal native API double: deliberately no layout engine or rendered-pixel claims.
function mockFigma() {
  const nodes = new Map(), events = [];
  let nextId = 0;
  function make(type, name = type) {
    const node = { id: String(++nextId), type, name, removed: false };
    nodes.set(node.id, node);
    if (!['PAGE', 'DOCUMENT'].includes(type)) Object.assign(node, {
      x: 0, y: 0, width: 100, height: 100, visible: true, opacity: 1, fills: [], strokes: [], effects: [],
      resize(w, h) { this.width = w; this.height = h; },
      async exportAsync(settings) { events.push(['export', settings]); return pngHeader(2500, 2500); }
    });
    if (['PAGE', 'DOCUMENT', 'FRAME', 'COMPONENT'].includes(type)) Object.assign(node, {
      children: [], appendChild(child) {
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
        this.children.push(child); child.parent = this;
      }
    });
    if (['FRAME', 'COMPONENT'].includes(type)) Object.assign(node, {
      cornerRadius: 0, clipsContent: false, layoutMode: 'NONE', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED',
      primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN', itemSpacing: 0,
      paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      addComponentProperty(name) { return name + '#property'; }
    });
    if (type === 'TEXT') Object.assign(node, {
      fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, lineHeight: { unit: 'AUTO' },
      characters: '', textAutoResize: 'NONE', textTruncation: 'DISABLED',
      getRangeAllFontNames() { return [{ family: 'Geist', style: 'Regular' }, { family: 'Geist', style: 'Medium' }]; }
    });
    if (type === 'PAGE') Object.assign(node, { selection: [], async loadAsync() {} });
    return node;
  }
  const root = make('DOCUMENT', 'Test document'), page = make('PAGE', 'Existing page'); root.appendChild(page);
  const figma = {
    root, currentPage: page, mixed: Symbol('mixed'), events, nodes, make,
    available: ['Regular', 'Medium', 'SemiBold'].map(style => ({ fontName: { family: 'Geist', style } })),
    async listAvailableFontsAsync() { return this.available; },
    async loadFontAsync(font) { events.push(['font', font]); if (this.failFont === font.style) throw new Error('Font loading failed'); },
    async getNodeByIdAsync(id) { return nodes.get(id) || null; },
    async setCurrentPageAsync(target) { this.currentPage = target; },
    base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); }
  };
  for (const [method, type] of Object.entries({ createFrame: 'FRAME', createComponent: 'COMPONENT', createEllipse: 'ELLIPSE', createText: 'TEXT' })) {
    figma[method] = () => { events.push(['create', type]); const node = make(type); figma.currentPage.appendChild(node); return node; };
  }
  figma.createPage = () => { events.push(['create', 'PAGE']); const node = make('PAGE'); root.appendChild(node); return node; };
  figma.createNodeFromSvg = svg => {
    events.push(['create', 'SVG']); const node = make('FRAME'); node.svg = svg;
    node.width = Number(svg.match(/width="([\d.]+)"/)[1]); node.height = Number(svg.match(/height="([\d.]+)"/)[1]);
    node.appendChild(make('VECTOR')); figma.currentPage.appendChild(node); return node;
  };
  return figma;
}

test('exact default font must exist before native nodes are created', async () => {
  const figma = mockFigma(); figma.available = [{ fontName: { family: 'Geist', style: 'Regular' } }];
  await assert.rejects(execute(figma, 'create', { template: 'pill' }), /Font unavailable: Geist SemiBold/);
  assert.equal(figma.events.length, 0);
  assert.equal(figma.currentPage.children.length, 0);
});

test('font loading failure does not leave a partially created component', async () => {
  const figma = mockFigma(); figma.failFont = 'Medium';
  await assert.rejects(execute(figma, 'create', { template: 'button' }), /Font loading failed/);
  assert.equal(figma.events.some(([kind]) => kind === 'create'), false);
});

test('pill uses equal padding, native Hug component, exact Geist style and line height', async () => {
  const figma = mockFigma(), page = figma.currentPage, selection = [figma.make('FRAME')]; page.selection = selection;
  const target = figma.make('PAGE', 'Pills'); figma.root.appendChild(target);
  const result = await execute(figma, 'create', { template: 'pill', pageId: target.id, text: 'hypit-ai/hypit', icon: 'github' });
  const root = figma.nodes.get(result.root.id), label = root.children.find(n => n.type === 'TEXT');
  assert.equal(root.type, 'COMPONENT'); assert.equal(root.parent, target);
  assert.deepEqual([root.paddingTop, root.paddingRight, root.paddingBottom, root.paddingLeft], [32, 32, 32, 32]);
  assert.equal(root.primaryAxisSizingMode, 'AUTO'); assert.equal(root.counterAxisSizingMode, 'AUTO');
  assert.deepEqual(copy(label.fontName), { family: 'Geist', style: 'SemiBold' });
  assert.deepEqual(copy(label.lineHeight), { unit: 'PIXELS', value: 56 });
  assert.equal(label.characters, 'hypit-ai/hypit'); assert.equal(root.children[0].children[0].type, 'VECTOR');
  assert.equal(figma.currentPage, page); assert.equal(page.selection, selection);
  assert.equal(figma.events[0][0], 'font');
});

test('browser has complete editable 1440×900 geometry and preserves page selection', async () => {
  const figma = mockFigma(), page = figma.currentPage;
  const result = await execute(figma, 'create', { template: 'browser' });
  const root = figma.nodes.get(result.root.id), content = root.children.find(n => n.name === 'Webpage content');
  assert.equal(root.type, 'FRAME'); assert.equal(root.width, 1440); assert.equal(root.height, 900);
  assert.equal(content.y + content.height, root.height); assert.equal(content.width, root.width);
  assert.equal(root.children.find(n => n.name === 'Tab title').characters, 'hypit.ai');
  const toolbar = root.children.find(n => n.name === 'Toolbar'), address = toolbar.children.find(n => n.name === 'Address bar');
  assert.equal(address.children.find(n => n.name === 'URL').characters, 'hypit.ai');
  assert.equal(figma.currentPage, page); assert.equal(page.selection.length, 0);
});

test('inspect depth stops traversal at the source and records truncation', async () => {
  const figma = mockFigma(), root = figma.make('FRAME'), child = figma.make('FRAME'); root.appendChild(child);
  Object.defineProperty(child, 'name', { get() { throw new Error('unrequested descendant visited'); } });
  const result = await execute(figma, 'inspect', { nodeIds: [root.id], depth: 0 });
  assert.equal(result.visited, 1); assert.equal(result.truncated, true); assert.equal(result.roots[0].childrenTruncated, 1);
});

test('inspect maxNodes prevents visiting extra nodes and includes actual text styles', async () => {
  const figma = mockFigma(), root = figma.make('FRAME'), text = figma.make('TEXT'), skipped = figma.make('FRAME');
  text.fontName = { family: 'Geist', style: 'Medium' }; text.lineHeight = { unit: 'PIXELS', value: 36 };
  root.appendChild(text); root.appendChild(skipped);
  Object.defineProperty(skipped, 'name', { get() { throw new Error('budget exceeded'); } });
  const result = await execute(figma, 'inspect', { nodeIds: [root.id], depth: 8, maxNodes: 2 });
  assert.equal(result.visited, 2); assert.equal(result.truncated, true);
  assert.equal(result.roots[0].children[0].fontName.style, 'Medium');
  assert.equal(result.roots[0].children[0].lineHeight.value, 36);
});

test('batch update validates every node before changing the first target', async () => {
  const figma = mockFigma(), frame = figma.make('FRAME', 'Keep name'), text = figma.make('TEXT');
  await assert.rejects(execute(figma, 'update', { nodeIds: [frame.id, text.id], props: { name: 'Changed', padding: 32 } }), /does not support padding/);
  assert.equal(frame.name, 'Keep name'); assert.equal(frame.paddingTop, 0);
  await assert.rejects(execute(figma, 'update', { nodeIds: [frame.id, 'missing'], props: { name: 'Changed' } }), /Node not found/);
  assert.equal(frame.name, 'Keep name');
});

test('batch font preflight failure preserves all text', async () => {
  const figma = mockFigma(), a = figma.make('TEXT'), b = figma.make('TEXT');
  a.fontName = { family: 'Geist', style: 'Regular' }; b.fontName = { family: 'Geist', style: 'Medium' };
  a.characters = 'One'; b.characters = 'Two'; figma.failFont = 'Medium';
  await assert.rejects(execute(figma, 'update', { nodeIds: [a.id, b.id], props: { text: 'Changed' } }), /Font loading failed/);
  assert.equal(a.characters, 'One'); assert.equal(b.characters, 'Two');
});

test('explicit font replacement can repair unavailable existing font', async () => {
  const figma = mockFigma(), text = figma.make('TEXT');
  text.fontName = { family: 'Missing font', style: 'Unknown' };
  const result = await execute(figma, 'update', { nodeIds: [text.id], props: { font: { family: 'Geist', style: 'Regular' }, text: 'Repaired' } });
  assert.equal(text.characters, 'Repaired'); assert.equal(result.roots[0].fontName.family, 'Geist');
});

test('padding shorthand updates every side and conflicting input is rejected', async () => {
  const figma = mockFigma(), node = figma.make('FRAME');
  await execute(figma, 'update', { nodeIds: [node.id], props: { padding: 24 } });
  assert.deepEqual([node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft], [24, 24, 24, 24]);
  await assert.rejects(execute(figma, 'update', { nodeIds: [node.id], props: { padding: 32, paddingLeft: 64 } }), /not both/);
  assert.equal(node.paddingLeft, 24);
});

test('invalid template parameters do not mutate the document', async () => {
  const figma = mockFigma();
  for (const params of [{ template: 'pill', fill: 'red' }, { template: 'button', width: -1 }, { template: 'browser', font: { family: 'Geist' } }, { template: 'pill', unexpected: true }]) {
    await assert.rejects(execute(figma, 'create', params));
  }
  assert.equal(figma.events.length, 0);
});

test('export checks render pixel budget before native export and returns bounded base64', async () => {
  const figma = mockFigma(), node = figma.make('FRAME'); node.absoluteRenderBounds = { width: 5000, height: 5000 };
  await assert.rejects(execute(figma, 'export', { nodeId: node.id }), /16 million pixels/);
  assert.equal(figma.events.length, 0);
  const result = await execute(figma, 'export', { nodeId: node.id, scale: 0.5 });
  assert.equal(result.mime, 'image/png'); assert.equal(result.data, Buffer.from(pngHeader(2500, 2500)).toString('base64'));
  assert.equal(result.width, 2500); assert.equal(result.height, 2500); assert.equal(result.nodeWidth, 100);
  node.exportAsync = async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="132" height="140" viewBox="0 0 132 140"></svg>');
  const svg = await execute(figma, 'export', { nodeId: node.id, format: 'SVG' });
  assert.equal(svg.width, 132); assert.equal(svg.height, 140); assert.equal(svg.nodeHeight, 100);
  node.exportAsync = async () => new Uint8Array(7 * 1024 * 1024 + 1);
  await assert.rejects(execute(figma, 'export', { nodeId: node.id, format: 'SVG' }), /7 MiB/);
});

test('page.create explicitly selects a new page; advanced run returns bounded JSON', async () => {
  const figma = mockFigma(); const result = await execute(figma, 'page.create', { name: 'New page' });
  assert.equal(figma.currentPage.id, result.id); assert.equal(result.name, 'New page');
  assert.deepEqual(copy(await execute(figma, 'run', { code: 'return { pageId: figma.currentPage.id, result: await Promise.resolve(4) };' })), { pageId: result.id, result: 4 });
  await assert.rejects(execute(figma, 'run', { code: 'return "x".repeat(1024*1024+1)' }), /1 MiB/);
  await assert.rejects(execute(figma, 'unsupported', {}), /Unsupported method/);
});
