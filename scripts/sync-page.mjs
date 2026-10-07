// Regenerate src/page.js + src/static.js from the repo's static files.
// The worker embeds the UI + discovery files (served on checker.lazynext.com
// and for browsers hitting GET /); the repo files are the single source of
// truth for that bundle.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
writeFileSync(new URL('src/page.js', root),
  `// GENERATED from index.html — regenerate after UI edits: node scripts/sync-page.mjs\nexport const PAGE_HTML = ${JSON.stringify(html)};\n`);

const files = {
  '/robots.txt': 'text/plain; charset=utf-8',
  '/sitemap.xml': 'application/xml; charset=utf-8',
  '/llms.txt': 'text/plain; charset=utf-8',
  '/favicon.svg': 'image/svg+xml',
  '/.well-known/security.txt': 'text/plain; charset=utf-8',
  '/.well-known/glama.json': 'application/json',
  '/manifest.json': 'application/manifest+json',
  '/sw.js': 'application/javascript; charset=utf-8',
  '/targets.html': 'text/html; charset=utf-8',
  '/targets2.html': 'text/html; charset=utf-8',
  '/trap.html': 'text/html; charset=utf-8',
  '/trap2.html': 'text/html; charset=utf-8',
  '/partial-obscured.html': 'text/html; charset=utf-8',
  '/nav-a.html': 'text/html; charset=utf-8',
  '/nav-b.html': 'text/html; charset=utf-8',
  '/shadow.html': 'text/html; charset=utf-8',
  '/focusable-trap.html': 'text/html; charset=utf-8',
  '/focusable-clean.html': 'text/html; charset=utf-8',
  '/pointer-only.html': 'text/html; charset=utf-8',
};
const binaryFiles = {
  '/og.png': 'image/png',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
  '/icon-maskable-512.png': 'image/png',
};
const entries = Object.entries(files).map(([route, type]) => {
  const body = readFileSync(new URL(route.slice(1), root), 'utf8');
  return `  ${JSON.stringify(route)}: { type: ${JSON.stringify(type)}, body: ${JSON.stringify(body)} },`;
});
for (const [route, type] of Object.entries(binaryFiles)) {
  const body = readFileSync(new URL(route.slice(1), root)).toString('base64');
  entries.push(`  ${JSON.stringify(route)}: { type: ${JSON.stringify(type)}, b64: true, body: ${JSON.stringify(body)} },`);
}
writeFileSync(new URL('src/static.js', root),
  `// GENERATED from the repo's static files — regenerate after edits: node scripts/sync-page.mjs\nexport const STATIC_FILES = {\n${entries.join('\n')}\n};\n`);

console.log('src/page.js + src/static.js regenerated');
