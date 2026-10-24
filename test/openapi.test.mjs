// Structural checks on the OpenAPI document — keeps the hand-maintained spec
// honest: every route the worker exposes is declared, every $ref resolves,
// and every operation documents its responses. Runs entirely in-process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPENAPI } from '../src/openapi.js';
import worker from '../worker.js';

const env = { PLATFORM_TOKEN: 't', PLATFORM: { fetch: async () => Response.json({ ok: true }) } };
const get = (path, headers = {}) => worker.fetch(new Request(`https://checker.test${path}`, { headers }), env);

test('spec is a valid OpenAPI 3.1 document', () => {
  assert.equal(OPENAPI.openapi, '3.1.0');
  assert.ok(OPENAPI.info?.title);
  assert.ok(Array.isArray(OPENAPI.servers) && OPENAPI.servers.length >= 1);
  assert.ok(OPENAPI.paths && typeof OPENAPI.paths === 'object');
  assert.ok(OPENAPI.components?.schemas);
});

test('every worker route is represented in the spec', () => {
  // Route literals lifted from worker.js source — a route added there without
  // a spec entry fails here. startsWith prefixes map to their template paths.
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  const literals = [...src.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]);
  const prefixes = { '/badge/': '/badge/{id}.svg', '/report/': '/report/{id}', '/a2a/tasks/': '/a2a/tasks/{id}' };
  const covered = new Set(Object.keys(OPENAPI.paths));
  for (const p of literals) {
    if (p === '/favicon.ico' || p.startsWith('/.well-known/security') || ['/robots.txt', '/sitemap.xml'].includes(p)) continue; // discovery files served from STATIC_FILES
    assert.ok(covered.has(p), `route ${p} missing from openapi.json`);
  }
  for (const m of src.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)) {
    const specPath = prefixes[m[1]];
    assert.ok(specPath, `startsWith route ${m[1]} has no spec mapping in this test`);
    assert.ok(covered.has(specPath), `route ${specPath} missing from openapi.json`);
  }
});

test('all $refs resolve to declared schemas', () => {
  const refs = new Set();
  JSON.stringify(OPENAPI, (k, v) => {
    if (k === '$ref' && typeof v === 'string') refs.add(v);
    return v;
  });
  for (const ref of refs) {
    const name = ref.replace('#/components/schemas/', '');
    assert.ok(OPENAPI.components.schemas[name], `unresolved $ref: ${ref}`);
  }
});

test('every operation documents at least one response', () => {
  for (const [path, item] of Object.entries(OPENAPI.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      assert.ok(op.summary, `${method.toUpperCase()} ${path} has no summary`);
      assert.ok(op.responses && Object.keys(op.responses).length > 0, `${method.toUpperCase()} ${path} has no responses`);
    }
  }
});

test('GET /openapi.json serves the spec', async () => {
  const r = await get('/openapi.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const d = await r.json();
  assert.equal(d.openapi, '3.1.0');
  assert.ok(d.paths['/scan'].post);
});

test('GET /rules serves JSON by default and the HTML catalog to browsers', async () => {
  const api = await get('/rules');
  assert.match(api.headers.get('content-type'), /application\/json/);
  const m = await api.json();
  assert.equal(m.rules.length, m.count);
  assert.equal(api.headers.get('vary'), 'Accept');

  const html = await get('/rules', { accept: 'text/html' });
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.equal(html.headers.get('vary'), 'Accept');
  const body = await html.text();
  assert.match(body, /Detection coverage/);
  assert.match(body, /Perceivable/);
  assert.match(body, /Best practices/);
  assert.match(body, /bp-visible-controls/);
  // Count claim mirrors the manifest — no hardcoded numbers to rot.
  const wcag = m.rules.filter((r) => r.level !== 'BP').length;
  assert.match(body, new RegExp(`${wcag} WCAG success criteria`));
});

test('HEAD on the new surfaces routes like GET', async () => {
  // The Workers runtime strips the body on the wire for HEAD — in-process
  // fetch still carries it, so assert status + headers, not emptiness.
  for (const [p, type] of [['/openapi.json', /application\/json/], ['/rules', /text\/html/]]) {
    const r = await worker.fetch(new Request(`https://checker.test${p}`, { method: 'HEAD', headers: { accept: 'text/html' } }), env);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), type);
  }
});

test('security schemes are declared and every gated operation references one', () => {
  const schemes = OPENAPI.securitySchemes || OPENAPI.components?.securitySchemes;
  assert.ok(schemes, 'securitySchemes must be declared');
  const names = new Set(Object.keys(schemes));
  for (const n of ['LicenseEmail', 'ConfirmToken', 'UnsubscribeSig']) {
    assert.ok(names.has(n), `missing security scheme ${n}`);
  }
  // Any operation that declares security must reference a declared scheme, and
  // carry no unsupported scope names (apiKey schemes have none).
  let gated = 0;
  for (const [path, item] of Object.entries(OPENAPI.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters' || !op.security) continue;
      gated += 1;
      for (const req of op.security) {
        for (const [name, scopes] of Object.entries(req)) {
          assert.ok(names.has(name), `${method.toUpperCase()} ${path} references undeclared scheme ${name}`);
          assert.deepEqual(scopes, [], `${name} is apiKey — scopes must be empty`);
        }
      }
    }
  }
  assert.equal(gated, 7, 'expected 7 gated operations: GET/POST/DELETE /monitor, POST /cancel, GET /confirm, GET/POST /unsubscribe');
});

test('sensitive mutations are never documented as unauthenticated', () => {
  const must = [
    ['/monitor', 'delete'], ['/monitor', 'post'], ['/monitor', 'get'],
    ['/cancel', 'post'], ['/confirm', 'get'],
    ['/unsubscribe', 'get'], ['/unsubscribe', 'post'],
  ];
  for (const [path, method] of must) {
    const op = OPENAPI.paths[path]?.[method];
    assert.ok(op, `${method} ${path} missing`);
    assert.ok(Array.isArray(op.security) && op.security.length > 0,
      `${method.toUpperCase()} ${path} performs a state change and must declare security`);
  }
});

test('public compute endpoints stay explicitly anonymous (no phantom auth)', () => {
  // These are gated by IP quota / nothing at all — adding a security
  // requirement here would be a lie that breaks SDK autogeneration.
  for (const [path, method] of [['/scan', 'post'], ['/rules', 'get'], ['/health', 'get'], ['/mcp', 'post'], ['/a2a', 'post'], ['/lead', 'post']]) {
    const op = OPENAPI.paths[path]?.[method];
    assert.ok(op, `${method} ${path} missing`);
    assert.equal(op.security, undefined, `${method.toUpperCase()} ${path} must not claim auth it doesn't have`);
  }
});
