// Regression guard: the product repo must not land unimported root-level JS.
//
// Motivated by product PR #118 (lazynextai/accessibility-checker#118), opened by
// the autonomous fleet on 2026-11-07. It added two root-level files:
//
//   api.js    — fetch('https://workers.dev/api/kpis'), a host that does not exist
//   script.js — wrote into #user-acquisition / #revenue-growth, IDs absent from
//               the product
//
// Nothing imported either file. CI still went 4/4 green because `node --test`
// only discovers `test/**` and `*.test.*` files, so a root-level `foo.js` is
// never executed — and the product's route surface never references it either.
// The PR was closed as dead code, but nothing stopped the next one.
//
// This guard makes the repo's root JS inventory explicit. Every root-level
// `*.js` file must be EITHER:
//   1. reachable — referenced from worker.js, index.html, src/**, another test,
//      or the packager list in scripts/sync-page.mjs; or
//   2. self-serving — fetched directly by URL at runtime (a service worker,
//      embeddable widget, …), which no import edge can ever express. Each such
//      file needs a documented allowlist entry with the serving evidence.
//
// The allowlist is verified too (test 3), so an exemption cannot rot into a
// silent hole after the route that served it is removed.
//
// Dependency-free on purpose: Node builtins only (`node:fs`, `node:path`,
// `node:test`, `node:assert`), so it runs under bare `node --test`.
//
// Deliberately NOT implemented: scanning README/docs prose. A filename quoted in
// documentation is not wiring, and treating it as such would let an orphan hide
// behind a sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);

// The worker entry point (a protected file). Cloudflare's `main` — it is invoked
// by the runtime, not imported by another module, so it is the root of the
// reachability graph rather than a candidate orphan.
const ENTRY_POINTS = new Set(['worker.js']);

// Root-level JS that is legitimate with no import edge because it is fetched
// directly by URL at runtime. Each entry is checked in test 3 — if the serving
// route disappears, the exemption must be deleted, not left in place.
const SELF_SERVING = new Map([
  [
    'sw.js',
    'service worker fetched by URL at runtime: index.html registers it via navigator.serviceWorker.register("sw.js"); scripts/sync-page.mjs packs it into src/static.js as the "/sw.js" route, which worker.js serves from STATIC_FILES. Nothing imports a service worker — the browser loads it by path — so no import edge can exist.',
  ],
]);

/** Recursively collect `.js`/`.mjs` files under `dir`. */
function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Build a reference matcher for a basename. The leading character class
 * (`"`, `'`, backtick, `/`) makes this a *path-shaped* reference — an import
 * specifier, a `src=`/route string, or a fetch URL — instead of any occurrence
 * of the word in prose. The trailing `\b` keeps `script.js` from matching
 * `script.json` or `script.jsx`.
 */
function referencePattern(basename) {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`["'\`/](?:\\./)*${escaped}\\b`);
}

/** Every file that could plausibly wire a module into the product. */
function referenceCorpus() {
  const paths = [
    join(ROOT, 'worker.js'),
    join(ROOT, 'index.html'),
    join(ROOT, 'scripts', 'sync-page.mjs'),
    ...collectFiles(join(ROOT, 'src')),
    ...collectFiles(join(ROOT, 'test')),
  ].filter((p) => p !== SELF);

  return paths.map((p) => ({ path: p.replace(ROOT + '/', ''), content: readFileSync(p, 'utf8') }));
}

/** Root-level `*.js` files that the entry-point exclusion does not cover. */
function rootJsCandidates() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.js$/.test(e.name) && !ENTRY_POINTS.has(e.name))
    .map((e) => e.name)
    .sort();
}

/** Which of `candidates` are referenced from any corpus file. */
function referencedCandidates(candidates) {
  const corpus = referenceCorpus();
  const referenced = new Set();
  for (const name of candidates) {
    const re = referencePattern(name);
    if (corpus.some((f) => re.test(f.content))) referenced.add(name);
  }
  return referenced;
}

/** Root-level JS files that are neither reachable nor documented self-serving. */
function findOrphans() {
  const candidates = rootJsCandidates();
  const referenced = referencedCandidates(candidates);
  return candidates.filter((name) => !referenced.has(name) && !SELF_SERVING.has(name));
}

const WHY_IT_MATTERS =
  'not imported by any entry point, so CI cannot exercise it; delete it or wire it into worker.js/index.html';

test('root-level JS is reachable from an entry point (no orphan files)', () => {
  const orphans = findOrphans();

  assert.deepEqual(
    orphans.map((name) => `${name}: ${WHY_IT_MATTERS}`),
    [],
    [
      'Unimported root-level JS in the product repo:',
      '',
      ...orphans.map((name) => `  ${name}\n    ${WHY_IT_MATTERS}`),
      '',
      'Bare `node --test` only discovers `test/**` and `*.test.*`, so a root-level file is',
      'never executed, and the worker\'s route surface never references it either — CI can',
      'be green while dead or broken code sits in the repo root (that is exactly PR #118).',
      '',
      'Wire the file in (import it from worker.js/a src/ module, reference it from',
      'index.html, or add it to scripts/sync-page.mjs), or — if it is fetched directly by',
      'URL at runtime — add a documented SELF_SERVING entry in this test.',
    ].join('\n'),
  );
});

// Positive control: the guard must be trustworthy on the repo as it stands, not
// theoretical. PR #118 was closed without merging, so `main` ships zero orphans
// today. This also fails if the reference corpus itself breaks (a bad path would
// silently make every file look unreachable — or, worse, hide a real orphan).
test('positive control: the real repo currently has no orphan root-level JS', () => {
  const candidates = rootJsCandidates();
  assert.ok(
    candidates.length > 0,
    'expected at least one root-level non-entry JS file (sw.js) — corpus/root scan is broken',
  );

  const corpus = referenceCorpus();
  const corpusNames = corpus.map((f) => f.path);
  for (const required of ['worker.js', 'index.html', 'scripts/sync-page.mjs']) {
    assert.ok(
      corpusNames.includes(required),
      `reference corpus is missing ${required} — the reachability scan would be lying`,
    );
  }

  const orphans = findOrphans();
  const referenced = referencedCandidates(candidates);
  assert.deepEqual(
    orphans,
    [],
    [
      `Orphan root-level JS present: ${orphans.join(', ')}`,
      `Root inventory: ${candidates.join(', ')}`,
      `Referenced: ${[...referenced].join(', ') || '(none)'}`,
      `Self-serving allowlist: ${[...SELF_SERVING.keys()].join(', ') || '(none)'}`,
    ].join('\n'),
  );

  // Every non-entry root file is accounted for by real wiring or a documented
  // exemption — nothing passes by accident.
  for (const name of candidates) {
    assert.ok(
      referenced.has(name) || SELF_SERVING.has(name),
      `${name} is neither referenced nor explicitly exempt`,
    );
  }
});

// An exemption must stay true. If the route that served an allowlisted file is
// removed, the file becomes an ordinary orphan and this test tells you to drop
// the entry instead of letting the allowlist cover for a dead file forever.
test('self-serving allowlist entries are still served and still exist', () => {
  const servingSurface = [
    join(ROOT, 'worker.js'),
    join(ROOT, 'src', 'static.js'),
    join(ROOT, 'src', 'openapi.js'),
    join(ROOT, 'scripts', 'sync-page.mjs'),
  ].map((p) => ({ path: p.replace(ROOT + '/', ''), content: readFileSync(p, 'utf8') }));

  for (const [name, reason] of SELF_SERVING) {
    assert.ok(reason.trim().length >= 40, `${name}: SELF_SERVING entry needs a real explanation`);

    const rootFiles = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    assert.ok(
      rootFiles.includes(name),
      `${name} is in SELF_SERVING but does not exist at the repo root — remove the stale entry`,
    );

    const re = referencePattern(name);
    const served = servingSurface.filter((f) => re.test(f.content)).map((f) => f.path);
    assert.ok(
      served.length > 0,
      `${name} is allowlisted as self-serving but is no longer referenced by any serving file ` +
        `(${servingSurface.map((f) => f.path).join(', ')}) — the exemption has rotted; ` +
        `delete the file or remove the SELF_SERVING entry`,
    );
  }
});
