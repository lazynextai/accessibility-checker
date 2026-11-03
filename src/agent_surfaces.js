// Agent-facing surfaces for the Accessibility Checker product:
//   - MCP (JSON-RPC 2.0 over POST /mcp): initialize, tools/list, tools/call
//   - A2A: GET /.well-known/agent.json card + POST /a2a (message/send,
//     tasks/send alias, tasks/get)
//   - WIDGET_JS: embeddable <script> tag that mounts a scan form anywhere.
// All scan calls share the /scan quota + pipeline via runScan — an agent
// can't bypass the free limit by switching protocol.
import { runScan } from './scan_pipeline.js';
import { RULES } from './rules/manifest.js';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'accessibility-checker', version: '1.0.0', title: 'Accessibility Checker' };

export const AGENT_CARD = {
  name: 'Accessibility Checker',
  description: 'Scans web pages for WCAG 2.1/2.2 violations — rendered and static checks, site crawls, shareable reports.',
  url: 'https://checker.lazynext.com/a2a',
  version: '1.0.0',
  protocolVersion: '0.3.0',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text'],
  defaultOutputModes: ['data'],
  skills: [
    { id: 'scan_url', name: 'Scan a URL', description: 'Render and audit a live page for WCAG violations; returns score, findings, and a shareable report URL.', tags: ['wcag', 'a11y', 'scan'] },
    { id: 'scan_html', name: 'Scan HTML', description: 'Audit pasted HTML markup (static rules only, no quota).', tags: ['wcag', 'html'] },
    { id: 'get_report', name: 'Get report', description: 'Fetch a previously generated report by id.', tags: ['report'] },
  ],
};

const MCP_TOOLS = [
  {
    name: 'scan_url',
    description: 'Render and audit a live web page for WCAG 2.1/2.2 violations. Returns score, findings, and a shareable report URL. Free tier: 3 URL scans/day/IP; pass a Pro license email for more.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to scan' },
        site: { type: 'boolean', description: 'crawl same-origin pages (3 free / 10 Pro)' },
        viewport: { type: 'string', enum: ['mobile', 'desktop'], description: 'render profile — mobile 390×844 handset (default); desktop preserves the pre-mobile baseline render' },
        license: { type: 'string', description: 'Pro license email (optional)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'scan_html',
    description: 'Audit pasted HTML markup for WCAG violations (static rules — no render, no quota).',
    inputSchema: {
      type: 'object',
      properties: { html: { type: 'string', description: 'HTML source, max 512KB' } },
      required: ['html'],
    },
  },
  {
    name: 'get_report',
    description: 'Fetch a stored scan report by its id (from a prior scan_url/scan_html result).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'report id (the slug in the report URL)' } },
      required: ['id'],
    },
  },
  {
    name: 'list_rules',
    description: 'List every WCAG criterion the scanner can emit, with level and detection path.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const toolResult = (id, data) => rpcOk(id, {
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

async function callTool(env, kv, ip, origin, name, args = {}) {
  if (name === 'list_rules') return { count: RULES.length, rules: RULES };
  if (name === 'get_report') {
    const raw = await kv.kvGet(env, `report:${String(args.id ?? '')}`);
    if (!raw) return { error: 'report not found or expired' };
    return JSON.parse(raw);
  }
  if (name === 'scan_url') {
    const r = await runScan(env, kv, { url: args.url, site: args.site === true, viewport: args.viewport, license: args.license, ip, origin, surface: 'mcp' });
    return r.ok ? r.result : { error: r.payload.error, status: r.status, ...r.payload };
  }
  if (name === 'scan_html') {
    const r = await runScan(env, kv, { html: args.html, ip, origin, surface: 'mcp' });
    return r.ok ? r.result : { error: r.payload.error, status: r.status, ...r.payload };
  }
  return { error: `unknown tool: ${name}` };
}

// MCP endpoint — streamable-HTTP subset: single POST of JSON-RPC, JSON
// response. GET is 405 per spec (no SSE stream offered).
export async function handleMcp(request, env, kv, ip, origin) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify(rpcErr(null, -32600, 'POST required — this endpoint does not offer SSE')), {
      status: 405, headers: { 'content-type': 'application/json', allow: 'POST' },
    });
  }
  const msg = await request.json().catch(() => null);
  if (!msg || msg.jsonrpc !== '2.0') {
    return new Response(JSON.stringify(rpcErr(msg?.id, -32600, 'invalid JSON-RPC 2.0 request')), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  // Notifications carry no id — acknowledge and drop.
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202 });
  }
  let out;
  switch (msg.method) {
    case 'initialize':
      out = rpcOk(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case 'ping':
      out = rpcOk(msg.id, {});
      break;
    case 'tools/list':
      out = rpcOk(msg.id, { tools: MCP_TOOLS });
      break;
    case 'tools/call': {
      const { name, arguments: args } = msg.params ?? {};
      if (!MCP_TOOLS.some((t) => t.name === name)) {
        out = rpcErr(msg.id, -32602, `unknown tool: ${name}`);
        break;
      }
      const data = await callTool(env, kv, ip, origin, name, args ?? {});
      out = toolResult(msg.id, data);
      break;
    }
    default:
      out = rpcErr(msg.id, -32601, `method not found: ${msg.method}`);
  }
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}

// ── A2A ──────────────────────────────────────────────────────────────────
// tasks/send + message/send run a scan synchronously and return a completed
// task; its id is the persisted report id, so tasks/get replays it from the
// report store with no separate task storage.
const taskView = (id, result) => ({
  id,
  status: { state: 'completed', timestamp: new Date().toISOString() },
  artifacts: [{
    name: 'accessibility-report',
    parts: [{ type: 'data', data: result }],
  }],
});

function textFromMessage(message) {
  const parts = message?.parts ?? [];
  return parts.map((p) => (p?.type === 'text' || p?.kind === 'text') ? (p.text ?? '') : '').join('\n');
}

export async function handleA2a(request, env, kv, ip, origin) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify(rpcErr(null, -32600, 'POST required')), {
      status: 405, headers: { 'content-type': 'application/json', allow: 'POST' },
    });
  }
  const msg = await request.json().catch(() => null);
  if (!msg || msg.jsonrpc !== '2.0') {
    return new Response(JSON.stringify(rpcErr(msg?.id, -32600, 'invalid JSON-RPC 2.0 request')), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  let out;
  switch (msg.method) {
    case 'message/send':
    case 'tasks/send': {
      const message = msg.params?.message ?? msg.params ?? {};
      const text = textFromMessage(message);
      const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/);
      const htmlMatch = text.match(/<html[\s\S]*<\/html>/i) ?? text.match(/<[a-z][\s\S]*>/i);
      if (!urlMatch && !htmlMatch) {
        out = rpcErr(msg.id, -32602, 'send a message containing a URL or HTML markup to scan');
        break;
      }
      const r = urlMatch
        ? await runScan(env, kv, { url: urlMatch[0], ip, origin, surface: 'a2a' })
        : await runScan(env, kv, { html: htmlMatch[0], ip, origin, surface: 'a2a' });
      if (!r.ok) { out = rpcErr(msg.id, -32000, r.payload.error ?? 'scan failed'); break; }
      const id = (r.result.report ?? '').split('/report/')[1] ?? crypto.randomUUID().slice(0, 12);
      out = rpcOk(msg.id, { task: taskView(id, r.result) });
      break;
    }
    case 'tasks/get': {
      const id = String(msg.params?.id ?? '');
      const raw = await kv.kvGet(env, `report:${id}`);
      if (!raw) { out = rpcErr(msg.id, -32000, 'task not found'); break; }
      out = rpcOk(msg.id, { task: taskView(id, JSON.parse(raw)) });
      break;
    }
    default:
      out = rpcErr(msg.id, -32601, `method not found: ${msg.method}`);
  }
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
}

// REST shortcut for agents that can't do JSON-RPC: GET /a2a/tasks/:id replays
// the same task view as the tasks/get method (task id === report id).
export async function a2aTaskGet(env, kv, id) {
  const raw = await kv.kvGet(env, `report:${id}`);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'task not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ task: taskView(id, JSON.parse(raw)) }), { headers: { 'content-type': 'application/json' } });
}

// ── Embeddable widget ────────────────────────────────────────────────────
// <script src="https://checker.lazynext.com/widget.js" data-target="#el">
// mounts a scan box into #el (or a fresh <div> at script position). Shadow
// DOM keeps host styles out; the API base is derived from the script src so
// it works on workers.dev too. Pro licensees pass data-license="email".
export const WIDGET_JS = `(() => {
  const me = document.currentScript;
  const base = new URL(me.src).origin;
  const license = me.dataset.license || '';
  const host = me.dataset.target ? document.querySelector(me.dataset.target) : null;
  const mount = host || document.createElement('div');
  if (!host) me.parentNode.insertBefore(mount, me.nextSibling);
  const root = mount.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' +
    ':host{font-family:system-ui,sans-serif;font-size:14px;color:#1e293b}' +
    '.box{border:1px solid #cbd5e1;border-radius:10px;padding:14px;max-width:460px;background:#fff}' +
    'input{flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;min-width:0}' +
    'button{padding:8px 14px;border:0;border-radius:6px;background:#4338ca;color:#fff;font-size:14px;cursor:pointer}' +
    'button:disabled{opacity:.6;cursor:default}.row{display:flex;gap:8px}' +
    '.score{font-size:26px;font-weight:700;margin:10px 0 4px}.err{color:#b91c1c;margin-top:8px}' +
    'li{margin:4px 0}.rule{font-family:ui-monospace,monospace;font-size:12px;color:#4338ca}' +
    'a{color:#4338ca}ul{padding-left:18px;margin:6px 0;max-height:220px;overflow:auto}</style>' +
    '<div class="box"><div class="row"><input type="url" placeholder="https://example.com" aria-label="URL to scan">' +
    '<button>Scan</button></div><div class="out" aria-live="polite"></div>' +
    '<div style="margin-top:8px;font-size:12px;color:#64748b"><a href="' + base + '" target="_blank" rel="noopener">Accessibility Checker</a> by Lazynext</div></div>';
  const input = root.querySelector('input'), btn = root.querySelector('button'), out = root.querySelector('.out');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  btn.addEventListener('click', async () => {
    const u = input.value.trim();
    if (!/^https?:\\/\\//.test(u)) { out.innerHTML = '<div class="err">Enter a full http(s) URL.</div>'; return; }
    btn.disabled = true; btn.textContent = 'Scanning…'; out.textContent = '';
    try {
      const r = await fetch(base + '/scan', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: u, ...(license ? { license } : {}) }) });
      const d = await r.json();
      if (!r.ok) { out.innerHTML = '<div class="err">' + esc(d.error || 'scan failed') + (r.status === 402 ? ' <a href="' + base + '/checkout">Upgrade</a>' : '') + '</div>'; return; }
      const color = d.score >= 80 ? '#15803d' : d.score >= 50 ? '#b45309' : '#b91c1c';
      out.innerHTML = '<div class="score" style="color:' + color + '">' + d.score + '/100</div>' +
        '<div>' + d.issues.length + ' issue' + (d.issues.length === 1 ? '' : 's') + ' found' + (d.benchmark ? ' · better than ' + d.benchmark.pct + '% of ' + d.benchmark.sites + ' sites' : '') + (d.report ? ' · <a href="' + esc(d.report) + '" target="_blank" rel="noopener">full report</a>' : '') + '</div>' +
        '<ul>' + d.issues.slice(0, 8).map((i) => '<li><span class="rule">' + esc(i.rule) + '</span> ' + esc(i.message) + '</li>').join('') + '</ul>' +
        (d.issues.length > 8 ? '<div style="font-size:12px;color:#64748b">+ ' + (d.issues.length - 8) + ' more in the report</div>' : '');
    } catch (e) { out.innerHTML = '<div class="err">Scan failed: ' + esc(e.message || e) + '</div>'; }
    finally { btn.disabled = false; btn.textContent = 'Scan'; }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
})();
`;
