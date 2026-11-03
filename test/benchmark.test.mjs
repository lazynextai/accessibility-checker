// Benchmark/stats coverage — real-site scans record a scan_stats row and
// report a percentile against the corpus; pasted HTML, test hosts, and our
// own domains record nothing. Stats failures must never break a scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function mockEnv(kv = {}, handlers = {}) {
  return {
    PLATFORM_TOKEN: 'test-token',
    PLATFORM: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
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

const post = (path, body, opts = {}, env = mockEnv()) =>
  worker.fetch(new Request(`https://checker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...opts }), env);

const RENDER = { '/render': async () => Response.json({ html: '<html><body><h1>x</h1></body></html>', styles: [], facts: {}, focus: [], focusable: 1 }) };

// /query stub: SELECT returns a canned corpus count; INSERT captures params.
const statsHandlers = (corpus, calls = []) => ({
  '/query': async (req) => {
    const b = await req.json();
    calls.push(b);
    if (/INSERT INTO scan_stats/.test(b.sql)) return Response.json({ success: true });
    return Response.json({ results: [corpus] });
  },
});

test('URL scan reports benchmark and records stats when corpus >= 10', async () => {
  const calls = [];
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, { ...RENDER, ...statsHandlers({ t: 20, below: 14 }, calls) });
  const r = await post('/scan', { url: 'https://acme-shop.com', license: 'pro@x.test' }, {}, env);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(d.benchmark, { pct: 70, sites: 20 });
  const ins = calls.find((c) => /INSERT INTO scan_stats/.test(c.sql));
  assert.ok(ins, 'expected a scan_stats insert');
  assert.equal(ins.params[3], 'acme-shop.com');
  assert.equal(ins.params[2], 1); // pro flag
  // The percentile must count each site once — rescans pad scan_stats rows
  // but not the corpus. The SELECT dedups to the latest score per host.
  const sel = calls.find((c) => /FROM scan_stats/.test(c.sql));
  assert.match(sel.sql, /GROUP BY host/i);
});

test('benchmark hidden while corpus is below MIN_BENCH_SITES; row still recorded', async () => {
  const calls = [];
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, { ...RENDER, ...statsHandlers({ t: 5, below: 3 }, calls) });
  const r = await post('/scan', { url: 'https://acme-shop.com', license: 'pro@x.test' }, {}, env);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.benchmark, undefined);
  assert.ok(calls.some((c) => /INSERT INTO scan_stats/.test(c.sql)), 'stats row should still be recorded');
});

test('scan survives a dead /query endpoint — no benchmark, still returns findings', async () => {
  const env = mockEnv({ 'license:pro@x.test': 'pro' }, {
    ...RENDER,
    '/query': async () => new Response('boom', { status: 500 }),
  });
  const r = await post('/scan', { url: 'https://acme-shop.com', license: 'pro@x.test' }, {}, env);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.benchmark, undefined);
  assert.ok(Array.isArray(d.issues));
  assert.ok(d.report); // report persistence unaffected
});

test('pasted-HTML scans never touch scan_stats', async () => {
  const calls = [];
  const env = mockEnv({}, statsHandlers({ t: 50, below: 10 }, calls));
  const r = await post('/scan', { html: '<img src=a>' }, {}, env);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
});

test('test/operator hosts are excluded from the benchmark corpus', async () => {
  for (const u of [
    'https://x.test',
    'https://lazynext.com',
    'https://checker.lazynext.com',
    'https://blog.lazynext.com',
    'https://lazynext.github.io',
    'https://lazynext-landing.github.io',
    'https://lazynext-ai.github.io/accessibility-checker/',
    'https://ai-company-os.dry-hall-6a50.workers.dev',
    'https://example.com',
    'https://shop.example.org',
    'https://10.0.0.5',
    'http://localhost:8080',
  ]) {
    const calls = [];
    const env = mockEnv({ 'license:pro@x.test': 'pro' }, { ...RENDER, ...statsHandlers({ t: 50, below: 10 }, calls) });
    const r = await post('/scan', { url: u, license: 'pro@x.test' }, {}, env);
    assert.equal(r.status, 200, u);
    assert.equal(calls.filter((c) => /scan_stats/.test(c.sql)).length, 0, u);
  }
});

test('malformed hostnames from pasted URL lists never enter the corpus', async () => {
  // `isHttpUrl` only checks the scheme and URL parsing accepts `)` and `,`,
  // so these reached the corpus before the strict hostname gate (audit
  // 2026-11-03: rows like `...workers.dev)` and `wellknown.network),`).
  for (const u of [
    'https://agent-forum.agent-forum-worker.workers.dev),',
    'https://wellknown.network),',
    'https://trailing-comma.com,',
    'https://paren.example-shop.com)',
  ]) {
    const calls = [];
    const env = mockEnv({ 'license:pro@x.test': 'pro' }, { ...RENDER, ...statsHandlers({ t: 50, below: 10 }, calls) });
    const r = await post('/scan', { url: u, license: 'pro@x.test' }, {}, env);
    assert.equal(r.status, 200, u);
    assert.equal(calls.filter((c) => /scan_stats/.test(c.sql)).length, 0, u);
  }
});

test('a genuinely external host still enters the corpus with its bare hostname', async () => {
  for (const [u, host] of [
    ['https://www.corpusiq.io/pricing?utm=1', 'www.corpusiq.io'],
    ['https://sub.acme-shop.co.uk.', 'sub.acme-shop.co.uk'],
  ]) {
    const calls = [];
    const env = mockEnv({ 'license:pro@x.test': 'pro' }, { ...RENDER, ...statsHandlers({ t: 50, below: 10 }, calls) });
    const r = await post('/scan', { url: u, license: 'pro@x.test' }, {}, env);
    assert.equal(r.status, 200, u);
    const ins = calls.find((c) => /INSERT INTO scan_stats/.test(c.sql));
    assert.ok(ins, `expected a scan_stats insert for ${u}`);
    assert.equal(ins.params[3], host);
  }
});

test('stored report carries the benchmark block', async () => {
  const kv = { 'license:pro@x.test': 'pro' };
  const env = mockEnv(kv, { ...RENDER, ...statsHandlers({ t: 30, below: 6 }) });
  const r = await post('/scan', { url: 'https://acme-shop.com', license: 'pro@x.test' }, {}, env);
  assert.equal(r.status, 200);
  const key = Object.keys(kv).find((k) => k.startsWith('report:'));
  assert.ok(key, 'report should be persisted');
  const rep = JSON.parse(kv[key]);
  assert.deepEqual(rep.benchmark, { pct: 20, sites: 30 });
});
