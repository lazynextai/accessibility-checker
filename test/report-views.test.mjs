// Report-view customization tests — ?level=, ?rule=, ?by=page on /report/:id
// plus filter parity across the CSV, JSON, and PDF export legs.
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
        return Response.json({ ok: true });
      },
    },
  };
}

const get = (path, opts = {}, env = mockEnv()) =>
  worker.fetch(new Request(`https://checker.test${path}`, { method: 'GET', ...opts }), env);

// Two findings: one A-level (wcag-1.1.1), one AA-level (wcag-1.3.5).
const rep = {
  url: 'https://x', ts: 0, score: 70, rendered: false,
  issues: [
    { rule: 'wcag-1.1.1', message: '<img> missing alt', url: 'https://x/a' },
    { rule: 'wcag-1.3.5', message: 'input missing autocomplete', url: 'https://x/b' },
  ],
};

test('GET /report/:id renders the view nav with level counts', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v', {}, env)).text();
  assert.match(html, /All \(2\)/);
  assert.match(html, /A \(1\)/);
  assert.match(html, /AA \(1\)/);
  assert.match(html, /Group by page/);
});

test('?level= filters findings to one conformance level', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v?level=A', {}, env)).text();
  assert.ok(html.includes('wcag-1.1.1'), 'A-level finding shown');
  assert.ok(!html.includes('input missing autocomplete'), 'AA finding hidden');
  assert.match(html, /showing 1 of 2/);
});

test('?level= ignores values outside A/AA/AAA', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v?level=BOGUS', {}, env)).text();
  assert.ok(html.includes('wcag-1.1.1') && html.includes('wcag-1.3.5'), 'all findings shown');
});

test('?rule= renders a single-criterion deep link and clear affordance', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v?rule=wcag-1.1.1', {}, env)).text();
  assert.ok(html.includes('missing alt'));
  assert.ok(!html.includes('autocomplete'), 'other rules hidden');
  assert.match(html, /rule wcag-1\.1\.1/);
  assert.match(html, />clear</);
});

test('?rule= with no matches explains the empty view', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v?rule=wcag-9.9.9', {}, env)).text();
  assert.match(html, /No findings match this view/);
  assert.match(html, /show all 2/);
});

test('?by=page groups findings under their page URL', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v?by=page', {}, env)).text();
  assert.match(html, /https:\/\/x\/a <span[^>]*>\(1\)/);
  assert.match(html, /https:\/\/x\/b <span[^>]*>\(1\)/);
  assert.match(html, /Ungroup/);
});

test('?by=page composes with ?level=', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v?by=page&level=AA', {}, env)).text();
  assert.ok(!html.includes('missing alt'), 'A-level page group absent');
  assert.match(html, /https:\/\/x\/b/);
});

test('rule ids link into single-rule views preserving other params', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v?by=page', {}, env)).text();
  assert.ok(html.includes('/report/v?rule=wcag-1.1.1&amp;by=page'), 'rule deep-link keeps by=page');
});

test('CSV export honors the same filters', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const csv = await (await get('/report/v.csv?level=A', {}, env)).text();
  assert.ok(csv.includes('wcag-1.1.1'));
  assert.ok(!csv.includes('wcag-1.3.5'), 'filtered row absent from CSV');
});

test('JSON export returns the stored report with filtered issues', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const r = await get('/report/v.json?level=A', {}, env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const body = await r.json();
  assert.equal(body.score, 70, 'report metadata preserved');
  assert.equal(body.issues.length, 1, 'filter applied to issues array');
  assert.equal(body.issues[0].rule, 'wcag-1.1.1');
  // Unfiltered .json returns the full stored issue list.
  const full = await (await get('/report/v.json', {}, env)).json();
  assert.equal(full.issues.length, 2);
});

test('PDF export forwards the view params to the render URL', async () => {
  let pdfUrl = null;
  const env = mockEnv(
    { 'report:v': JSON.stringify(rep) },
    { '/pdf': async (req) => { pdfUrl = (await req.json()).url; return new Response('PDF', { status: 200 }); } },
  );
  const r = await get('/report/v.pdf?level=A&by=page', {}, env);
  assert.equal(r.status, 200);
  assert.equal(pdfUrl, 'https://checker.test/report/v?level=A&by=page');
});

test('unfiltered zero-issue report keeps the plain empty state', async () => {
  const env = mockEnv({ 'report:z': JSON.stringify({ url: 'https://x', ts: 0, score: 100, rendered: false, issues: [] }) });
  const html = await (await get('/report/z', {}, env)).text();
  assert.match(html, /No issues found/);
});

test('report embeds wrap the long badge snippet so tiny screens do not overflow', async () => {
  const env = mockEnv({ 'report:v': JSON.stringify(rep) });
  const html = await (await get('/report/v', {}, env)).text();
  // The badge-embed <code> carries word-break so a long snippet cannot
  // push the page wider than the viewport on narrow phones (regression:
  // 339px code block overflowed a 320px viewport).
  assert.match(html, /<code style="user-select:all;word-break:break-all">/);
  // Issue + page-group surfaces harden long URLs the same way.
  assert.match(html, /style="word-break:break-word;overflow-wrap:anywhere"/);
  assert.match(html, /word-break:break-all/);
});
