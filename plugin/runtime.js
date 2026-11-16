/* Native Figma operations. No network access, host eval, or automatic retries. */
(() => {
  'use strict';
  const fail = message => { throw new Error(message); };
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function object(value, label = 'params') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
    return value;
  }
  function keys(value, allowed, label = 'params') {
    object(value, label);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unsupported ${label} property: ${key}`);
  }
  function str(value, label, max = 200, empty = false) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail(`${label} must be a string of ${empty ? '0' : '1'}–${max} characters`);
    return value;
  }
  function num(value, label, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}`);
    return value;
  }
  function choice(value, label, values) {
    if (!values.includes(value)) fail(`${label} must be one of ${values.join(', ')}`);
    return value;
  }
  function color(value, label = 'color') {
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) fail(`${label} must be #RRGGBB`);
    return value;
  }
  function paint(hex) {
    return [{ type: 'SOLID', color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 } }];
  }
  function font(value) {
    keys(value, ['family', 'style'], 'font');
    return { family: str(value.family, 'font.family', 100), style: str(value.style, 'font.style', 100) };
  }
  function padding(value) {
    if (typeof value === 'number') {
      num(value, 'padding', 0, 1024);
      return { paddingTop: value, paddingRight: value, paddingBottom: value, paddingLeft: value };
    }
    keys(value, ['top', 'right', 'bottom', 'left'], 'padding');
    const out = {};
    for (const side of ['top', 'right', 'bottom', 'left']) out['padding' + side[0].toUpperCase() + side.slice(1)] = num(value[side], `padding.${side}`, 0, 1024);
    return out;
  }
  async function loadFonts(figma, names) {
    const unique = [...new Map(names.map(f => [JSON.stringify(f), f])).values()];
    if (!unique.length) return;
    const available = await figma.listAvailableFontsAsync();
    for (const f of unique) if (!available.some(a => a.fontName.family === f.family && a.fontName.style === f.style)) fail(`Font unavailable: ${f.family} ${f.style}. Install the exact font or specify another font.`);
    for (const f of unique) await figma.loadFontAsync(f);
  }
  async function nodeById(figma, id) {
    str(id, 'nodeId', 200);
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed) fail(`Node not found: ${id}`);
    return node;
  }
  async function nodesById(figma, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 64) fail('nodeIds must contain 1–64 IDs');
    if (new Set(ids).size !== ids.length) fail('nodeIds must be unique');
    return Promise.all(ids.map(id => nodeById(figma, id)));
  }
  const SNAPSHOT_FIELDS = ['x', 'y', 'width', 'height', 'absoluteBoundingBox', 'visible', 'locked', 'opacity',
    'rotation', 'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'effects', 'cornerRadius', 'topLeftRadius',
    'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'clipsContent', 'layoutMode',
    'primaryAxisSizingMode', 'counterAxisSizingMode', 'layoutSizingHorizontal', 'layoutSizingVertical',
    'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft', 'layoutGrow', 'layoutAlign', 'layoutPositioning', 'characters',
    'fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAutoResize', 'textAlignHorizontal'];
  function plain(value, state, depth = 0) {
    if (value === undefined) return null;
    if (typeof value === 'symbol') return 'mixed';
    if (depth > 6 || state.bytes <= 0) { state.fieldsTruncated = true; return '[truncated]'; }
    if (typeof value === 'string') {
      const limit = Math.max(0, Math.min(4096, state.bytes));
      if (value.length > limit) state.fieldsTruncated = true;
      const out = value.slice(0, limit); state.bytes -= out.length; return out;
    }
    state.bytes -= 16;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) {
      if (value.length > 32) state.fieldsTruncated = true;
      return value.slice(0, 32).map(v => plain(v, state, depth + 1));
    }
    const out = {}, entries = Object.keys(value);
    if (entries.length > 48) state.fieldsTruncated = true;
    for (const key of entries.slice(0, 48)) { state.bytes -= key.length; out[key] = plain(value[key], state, depth + 1); }
    return out;
  }
  function snapshot(roots, depth = 2, maxNodes = 100) {
    const state = { visited: 0, truncated: false, fieldsTruncated: false, bytes: 500000 };
    function visit(node, level) {
      state.visited++;
      const out = { id: node.id, type: node.type, name: plain(node.name, state) };
      for (const field of SNAPSHOT_FIELDS) if (field in node) out[field] = plain(node[field], state);
      if ('children' in node) {
        const children = node.children;
        out.childCount = children.length;
        out.children = [];
        if (level < depth) for (const child of children) {
          if (state.visited >= maxNodes) break;
          out.children.push(visit(child, level + 1));
        }
        if (out.children.length < children.length) { out.childrenTruncated = children.length - out.children.length; state.truncated = true; }
      }
      return out;
    }
    const result = [];
    for (const root of roots) {
      if (state.visited >= maxNodes) { state.truncated = true; break; }
      result.push(visit(root, 0));
    }
    return { roots: result, visited: state.visited, truncated: state.truncated, fieldsTruncated: state.fieldsTruncated };
  }
  async function inspect(figma, params) {
    keys(params, ['nodeIds', 'depth', 'maxNodes']);
    const depth = num(params.depth ?? 2, 'depth', 0, 8), maxNodes = num(params.maxNodes ?? 100, 'maxNodes', 1, 500);
    if (!Number.isInteger(depth) || !Number.isInteger(maxNodes)) fail('depth and maxNodes must be integers');
    const roots = params.nodeIds ? await nodesById(figma, params.nodeIds) : (figma.currentPage.selection.length ? figma.currentPage.selection : [figma.currentPage]);
    return { document: { rootId: figma.root.id, name: figma.root.name, ...(figma.fileKey ? { fileKey: figma.fileKey } : {}) }, page: { id: figma.currentPage.id, name: figma.currentPage.name }, ...snapshot(roots, depth, maxNodes) };
  }
  function configureFrame(node, name, width, height, fill, radius = 0) {
    node.name = name; node.resize(width, height); node.fills = fill ? paint(fill) : []; node.cornerRadius = radius;
    return node;
  }
  function append(parent, node, x = 0, y = 0) { parent.appendChild(node); node.x = x; node.y = y; return node; }
  function textNode(figma, parent, text, cfg, x = 0, y = 0) {
    const node = figma.createText(); parent.appendChild(node); node.name = 'Label';
    node.fontName = cfg.font; node.fontSize = cfg.fontSize; node.lineHeight = { unit: 'PIXELS', value: cfg.lineHeight };
    node.characters = text; node.fills = paint(cfg.textColor); node.textAutoResize = 'WIDTH_AND_HEIGHT'; node.x = x; node.y = y;
    return node;
  }
  // GitHub mark: Primer Octicons mark-github-16.svg, MIT (see THIRD_PARTY_NOTICES.md).
  const GITHUB_PATH = 'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656';
  function svg(figma, parent, name, body, width, height, x = 0, y = 0, viewBox = `0 0 ${width} ${height}`) {
    const node = figma.createNodeFromSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${body}</svg>`);
    node.name = name; return append(parent, node, x, y);
  }
  function icon(figma, parent, kind, size, hex, x = 0, y = 0) {
    if (kind === 'github') return svg(figma, parent, 'GitHub icon', `<path fill="${hex}" d="${GITHUB_PATH}"/>`, size, size, x, y, '0 0 16 16');
    return svg(figma, parent, 'Globe icon', `<g fill="none" stroke="${hex}" stroke-width="4"><circle cx="28" cy="28" r="24"/><ellipse cx="28" cy="28" rx="11" ry="24"/><path d="M4 28H52"/></g>`, size, size, x, y, '0 0 56 56');
  }
  function lineIcon(figma, parent, name, path, width, height, x, y, hex = '#C4C5C7') {
    return svg(figma, parent, name, `<path d="${path}" fill="none" stroke="${hex}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`, width, height, x, y);
  }
  function templateConfig(params) {
    const template = choice(params.template, 'template', ['button', 'pill', 'browser']);
    const common = ['template', 'pageId', 'name', 'x', 'y', 'font', 'fontSize', 'lineHeight', 'fill', 'textColor', 'radius'];
    keys(params, common.concat(template === 'browser' ? ['width', 'height', 'title', 'url'] : template === 'pill' ? ['text', 'padding', 'gap', 'icon', 'iconSize'] : ['text', 'padding', 'width', 'height']));
    const cfg = { template, name: str(params.name ?? (template === 'browser' ? 'Hypit · Browser' : template === 'pill' ? 'Hypit · Link pill' : 'Get Started'), 'name'),
      x: num(params.x ?? 0, 'x', -1e6, 1e6), y: num(params.y ?? 0, 'y', -1e6, 1e6),
      font: font(params.font ?? { family: 'Geist', style: template === 'pill' ? 'SemiBold' : template === 'button' ? 'Medium' : 'Regular' }),
      fontSize: num(params.fontSize ?? (template === 'pill' ? 56 : template === 'button' ? 30 : 16), 'fontSize', 1, 512),
      fill: color(params.fill ?? (template === 'button' ? '#DE3B67' : template === 'pill' ? '#1D1B19' : '#202020'), 'fill'),
      textColor: color(params.textColor ?? (template === 'browser' ? '#C4C5C7' : '#FFFFFF'), 'textColor'),
      radius: num(params.radius ?? (template === 'pill' ? 999 : template === 'button' ? 16 : 24), 'radius', 0, 4096) };
    cfg.lineHeight = num(params.lineHeight ?? (template === 'pill' ? cfg.fontSize : cfg.fontSize * 1.2), 'lineHeight', 1, 1024);
    if (template !== 'browser') { cfg.text = str(params.text ?? (template === 'button' ? 'Get Started' : 'hypit.ai'), 'text', 2000, true); cfg.padding = padding(params.padding ?? (template === 'pill' ? 32 : 0)); }
    if (template === 'pill') {
      cfg.icon = choice(params.icon ?? 'globe', 'icon', ['globe', 'github', 'none']);
      cfg.iconSize = num(params.iconSize ?? cfg.fontSize, 'iconSize', 1, 512); cfg.gap = num(params.gap ?? 28, 'gap', 0, 1024);
    } else {
      cfg.width = num(params.width ?? (template === 'browser' ? 1440 : 236), 'width', template === 'browser' ? 640 : 1, 8192);
      cfg.height = num(params.height ?? (template === 'browser' ? 900 : 80), 'height', template === 'browser' ? 240 : 1, 8192);
    }
    if (template === 'browser') { cfg.title = str(params.title ?? 'hypit.ai', 'title', 200); cfg.url = str(params.url ?? 'hypit.ai', 'url', 2000); }
    return cfg;
  }
  function drawBrowser(figma, root, cfg) {
    root.clipsContent = true;
    const tab = svg(figma, root, 'Active tab', '<path fill="#3A3B3D" d="M0 44C6.627 44 12 38.627 12 32V12C12 5.373 17.373 0 24 0H271C277.627 0 283 5.373 283 12V32C283 38.627 288.373 44 295 44Z"/>', 295, 44, 100, 8);
    tab.name = 'Active tab';
    ['#EA6053', '#F1B74C', '#5DBF4E'].forEach((hex, i) => { const dot = figma.createEllipse(); dot.name = ['Close window', 'Minimize', 'Maximize'][i]; dot.resize(14, 14); dot.fills = paint(hex); append(root, dot, 17 + i * 22, 19); });
    icon(figma, root, 'globe', 20, cfg.textColor, 130, 20);
    const title = textNode(figma, root, cfg.title, cfg, 160, 17); title.name = 'Tab title';
    title.textAutoResize = 'NONE'; title.resize(175, 28); title.textTruncation = 'ENDING';
    lineIcon(figma, root, 'Close tab', 'M2 2L10 10M10 2L2 10', 12, 12, 352, 24);
    lineIcon(figma, root, 'New tab', 'M8 1V15M1 8H15', 16, 16, 411, 22);
    const toolbar = append(root, configureFrame(figma.createFrame(), 'Toolbar', cfg.width, 56, '#3A3B3D'), 0, 52);
    lineIcon(figma, toolbar, 'Back', 'M18 10H2M9 3L2 10L9 17', 20, 20, 20, 18);
    lineIcon(figma, toolbar, 'Forward', 'M2 10H18M11 3L18 10L11 17', 20, 20, 60, 18, '#77787A');
    lineIcon(figma, toolbar, 'Reload', 'M19 8A8 8 0 1 0 19 14M19 2V8H13', 22, 22, 100, 17);
    const address = append(toolbar, configureFrame(figma.createFrame(), 'Address bar', cfg.width - 204, 40, cfg.fill, 14), 140, 8);
    address.clipsContent = true;
    const url = textNode(figma, address, cfg.url, { ...cfg, textColor: '#808080' }, 20, 10); url.name = 'URL';
    url.textAutoResize = 'NONE'; url.resize(address.width - 80, 24); url.textTruncation = 'ENDING';
    lineIcon(figma, address, 'Bookmark', 'M9 1L11.5 6.3L17 7L13 11L14 17L9 14.2L4 17L5 11L1 7L6.5 6.3Z', 18, 18, address.width - 38, 11);
    for (let i = 0; i < 3; i++) { const dot = figma.createEllipse(); dot.name = 'Menu dot'; dot.resize(3, 3); dot.fills = paint('#C4C5C7'); append(toolbar, dot, cfg.width - 33, 21 + i * 5); }
    append(root, configureFrame(figma.createFrame(), 'Webpage content', cfg.width, cfg.height - 108, cfg.fill), 0, 108);
  }
  async function create(figma, params) {
    const cfg = templateConfig(params);
    const page = params.pageId ? await nodeById(figma, params.pageId) : figma.currentPage;
    if (page.type !== 'PAGE') fail('pageId must identify a page');
    if (page.loadAsync) await page.loadAsync();
    await loadFonts(figma, [cfg.font]);
    let root;
    try {
      root = cfg.template === 'browser' ? figma.createFrame() : figma.createComponent();
      configureFrame(root, cfg.name, cfg.width ?? 100, cfg.height ?? 100, cfg.fill, cfg.radius); append(page, root, cfg.x, cfg.y);
      if (cfg.template === 'browser') drawBrowser(figma, root, cfg);
      else {
        root.layoutMode = 'HORIZONTAL'; root.primaryAxisAlignItems = 'CENTER'; root.counterAxisAlignItems = 'CENTER';
        Object.assign(root, cfg.padding); root.itemSpacing = cfg.gap ?? 0;
        root.primaryAxisSizingMode = cfg.template === 'pill' ? 'AUTO' : 'FIXED'; root.counterAxisSizingMode = cfg.template === 'pill' ? 'AUTO' : 'FIXED';
        if (cfg.template === 'pill' && cfg.icon !== 'none') icon(figma, root, cfg.icon, cfg.iconSize, cfg.textColor);
        const label = textNode(figma, root, cfg.text, cfg);
        if (root.addComponentProperty) { const prop = root.addComponentProperty('Label', 'TEXT', cfg.text); label.componentPropertyReferences = { characters: prop }; }
        if (cfg.template === 'pill') root.effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.12 }, offset: { x: 0, y: 12 }, radius: 32, spread: 0, visible: true, blendMode: 'NORMAL' }];
      }
      return { pageId: page.id, root: snapshot([root], 3, 100).roots[0] };
    } catch (error) { if (root) error.createdNodeIds = [root.id]; throw error; }
  }
  const UPDATE_KEYS = ['name', 'x', 'y', 'width', 'height', 'cornerRadius', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'font', 'fontSize', 'text', 'lineHeight', 'fill', 'opacity', 'visible', 'clipsContent'];
  function updateProps(props) {
    keys(props, UPDATE_KEYS, 'props');
    if (!Object.keys(props).length) fail('props must not be empty');
    const out = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === 'padding') { Object.assign(out, padding(value)); continue; }
      if (key === 'font') out.fontName = font(value);
      else if (key === 'text') out.characters = str(value, 'text', 10000, true);
      else if (key === 'name') out.name = str(value, 'name');
      else if (key === 'fill') out.fills = paint(color(value, 'fill'));
      else if (['visible', 'clipsContent'].includes(key)) { if (typeof value !== 'boolean') fail(`${key} must be boolean`); out[key] = value; }
      else if (key === 'layoutMode') out[key] = choice(value, key, ['NONE', 'HORIZONTAL', 'VERTICAL']);
      else if (key.endsWith('SizingMode')) out[key] = choice(value, key, ['AUTO', 'FIXED']);
      else if (key === 'primaryAxisAlignItems') out[key] = choice(value, key, ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']);
      else if (key === 'counterAxisAlignItems') out[key] = choice(value, key, ['MIN', 'CENTER', 'MAX', 'BASELINE']);
      else if (key === 'lineHeight') out[key] = { unit: 'PIXELS', value: num(value, key, 1, 1024) };
      else out[key] = num(value, key, ['x', 'y'].includes(key) ? -1e6 : ['width', 'height', 'fontSize'].includes(key) ? 1 : 0, ['x', 'y'].includes(key) ? 1e6 : key === 'opacity' ? 1 : key === 'fontSize' ? 512 : key.startsWith('padding') || key === 'itemSpacing' ? 1024 : 8192);
    }
    if (own(props, 'padding') && Object.keys(props).some(k => k.startsWith('padding') && k !== 'padding')) fail('Use padding shorthand or individual padding fields, not both');
    return out;
  }
  async function update(figma, params) {
    keys(params, ['nodeIds', 'props']);
    const props = updateProps(params.props), nodes = await nodesById(figma, params.nodeIds), fonts = [];
    const textKeys = ['fontName', 'fontSize', 'characters', 'lineHeight'];
    for (const node of nodes) {
      for (const key of Object.keys(props)) {
        if (!(key in node)) fail(`${node.id} (${node.type}) does not support ${key}`);
        if (textKeys.includes(key) && node.type !== 'TEXT') fail(`${key} requires text nodes`);
        if (['width', 'height'].includes(key) && typeof node.resize !== 'function') fail(`${node.id} cannot be resized`);
      }
      const layoutMode = props.layoutMode ?? node.layoutMode;
      if (layoutMode === 'NONE' && ['primaryAxisSizingMode', 'counterAxisSizingMode'].some(k => props[k] === 'AUTO')) fail(`${node.id}: AUTO sizing requires Auto Layout`);
      if (Object.keys(props).some(k => textKeys.includes(k))) {
        if (props.fontName) fonts.push(props.fontName);
        // Without an explicit replacement, edits require every existing font.
        else if (typeof node.fontName === 'symbol') {
          if (!node.characters.length || typeof node.getRangeAllFontNames !== 'function') { if (!props.fontName) fail(`Specify font for mixed-font text ${node.id}`); }
          else fonts.push(...node.getRangeAllFontNames(0, node.characters.length));
        } else fonts.push(node.fontName);
      }
    }
    await loadFonts(figma, fonts);
    for (const node of nodes) {
      for (const key of ['fontName', 'layoutMode']) if (own(props, key)) node[key] = props[key];
      for (const [key, value] of Object.entries(props)) if (!['fontName', 'layoutMode', 'width', 'height'].includes(key)) node[key] = value;
      if (own(props, 'width') || own(props, 'height')) node.resize(props.width ?? node.width, props.height ?? node.height);
    }
    return snapshot(nodes, 0, 64);
  }
  async function exportNode(figma, params) {
    keys(params, ['nodeId', 'format', 'scale']);
    const format = choice(params.format ?? 'PNG', 'format', ['PNG', 'SVG']), scale = num(params.scale ?? 1, 'scale', 0.1, 4);
    const node = await nodeById(figma, params.nodeId);
    if (typeof node.exportAsync !== 'function' || !('width' in node)) fail('nodeId must identify an exportable scene node');
    const bounds = node.absoluteRenderBounds ?? { width: node.width, height: node.height };
    if (format === 'PNG' && Math.ceil(bounds.width * scale) * Math.ceil(bounds.height * scale) > 16e6) fail('PNG export exceeds 16 million pixels; reduce scale or export a smaller node');
    const bytes = await node.exportAsync(format === 'PNG' ? { format, constraint: { type: 'SCALE', value: scale } } : { format, svgOutlineText: false, svgIdAttribute: true });
    if (bytes.length > 7 * 1024 * 1024) fail('Export exceeds 7 MiB; reduce scale or export a smaller node');
    let width, height;
    if (format === 'PNG') {
      if (bytes.length < 24 || [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v)) fail('Figma returned an invalid PNG');
      const uint32 = offset => bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
      width = uint32(16); height = uint32(20);
    } else {
      const header = String.fromCharCode(...bytes.slice(0, 16384)).match(/<svg\b[^>]*>/i)?.[0] ?? '';
      const dimension = name => Number(header.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([\\d.]+)(?:px)?["\']', 'i'))?.[1]);
      width = dimension('width'); height = dimension('height');
      if (!width || !height) {
        const box = header.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number);
        if (box?.length === 4) { width ||= box[2]; height ||= box[3]; }
      }
    }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) fail('Cannot determine exported image dimensions');
    return { nodeId: node.id, format, mime: format === 'PNG' ? 'image/png' : 'image/svg+xml', data: figma.base64Encode(bytes), width, height, nodeWidth: node.width, nodeHeight: node.height };
  }
  globalThis.FigmaLocalRuntime = Object.freeze({
    async execute(figma, method, params = {}) {
      object(params);
      if (method === 'inspect') return inspect(figma, params);
      if (method === 'create') return create(figma, params);
      if (method === 'update') return update(figma, params);
      if (method === 'export') return exportNode(figma, params);
      if (method === 'fonts') {
        keys(params, ['family']); if (own(params, 'family')) str(params.family, 'family', 100);
        const fonts = (await figma.listAvailableFontsAsync()).map(f => f.fontName).filter(f => !params.family || f.family.toLowerCase() === params.family.toLowerCase());
        return { fonts: fonts.slice(0, 500), total: fonts.length, truncated: fonts.length > 500 };
      }
      if (method === 'page.create') {
        keys(params, ['name']); const name = str(params.name, 'name'); const page = figma.createPage(); page.name = name;
        try { await figma.setCurrentPageAsync(page); } catch (error) { error.createdNodeIds = [page.id]; throw error; }
        return { id: page.id, name: page.name };
      }
      if (method === 'run') {
        keys(params, ['code']); str(params.code, 'code', 20000);
        // Deliberately powerful plugin-local escape hatch, not a security sandbox.
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const value = await new AsyncFunction('figma', '"use strict";\n' + params.code)(figma);
        const json = JSON.stringify(value === undefined ? null : value);
        if (json === undefined || json.length > 1024 * 1024) fail('run must return JSON data no larger than 1 MiB');
        return JSON.parse(json);
      }
      fail(`Unsupported method: ${method}`);
    }
  });
})();
