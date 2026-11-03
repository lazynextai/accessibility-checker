#!/usr/bin/env node
// Regenerate src/gh_actions_ranges.js from GitHub's published egress ranges.
//
//   node scripts/gen-gh-ranges.mjs                 # hits api.github.com/meta
//   node scripts/gen-gh-ranges.mjs --from file.json # offline / reviewable
//
// WHY A TABLE: `ci` is the one scan source the pipeline cannot learn from the
// request shape. worker.js is a protected file, so POST /scan hands runScan
// only `cf-connecting-ip` — never headers — and the caller is otherwise
// anonymous. Comparing that IP against GitHub's published Actions ranges is
// the only deterministic signal left.
//
// WHY IT IS SAFE TO LET IT GO STALE: the table is used solely to label a
// stored report (`src: "ci"`). A stale entry can only mislabel a runner as
// `web`; it never blocks a scan, never rejects a request, and never touches
// quota. Regenerate quarterly, or whenever a CI scan shows up labelled `web`.
//
// IPv6 is deliberately not included: GitHub-hosted runners egress over IPv4,
// and an IPv4-only table keeps the checked-in artifact ~10x smaller.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const META_URL = "https://api.github.com/meta";
const args = process.argv.slice(2);
const fromFlag = args.indexOf("--from");
const out = join(dirname(fileURLToPath(import.meta.url)), "../src/gh_actions_ranges.js");

const raw = fromFlag >= 0
  ? readFileSync(args[fromFlag + 1], "utf8")
  : await fetch(META_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "lazynext-gen-gh-ranges" } })
      .then((r) => {
        if (!r.ok) throw new Error(`GET ${META_URL} → HTTP ${r.status}`);
        return r.text();
      });

const meta = JSON.parse(raw);
const ranges = meta?.actions;
if (!Array.isArray(ranges) || !ranges.length) throw new Error("meta.actions missing or empty");

const toInt = (octets) => octets.reduce((n, o) => n * 256 + o, 0);
const nets = [];
for (const cidr of ranges) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr));
  if (!m) continue; // IPv6 — see header note
  const octets = [1, 2, 3, 4].map((i) => Number(m[i]));
  if (octets.some((o) => o > 255) || Number(m[5]) > 32) continue;
  const size = 2 ** (32 - Number(m[5]));
  const start = toInt(octets);
  nets.push([start, start + size - 1]);
}
nets.sort((a, b) => a[0] - b[0]);

// Merge touching/overlapping ranges so the lookup table is the smallest exact
// form: one binary search over non-overlapping pairs, no false positives.
const merged = [];
for (const [s, e] of nets) {
  const last = merged[merged.length - 1];
  if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
  else merged.push([s, e]);
}

const fetchedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const flat = merged.flat();
const perLine = 8;
const body = [];
for (let i = 0; i < flat.length; i += perLine) body.push(`  ${flat.slice(i, i + perLine).join(", ")},`);

writeFileSync(out, `// GENERATED FILE — do not edit by hand.
// Regenerate: node scripts/gen-gh-ranges.mjs  (source: ${META_URL} → actions)
//
// GitHub-hosted runner egress, IPv4 only, merged into non-overlapping inclusive
// [start, end] pairs as a flat sorted uint32 array. Sole consumer:
// src/scan_src.js \`isGitHubActionsIp()\`, which labels a scan \`ci\`. Staleness can
// only downgrade a runner's label to \`web\` — it never blocks a scan.
export const GITHUB_ACTIONS_FETCHED_AT = "${fetchedAt}";
export const GITHUB_ACTIONS_RANGES = ${merged.length};
export const GITHUB_ACTIONS_V4 = Object.freeze([
${body.join("\n")}
]);
`);

console.log(`wrote ${out}: ${merged.length} merged IPv4 ranges (${flat.length} uint32 values) from ${nets.length} CIDRs`);
