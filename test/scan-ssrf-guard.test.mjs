// Route-level SSRF coverage for the product worker: POST /scan (the surface
// the platform's daily monitor sweep re-enters through) must reject
// private/link-local/metadata hosts with 400 BEFORE the platform /render is
// called, while a normal public URL still renders and scores. The pipeline
// guard covers /scan + MCP scan_url + A2A tasks/send in one pinch point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function mockEnv(kv = {}, handlers = {}) {
  const renderCalls = [];
  return {
    renderCalls,
    PLATFORM_TOKEN: 'test-token',
    PLATFORM: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/render') {
          renderCalls.push(req);
          if (handlers['/render']) return handlers['/render'](req);
        }
        if (handlers[path]) return handlers[path](req);
        if (path === '/kv/get') {
          const b = await req.json();
          return Response.json({ value: kv[b.key] ?? null });
        }
        if (path === '/kv/list') {
          const b = await req.json();
          return Response.json({ keys: Object.keys(kv).filter((k) => k.startsWith(b.prefix ?? '')) });
        }
        if (path === '/kv/put') {
          const b = await req.json();
          kv[b.key] = b.value;
          return Response.json({ ok: true });
        }
        return Response.json({ ok: true });
      },
    },
  };
}

const RENDER_OK = {
  '/render': async () => Response.json({
    html: '<html lang="en"><body><main><h1>Hi</h1><a href="/x">x</a></main></body></html>',
    styles: [], facts: {}, focus: ['a'], focusable: 1, escape: true, viewport: 'mobile',
  }),
};

const post = (path, body, env = mockEnv()) =>
  worker.fetch(new Request(`https://checker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);

test('POST /scan rejects cloud metadata literal without calling /render', async () => {
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, RENDER_OK);
  const r = await post('/scan', { url: 'http://[::ffff:169.254.169.254]/latest/meta-data', license: 'pro@x.test' }, env);
  const d = await r.json();
  assert.equal(r.status, 400);
  assert.match(d.error, /host not allowed/);
  assert.equal(env.renderCalls.length, 0, '/render must never be called for a blocked host');
});

test('POST /scan rejects dotted metadata and private hosts with 400', async () => {
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, RENDER_OK);
  const r = await post('/scan', { url: 'http://169.254.169.254/latest/meta-data', license: 'pro@x.test' }, env);
  assert.equal(r.status, 400);
  const r2 = await post('/scan', { url: 'http://127.0.0.1:9/', license: 'pro@x.test' }, env);
  assert.equal(r2.status, 400);
  const r3 = await post('/scan', { url: 'http://192.168.1.1/', license: 'pro@x.test' }, env);
  assert.equal(r3.status, 400);
  assert.equal(env.renderCalls.length, 0);
});

test('POST /scan rejects a blocked host before consuming the daily quota', async () => {
  // Free tier: a blocked host must not burn one of the 3/day scans.
  const kv = { 'rl:scan:1.2.3.4:2026-01-01': '2' };
  const env = mockEnv(kv, RENDER_OK);
  const r = await post('/scan', { url: 'http://169.254.169.254/latest/meta-data' }, env);
  assert.equal(r.status, 400);
  await post('/scan', { url: 'http://169.254.169.254/latest/meta-data' }, env);
  // Still allowed a normal scan — quota was not consumed by blocked hosts.
  const r3 = await post('/scan', { url: 'https://acme-shop.com' }, env);
  assert.equal(r3.status, 200);
});

test('POST /scan site=true rejects a blocked start URL without crawling', async () => {
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, RENDER_OK);
  const r = await post('/scan', { url: 'http://[::ffff:169.254.169.254]/latest/meta-data', site: true, license: 'pro@x.test' }, env);
  assert.equal(r.status, 400);
  assert.equal(env.renderCalls.length, 0);
});

test('POST /scan accepts a normal public URL and renders it', async () => {
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, RENDER_OK);
  const r = await post('/scan', { url: 'https://acme-shop.com', license: 'pro@x.test' }, env);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.rendered, true);
  assert.equal(env.renderCalls.length, 1, 'exactly one render call for the public URL');
  const reqBody = JSON.parse(await env.renderCalls[0].text());
  assert.ok(reqBody.url.startsWith('https://acme-shop.com'), 'render receives the public URL');
});

test('MCP scan_url inherits the pipeline guard', async () => {
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, RENDER_OK);
  const r = await worker.fetch(new Request('https://checker.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scan_url', arguments: { url: 'http://[::ffff:169.254.169.254]/latest/meta-data' } } }),
  }), env);
  assert.equal(r.status, 200); // JSON-RPC envelope survives
  const d = await r.json();
  const tc = d.result?.structuredContent ?? {};
  assert.match(String(tc.error ?? ''), /host not allowed/, 'MCP tool call must surface a blocked-host error');
  assert.equal(env.renderCalls.length, 0);
});