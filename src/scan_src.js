// Scan source provenance — a coarse, privacy-safe label for WHY a scan ran.
//
// A stored `report:*` record used to carry only the scanned URL, so the
// 2026-11-03 traffic audit (docs/research/scan-traffic-provenance-2026-11-03.md)
// had to rebuild provenance by hand from cadence, payload fingerprints and CI
// run logs — hours of work to answer one question: are these outside visitors
// or are they us? Recommendation #3 of that audit is to stamp the origin at
// write time so the next audit is a GROUP BY.
//
// Closed vocabulary, seven values, no free text and no client identifiers:
//
//   web      forward-facing scan through the product UI / public POST /scan
//   ci       CI runner — the caller IP is inside GitHub's published Actions
//            ranges (./gh_actions_ranges.js). Covers our own canary and any
//            integrator running the published GitHub Action on hosted runners.
//   monitor  the platform's daily Pro monitor rescan: the only licensed caller
//            that reaches us with no client IP (it arrives over the A11Y
//            service binding, while worker.js falls back to 'anon' for any
//            request without cf-connecting-ip).
//   mcp      the MCP tool surface (POST /mcp)
//   a2a      the A2A task surface (POST /a2a)
//   fixture  the target is not a measurable outside site — pasted HTML, IANA
//            reserved domains, localhost/bare IPs, our own hosts, malformed
//            hostnames. Exactly "benchHost() === null", so `fixture` and the
//            platform's `scans_external_30d` predicate agree by construction.
//   unknown  an external target we could not attribute (no client IP, no
//            license) — the honest bucket for a service-binding caller that is
//            not the monitor sweep.
//
// This is provenance metadata, NOT an access control: the label is written to a
// 30-day KV record and is deliberately kept out of the scan response, so the
// report shape the UI/report pages consume and the quota logic are untouched.
import { GITHUB_ACTIONS_V4 } from './gh_actions_ranges.js';

export const SCAN_SOURCES = Object.freeze(['web', 'ci', 'monitor', 'mcp', 'a2a', 'fixture', 'unknown']);

// Surfaces that call runScan. Anything else means a caller that predates this
// parameter, i.e. the /scan route.
const SURFACE_SOURCES = new Set(['web', 'mcp', 'a2a']);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// worker.js passes `cf-connecting-ip ?? 'anon'` — 'anon' therefore means "no
// client IP on this request", which on Cloudflare only happens for internal
// service-binding calls (every request from the internet carries the header).
export function hasClientIp(ip) {
  return typeof ip === 'string' && ip.trim() !== '' && ip.trim().toLowerCase() !== 'anon';
}

/** Dotted-quad → uint32, or null when `ip` is not an IPv4 literal. */
export function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

/**
 * True when `ip` falls inside a GitHub Actions egress range. Binary search over
 * the generated, merged, non-overlapping pair table — no false positives by
 * construction. IPv6 and malformed values are false (see the generator note:
 * hosted runners egress over IPv4).
 */
export function isGitHubActionsIp(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const t = GITHUB_ACTIONS_V4;
  let lo = 0;
  let hi = t.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (n < t[mid * 2]) hi = mid - 1;
    else if (n > t[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Classify one scan. Order matters and is deliberate:
 *   1. surface (mcp/a2a) — the route is unambiguous, so it wins even when the
 *      scanned target is a fixture host;
 *   2. monitor — before `ci`, because an internal caller never has a public IP;
 *   3. ci — before `fixture`, so the CI canary scanning our own domain is still
 *      labelled `ci` rather than lumped in with fixture traffic;
 *   4. fixture — target cannot be an outside visitor's site;
 *   5. web / unknown — an external target, attributed or not.
 *
 * @param {{surface?: string, external?: boolean, ip?: string|null, license?: unknown,
 *          email_report?: unknown, site?: unknown}} scan
 */
export function classifyScanSource({ surface = 'web', external = true, ip = null, license = null, email_report = null, site = null } = {}) {
  const s = SURFACE_SOURCES.has(surface) ? surface : 'web';
  if (s === 'mcp') return 'mcp';
  if (s === 'a2a') return 'a2a';
  if (!hasClientIp(ip) && !!license && email_report !== true && site !== true) return 'monitor';
  if (isGitHubActionsIp(ip)) return 'ci';
  if (!external) return 'fixture';
  if (!hasClientIp(ip)) return 'unknown';
  return 'web';
}
