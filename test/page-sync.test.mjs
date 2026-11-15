import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_HTML } from '../src/page.js';
import { STATIC_FILES } from '../src/static.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const readB64 = (p) => readFileSync(new URL(`../${p}`, import.meta.url)).toString('base64');
const indexHtml = read('index.html');
const uiOverrides = read('ui-overrides.css').trim();
const expectedPage = indexHtml.includes('id="lz-ui-overrides"')
  ? indexHtml
  : indexHtml.replace(
      '</head>',
      `<style id="lz-ui-overrides">\n${uiOverrides}\n</style>\n</head>`,
    );

// The worker serves PAGE_HTML + STATIC_FILES on checker.lazynext.com and to
// browsers hitting GET /. If a repo file changes without regenerating
// (node scripts/sync-page.mjs), this test fails — the embedded bundle can
// never silently diverge from the Pages-deployed copies.
// PAGE_HTML = index.html + injected ui-overrides.css (index.html is protected).
test('src/page.js is in sync with index.html + ui-overrides.css', () => {
  assert.equal(PAGE_HTML, expectedPage);
});

test('PAGE_HTML injects viewport contrast override without editing index.html', () => {
  assert.equal(indexHtml.includes('id="lz-ui-overrides"'), false);
  assert.match(PAGE_HTML, /id="lz-ui-overrides"/);
  assert.match(PAGE_HTML, /select#viewport/);
  assert.match(PAGE_HTML, /#6b7280/);
});

test('src/static.js is in sync with the repo static files', () => {
  for (const [route, sf] of Object.entries(STATIC_FILES)) {
    assert.equal(sf.body, sf.b64 ? readB64(route.slice(1)) : read(route.slice(1)), `${route} drifted`);
  }
});

test('manifest.json and manifest.webmanifest stay identical', () => {
  assert.equal(read('manifest.json'), read('manifest.webmanifest'));
  assert.equal(STATIC_FILES['/manifest.json'].body, STATIC_FILES['/manifest.webmanifest'].body);
});

test('branded-domain canonical link is present in the UI', () => {
  assert.match(indexHtml, /canonical" href="https:\/\/checker\.lazynext\.com/);
});
