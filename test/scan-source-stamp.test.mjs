// Scan-source provenance stamp — the 2026-11-03 traffic audit
// (docs/research/scan-traffic-provenance-2026-11-03.md, recommendation #3)
// showed `report:*` records carried no origin, so "are these outside visitors
// or are they us?" cost hours of cadence-and-fingerprint forensics. Every scan
// now stamps a closed `src` vocabulary on the stored record; the next audit is
// a GROUP BY.
//
// Two invariants are pinned here:
//   1. the stamp lives ONLY on the stored `report:*` record — the scan
//      response (the shape the UI consumes) and the quota logic are untouched;
//   2. classification is deterministic over the closed vocabulary, with the
//      precedence surface → monitor → ci → fixture → web/unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { SCAN_SOURCES, classifyScanSource, isGitHubActionsIp, ipv4ToInt, hasClientIp } from '../src/scan_src.js';
import { GITHUB_ACTIONS_RANGES, GITHUB_ACTIONS_V4 } from '../src/gh_actions_ranges.js';

// ---------------------------------------------------------------------------
// The vocabulary is closed, exactly seven values, and nothing else is ever
// returned.
// ---------------------------------------------------------------------------
test('src vocabulary is exactly the seven documented values', () => {
  assert.deepEqual(SCAN_SOURCES, ['web', 'ci', 'monitor', 'mcp', 'a2a', 'fixture', 'unknown']);
});

test('every classification result is a member of the vocabulary', () => {
  const cases = [
    { external: true, ip: '49.205.194.4' },
    { external: true, ip: 'anon' },
    { external: false, ip: '49.205.194.4' },
    { external: true, ip: 'anon', license: 'pro@x.test' },
    { external: true, ip: '130.131.214.133' },
    { external: false, ip: '130.131.214.133' },
    { surface: 'mcp', external: false, ip: '1.2.3.4' },
    { surface: 'a2a', external: false, ip: '130.131.214.133' },
    { surface: 'bogus-surface', external: true, ip: '1.2.3.4' },
    { external: true, ip: null },
    { external: true, ip: '' },
    { external: true, ip: 'wait, an ip?', license: 'x@y.z', email_report: true },
  ];
  for (const c of cases) assert.ok(SCAN_SOURCES.includes(classifyScanSource(c)), JSON.stringify(c));
});

// ---------------------------------------------------------------------------
// Classification table — one row per vocabulary value, using the exact
// evidence from the audit (the surviving CI quota key 130.131.214.133 inside
// GitHub's 130.131.128.0/17; our egress 49.205.194.4).
// ---------------------------------------------------------------------------
test('web: external scan with a client IP from the ordinary internet', () => {
  assert.equal(classifyScanSource({ external: true, ip: '49.205.194.4' }), 'web');
});

test('web wins over monitor when a licensed scan carries a real IP', () => {
  assert.equal(classifyScanSource({ external: true, ip: '49.205.194.4', license: 'pro@x.test' }), 'web');
});

test('ci: caller IP inside GitHub Actions egress ranges (the audit runner)', () => {
  assert.equal(classifyScanSource({ external: true, ip: '130.131.214.133' }), 'ci');
});

test('ci wins over fixture: our own CI canary scanning checker.lazynext.com', () => {
  // benchHost returns null for our own domains, but the mechanism — a GitHub
  // runner — is still the strongest signal. Without this precedence the canary
  // would blur into fixture traffic.
  assert.equal(classifyScanSource({ external: false, ip: '130.131.214.133' }), 'ci');
});

test('monitor: licensed caller with no client IP (A11Y service binding)', () => {
  assert.equal(classifyScanSource({ external: true, ip: 'anon', license: 'support@lazynext.com' }), 'monitor');
  assert.equal(classifyScanSource({ external: false, ip: 'anon', license: 'support@lazynext.com' }), 'monitor');
});

test('monitor does not fire for a user asking for an emailed report or a site crawl', () => {
  assert.equal(classifyScanSource({ external: true, ip: 'anon', license: 'pro@x.test', email_report: true }), 'unknown');
  assert.equal(classifyScanSource({ external: true, ip: 'anon', license: 'pro@x.test', site: true }), 'unknown');
});

test('monitor requires a license — an anonymous internal scan is unknown', () => {
  assert.equal(classifyScanSource({ external: true, ip: 'anon' }), 'unknown');
});

test('mcp/a2a surfaces override host and IP signals', () => {
  assert.equal(classifyScanSource({ surface: 'mcp', external: false, ip: '49.205.194.4' }), 'mcp');
  assert.equal(classifyScanSource({ surface: 'a2a', external: false, ip: '130.131.214.133' }), 'a2a');
});

test('fixture: target cannot be an outside visitor site (pasted HTML, reserved, ours)', () => {
  assert.equal(classifyScanSource({ external: false, ip: '49.205.194.4' }), 'fixture');
  assert.equal(classifyScanSource({ external: false, ip: 'anon', license: null }), 'fixture');
});

test('unknown: external target, no client IP, no license', () => {
  assert.equal(classifyScanSource({ external: true, ip: 'anon' }), 'unknown');
  assert.equal(classifyScanSource({ external: true, ip: null }), 'unknown');
  assert.equal(classifyScanSource({ external: true, ip: '' }), 'unknown');
});

test('unknown surface strings fall back to web, they never leak into the stamp', () => {
  assert.equal(classifyScanSource({ surface: 'widget', external: true, ip: '1.2.3.4' }), 'web');
});

// ---------------------------------------------------------------------------
// IP helpers + generated GitHub table sanity.
// ---------------------------------------------------------------------------
test('hasClientIp treats worker.js\' "anon" fallback and blanks as absent', () => {
  assert.equal(hasClientIp('49.205.194.4'), true);
  assert.equal(hasClientIp('ANON'), false);
  assert.equal(hasClientIp(''), false);
  assert.equal(hasClientIp(null), false);
  assert.equal(hasClientIp(undefined), false);
});

test('ipv4ToInt parses dotted quads and rejects junk', () => {
  assert.equal(ipv4ToInt('0.0.0.0'), 0);
  assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
  assert.equal(ipv4ToInt('130.131.214.133'), ((130 << 24) + (131 << 16) + (214 << 8) + 133) >>> 0);
  assert.equal(ipv4ToInt('1.2.3.256'), null);
  assert.equal(ipv4ToInt('anon'), null);
  assert.equal(ipv4ToInt('2606:4700::1111'), null);
  assert.equal(ipv4ToInt(123), null);
});

test('the generated GitHub table is sorted, non-overlapping and matches its header', () => {
  assert.equal(GITHUB_ACTIONS_V4.length, GITHUB_ACTIONS_RANGES * 2);
  let prev = -1;
  for (let i = 0; i < GITHUB_ACTIONS_V4.length; i += 2) {
    const s = GITHUB_ACTIONS_V4[i];
    const e = GITHUB_ACTIONS_V4[i + 1];
    assert.ok(s <= e, `range ${i / 2} inverted`);
    assert.ok(s > prev, `range ${i / 2} unsorted or overlapping`);
    prev = e;
  }
});

test('GitHub Actions IP detection: the audit runner in, our egress and public DNS out', () => {
  // 130.131.214.133 is the surviving v1 quota key from the audit, inside the
  // published 130.131.128.0/17 actions range.
  assert.equal(isGitHubActionsIp('130.131.214.133'), true);
  assert.equal(isGitHubActionsIp('49.205.194.4'), false, 'founder egress must not label ci');
  assert.equal(isGitHubActionsIp('8.8.8.8'), false);
  assert.equal(isGitHubActionsIp('1.2.3.4'), false);
  assert.equal(isGitHubActionsIp('anon'), false);
  assert.equal(isGitHubActionsIp('2606:4700::1111'), false, 'IPv6 is a documented non-goal');
});

// ---------------------------------------------------------------------------
// End-to-end: the stamp lands on the stored report:* record and nowhere else.
// ---------------------------------------------------------------------------
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

const RENDER = { '/render': async () => Response.json({ html: '<html><body><h1>x</h1></body></html>', styles: [], facts: {}, focus: [], focusable: 1 }) };
const NO_STATS = { '/query': async (req) => {
  const b = await req.json();
  if (/INSERT INTO scan_stats/.test(b.sql)) return Response.json({ success: true });
  return Response.json({ results: [{ t: 0, below: 0 }] });
} };

const post = (path, body, opts = {}, env = mockEnv()) =>
  worker.fetch(new Request(`https://checker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...opts }), env);

const storedReport = (kv) => {
  const key = Object.keys(kv).find((k) => k.startsWith('report:'));
  assert.ok(key, 'report should be persisted');
  return { key, record: JSON.parse(kv[key]) };
};

test('e2e: /scan stamps web on the record, keeps it out of the response', async () => {
  const kv = {};
  const env = mockEnv(kv, { ...RENDER, ...NO_STATS });
  const r = await post('/scan', { url: 'https://acme-shop.com' }, { headers: { 'content-type': 'application/json', 'cf-connecting-ip': '49.205.194.4' } }, env);
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal('src' in d, false, 'the scan response shape is behavior-parity fixed');
  const { record } = storedReport(kv);
  assert.equal(record.src, 'web');
  assert.equal(record.url, 'https://acme-shop.com');
});

test('e2e: /scan from a GitHub runner IP stamps ci even for our own domain', async () => {
  const kv = {};
  const env = mockEnv(kv, { ...RENDER, ...NO_STATS });
  const r = await post('/scan', { url: 'https://checker.lazynext.com' }, { headers: { 'content-type': 'application/json', 'cf-connecting-ip': '130.131.214.133' } }, env);
  assert.equal(r.status, 200);
  assert.equal(storedReport(kv).record.src, 'ci');
});

test('e2e: /scan with no client IP and a license stamps monitor (the sweep)', async () => {
  const kv = { 'license:pro@x.test': 'pro' };
  const env = mockEnv(kv, { ...RENDER, ...NO_STATS });
  const r = await post('/scan', { url: 'https://acme-shop.com', license: 'pro@x.test' }, { headers: { 'content-type': 'application/json' } }, env);
  assert.equal(r.status, 200);
  assert.equal(storedReport(kv).record.src, 'monitor');
});

test('e2e: /scan external URL with no IP and no license stamps unknown', async () => {
  const kv = {};
  const env = mockEnv(kv, { ...RENDER, ...NO_STATS });
  const r = await post('/scan', { url: 'https://acme-shop.com' }, { headers: { 'content-type': 'application/json' } }, env);
  assert.equal(r.status, 200);
  assert.equal(storedReport(kv).record.src, 'unknown');
});

test('e2e: pasted-HTML and reserved-domain scans stamp fixture', async () => {
  for (const body of [{ html: '<img src=a>' }, { url: 'https://example.com' }, { url: 'http://localhost:9/callback' }]) {
    const kv = {};
    const env = mockEnv(kv, body.html !== undefined ? {} : { ...RENDER, ...NO_STATS });
    const r = await post('/scan', body, { headers: { 'content-type': 'application/json', 'cf-connecting-ip': '49.205.194.4' } }, env);
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(storedReport(kv).record.src, 'fixture');
  }
});

test('e2e: MCP scan_url stamps mcp regardless of the scanned host', async () => {
  const kv = {};
  const env = mockEnv(kv, { ...RENDER, ...NO_STATS });
  const r = await post('/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'scan_url', arguments: { url: 'https://example.com' } },
  }, { headers: { 'content-type': 'application/json', 'cf-connecting-ip': '49.205.194.4' } }, env);
  assert.equal(r.status, 200);
  assert.equal(storedReport(kv).record.src, 'mcp');
});

test('e2e: A2A message/send stamps a2a', async () => {
  const kv = {};
  const env = mockEnv(kv, { ...RENDER, ...NO_STATS });
  const r = await post('/a2a', {
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: { parts: [{ type: 'text', text: 'scan https://example.com please' }] } },
  }, { headers: { 'content-type': 'application/json', 'cf-connecting-ip': '49.205.194.4' } }, env);
  assert.equal(r.status, 200);
  assert.equal(storedReport(kv).record.src, 'a2a');
});

test('e2e: the free quota is byte-for-byte unchanged — 3/day per IP, 4th is 402', async () => {
  const kv = {};
  const env = mockEnv(kv, { ...RENDER, ...NO_STATS });
  // A license scan would hit the 100/day pro cap first — stay free (no license).
  const ip = '9.9.9.9';
  const h = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
  for (let i = 0; i < 3; i++) {
    const r = await post('/scan', { url: 'https://acme-shop.com' }, { headers: h }, env);
    assert.equal(r.status, 200, `scan ${i + 1} should succeed`);
  }
  const fourth = await post('/scan', { url: 'https://acme-shop.com' }, { headers: h }, env);
  assert.equal(fourth.status, 402);
  assert.match((await fourth.json()).error, /free limit reached/);
  // The reports that did land carry the stamp — quota rejection writes nothing.
  const reports = Object.keys(kv).filter((k) => k.startsWith('report:'));
  assert.equal(reports.length, 3);
  for (const k of reports) assert.equal(JSON.parse(kv[k]).src, 'web');
});