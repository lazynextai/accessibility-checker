// Regression guard: production `src/` must never ship phantom test artifacts.
//
// Motivated by product PR #111 (Lazynext-AI/accessibility-checker#111), a
// third-attempt fabrication of the retired mobile-scanning class. It added
// `src/mobileTests.js` whose imports cannot even resolve (`node:fetch` does
// not exist; `node:test` has no `expect` export), used a placeholder domain,
// and its key assertion could never fail. CI was vacuously green because bare
// `node --test` only discovers `test/**` and `*.test.js`/`*.spec.js` — the junk
// file was invisible to the suite — yet `scripts/deploy.mjs` globs every
// `src/*.js` into the production bundle, so it WOULD have shipped.
//
// This guard enforces three invariants over every `.js`/`.mjs` under `src/`:
//   1. no `import ... from 'node:test'` or `import ... from 'node:fetch'`;
//   2. no `require('node:test')` or `require('node:fetch')`;
//   3. no destructured `expect` import from a `node:` module.
//   4. no `// File: src/...` claim line at the top of a file that lacks a
//      trailing newline (the phantom marker signature from PR #111).
//
// Dependency-free on purpose: Node builtins only (`node:fs`, `node:path`,
// `node:test`, `node:assert`), so it runs under bare `node --test`.
//
// Deliberately NOT implemented: a "test count must increase" check. That is
// impossible to assert from a unit test (the suite has no memory of prior
// runs), so that half of the original recommendation is skipped on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');

// Import/require signatures proven in PR #111's fabrication.
const IMPORT_NODE_SPECIFIER = /from\s*['"]node:(?:test|fetch)['"]/;
const REQUIRE_NODE_SPECIFIER = /require\(\s*['"]node:(?:test|fetch)['"]\s*\)/;
const IMPORT_EXPECT_FROM_NODE =
  /import\s*\{[^}]*\bexpect\b[^}]*\}\s*from\s*['"]node:[^'"]*['"]/;

/** Recursively collect every `.js`/`.mjs` file under `dir`. */
function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test('src/ ships no phantom test-file signatures', () => {
  const violations = [];
  const offenders = [];

  for (const file of collectSourceFiles(SRC)) {
    const rel = file.replace(ROOT + '/', '');
    const content = readFileSync(file, 'utf8');
    const reasons = [];

    if (IMPORT_NODE_SPECIFIER.test(content)) {
      reasons.push(
        'imports a `node:test`/`node:fetch` specifier (cannot resolve in production)',
      );
    }
    if (REQUIRE_NODE_SPECIFIER.test(content)) {
      reasons.push(
        'requires `node:test`/`node:fetch` (cannot resolve in production)',
      );
    }
    if (IMPORT_EXPECT_FROM_NODE.test(content)) {
      reasons.push(
        'destructures `expect` from a `node:` module (no such export exists)',
      );
    }
    const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
    if (/^\/\/ File: src\//.test(firstLine) && !content.endsWith('\n')) {
      reasons.push(
        'starts with a `// File: src/...` claim line but has no trailing newline (phantom marker signature)',
      );
    }

    if (reasons.length > 0) {
      offenders.push(rel);
      violations.push(`${rel}\n    - ${reasons.join('\n    - ')}`);
    }
  }

  assert.deepEqual(
    offenders.length,
    0,
    [
      'Phantom test-file signatures found in src/ (these would ship to production via scripts/deploy.mjs):',
      ...violations,
      '',
      'Fix: delete the offending file(s) or rewrite them as real production code.',
    ].join('\n'),
  );
});