// Shared scan pipeline — the quota checks, fetch/crawl/scan stages, scoring,
// and report persistence every scan surface runs through. Extracted from the
// /scan handler so MCP and A2A get identical quota + findings semantics
// instead of a divergent copy.
import { scanHtml, checkContrast, checkFacts, checkFocus, score } from './scanner.js';
import { scanAdditionalHtml, checkContrastAAA, checkUseOfColor, scanKeyboardStatics } from './rules/additional.js';
import { scanWcag22 } from './rules/wcag22.js';
import { section508Report } from './rules/section508.js';
import { withRecommendations } from './recommendations.js';
import { checkCrossPages } from './rules/crosspage.js';
import { crawlSite } from './crawl.js';
import { checkFocusDepth } from './rules/focuscycle.js';
import { isHttpUrl, withinBytes } from './validator.js';
import { classifyScanSource } from './scan_src.js';

const FREE_LIMIT = 3; // rendered scans per IP per day
const MIN_BENCH_SITES = 10; // below this a percentile means nothing — hide it

// Hosts excluded from the benchmark corpus: our own domains and fixtures
// would skew the distribution (the stored report corpus is overwhelmingly
// our own E2E scans), reserved TLDs never resolve publicly, and bare IPs
// aren't comparable "sites" (almost always internal infra).
//
// The hostname must also pass a strict DNS shape before any of that is even
// considered. URL parsing does NOT reject `)` or `,` — they are not WHATWG
// forbidden host code points — so pasting a comma-separated URL list leaked
// rows like `agent-forum.agent-forum-worker.workers.dev)` and
// `wellknown.network),` into the corpus (see
// docs/research/scan-traffic-provenance-2026-11-03.md). A hostname that fails
// this regex is not a site: at least one dot, ASCII alphanumerics and hyphens
// only, every label 1-63 chars starting and ending alphanumeric.
//
// The platform worker mirrors this rule in `worker/src/scanprovenance.ts`
// (benchHost) so the funnel can tell outside traffic from ours; the two are
// pinned together by a parity test. Change the rule in BOTH places.
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const benchHost = (u) => {
  // No URL at all = pasted-HTML scan: it has no site, so it must never enter
  // the "distinct real sites" corpus.
  if (typeof u !== 'string' || !u || !/^https?:\/\//i.test(u)) return null;
  let h;
  try { h = new URL(u).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  if (!h || h.length > 253 || h.includes(':') || !HOSTNAME_RE.test(h)) return null;
  if (h === 'localhost' ||
      h === 'lazynext.com' || h.endsWith('.lazynext.com') ||
      h === 'workers.dev' || h.endsWith('.workers.dev') ||
      h.endsWith('.github.io') ||
      h === 'example.com' || h.endsWith('.example.com') ||
      h === 'example.org' || h.endsWith('.example.org') ||
      h === 'example.net' || h.endsWith('.example.net') ||
      /\.(test|invalid|local|internal|lan|example)$/.test(h) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  return h;
};

// Append a throwaway query param so edge caches (cf-cache-status HIT serves
// stale HTML for hours on cached sites) can't feed a scan yesterday's page —
// a scanner must measure the page as it is now. Wire URL only; stored/report
// URLs stay clean. Fragment-safe.
const cacheBust = (u) => {
  const h = u.indexOf("#");
  const base = h === -1 ? u : u.slice(0, h);
  return `${base}${base.includes("?") ? "&" : "?"}_lz=${Date.now()}${h === -1 ? "" : u.slice(h)}`;
};

// Run a scan through the full pipeline. `kv` supplies the platform-side
// helpers (kvGet/kvPut/rlHit/isPro/platform fetch) so this module stays
// worker-runtime free and unit-testable. `origin` is the report-link host.
//
// Returns { ok: true, result, pro, rendered } or
//         { ok: false, status, payload }  — map payload onto the HTTP/JSON-RPC
// surface unchanged.
export async function runScan(env, kv, { url, html, site, license, email_report, viewport, ip, origin, surface }) {
  const level = await kv.planLevel(env, license); // 0 free / 1 pro / 2 agency
  const pro = level > 0;
  const planName = level >= 2 ? 'agency' : pro ? 'pro' : 'free';
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = `rl:scan:${ip}:${day}`;
  if (!pro && url) {
    const used = parseInt((await kv.kvGet(env, rlKey)) ?? '0', 10);
    if (used >= FREE_LIMIT) {
      return { ok: false, status: 402, payload: { error: 'free limit reached (3/day)', upgrade: '/checkout' } };
    }
    await kv.kvPut(env, rlKey, String(used + 1), 90000).catch(() => {});
  }
  // Licensed scans still cost real Browser-Rendering time — a leaked Pro
  // email would otherwise let a script run unlimited renders on our bill.
  // 100/day/IP is effectively unlimited for a human and fatal for a bot.
  if (pro && url && await kv.rlHit(env, `rl:pro:${ip}:${day}`, 100)) {
    return { ok: false, status: 429, payload: { error: 'daily scan quota exceeded — try again tomorrow' } };
  }
  // Per-license companion cap: a leaked key rotated across IPs slips past
  // the per-IP limit, so the license itself carries a 500/day ceiling —
  // far above any human seat, fatal for a farmed key.
  if (pro && url && license && await kv.rlHit(env, `rl:prokey:${license}:${day}`, 500)) {
    return { ok: false, status: 429, payload: { error: 'daily scan quota exceeded — try again tomorrow' } };
  }

  // Rendered scans run at a mobile handset profile by default — "desktop"
  // opts back to the pre-mobile baseline render. Recorded per result so
  // reports and monitors can compare like-for-like.
  const vpMode = viewport === 'desktop' ? 'desktop' : 'mobile';

  let issues = [];
  let rendered = false;
  let renderError = null;
  let renderedViewport = null;
  let sitePages = null;

  if (isHttpUrl(url) && site === true) {
    // Site-wide scan: BFS same-origin pages, apply the HTML ruleset to
    // each, aggregate with per-page attribution. Free: 3, Pro: 10,
    // Agency: 25.
    const maxPages = level >= 2 ? 25 : pro ? 10 : 3;
    try {
      const crawl = await crawlSite(url, { maxPages, delayMs: 150 });
      sitePages = crawl.pages.map((p) => {
        const pageIssues = scanHtml(p.html)
          .concat(scanAdditionalHtml(p.html))
          .concat(scanWcag22(p.html))
          .concat(scanKeyboardStatics(p.html));
        return { url: p.url, score: score(pageIssues), issues: pageIssues };
      });
      issues = sitePages.flatMap((p) => p.issues.map((i) => ({ ...i, url: p.url })))
        .concat(checkCrossPages(crawl.pages));
      if (!sitePages.length) return { ok: false, status: 502, payload: { error: 'no pages could be crawled', skipped: crawl.skipped } };
    } catch (e) {
      return { ok: false, status: 502, payload: { error: 'site crawl failed', detail: String(e?.message ?? e) } };
    }
  } else if (isHttpUrl(url)) {
    try {
      const r = await kv.platform(env, '/render', { method: 'POST', body: JSON.stringify({ url: cacheBust(url), viewport: vpMode }) });
      if (!r.ok) throw new Error(`render ${r.status}`);
      const page = await r.json();
      // Older render builds carry no viewport echo — they rendered desktop.
      renderedViewport = page.viewport === 'mobile' || page.viewport === 'desktop' ? page.viewport : 'desktop';
      issues = scanHtml(page.html)
        .concat(scanAdditionalHtml(page.html))
        .concat(scanWcag22(page.html))
        .concat(checkContrast(page.styles))
        .concat(checkContrastAAA(page.styles))
        .concat(checkUseOfColor(page.styles))
        .concat(checkFacts(page.facts))
        .concat(checkFocus(page.focus, page.focusable, page.pointerOnly, page.pointerOnlyDesc))
        .concat(checkFocusDepth(page.focus, page.focusable, page.escape, { undersized: page.undersized, undersizedAAA: page.undersizedAAA, obscured: page.obscured, obscuredPartial: page.obscuredPartial, noFocusInd: page.noFocusInd, nontextContrast: page.nontextContrast, spacingClip: page.spacingClip, backtrace: page.backtrace, clickTraps: page.clickTraps }))
        .concat(scanKeyboardStatics(page.html));
      rendered = true;
    } catch (e) {
      renderError = String(e?.message ?? e);
      const page = await fetch(cacheBust(url)).then((x) => x.text()).catch(() => '');
      issues = scanHtml(page).concat(scanAdditionalHtml(page)).concat(scanWcag22(page)).concat(scanKeyboardStatics(page));
    }
  } else if (typeof html === 'string' && html.trim()) {
    if (!withinBytes(html, 512_000)) return { ok: false, status: 413, payload: { error: 'html too large (512KB max)' } };
    issues = scanHtml(html).concat(scanAdditionalHtml(html)).concat(scanWcag22(html)).concat(scanKeyboardStatics(html));
  } else {
    return { ok: false, status: 400, payload: { error: 'provide {"url"} or {"html"}' } };
  }

  issues = withRecommendations(issues);
  const result = { score: sitePages ? Math.round(sitePages.reduce((t, p) => t + p.score, 0) / sitePages.length) : score(issues), score_model: 'weighted-v1', issues, rendered, plan: planName, section508: section508Report(issues), ...(renderedViewport ? { viewport: renderedViewport } : {}), ...(renderError ? { render_error: renderError } : {}), ...(sitePages ? { site: true, pages: sitePages.map(({ url, score: s, issues: i }) => ({ url, score: s, count: i.length })) } : {}) };

  // Score benchmark — every real-site scan feeds a scan_stats row on the
  // platform, and the result reports where this score lands against that
  // corpus. The corpus is deliberately not seeded from stored reports
  // (they are internal E2E scans of our own sites and would fabricate the
  // distribution); it fills with real usage. Under MIN_BENCH_SITES there is
  // nothing honest to claim, so the field stays absent. Queried before this
  // scan's own row lands, so a scan never counts itself. The percentile is
  // per distinct site: GROUP BY host + MAX(created_at) makes each host
  // contribute only its latest score (rescans don't pad the corpus).
  const statHost = isHttpUrl(url) ? benchHost(url) : null;
  // Provenance stamp — computed from the caller surface/ip and whether the
  // target is an outside site. Deliberately added ONLY to the stored record,
  // not the response: the scan result shape is behaviour-parity fixed.
  const src = classifyScanSource({ surface, external: statHost !== null, ip, license, email_report, site });
  if (statHost) {
    try {
      const r = await kv.platform(env, '/query', { method: 'POST', body: JSON.stringify({ sql: 'SELECT COUNT(*) t, COALESCE(SUM(s < ?),0) below FROM (SELECT score AS s, MAX(created_at) FROM scan_stats WHERE host IS NOT NULL GROUP BY host)', params: [result.score] }) });
      const d = r.ok ? await r.json() : null;
      const t = d?.results?.[0]?.t ?? 0;
      if (t >= MIN_BENCH_SITES) result.benchmark = { pct: Math.round((100 * (d.results[0].below ?? 0)) / t), sites: t };
    } catch { /* stats unavailable — the scan itself is unaffected */ }
  }

  // Persist a shareable report (30d) and optionally email it for Pro. If the
  // platform KV write fails, still return the scan — just without a report
  // URL (a link that 404s is worse than no link). The scan_stats row lands
  // in parallel — stats must never outrank or break the scan result.
  const id = crypto.randomUUID().slice(0, 12);
  const statWrite = statHost
    ? kv.platform(env, '/query', { method: 'POST', body: JSON.stringify({ sql: 'INSERT INTO scan_stats (score, pages, pro, host) VALUES (?,?,?,?)', params: [result.score, sitePages?.length ?? 1, pro ? 1 : 0, statHost] }) }).catch(() => {})
    : Promise.resolve();
  try {
    await Promise.all([
      statWrite,
      (async () => {
        await kv.kvPut(env, `report:${id}`, JSON.stringify({ ...result, url: url ?? null, ts: Date.now(), src }), 2592000);
        result.report = `${origin}/report/${id}`;
      })(),
    ]);
  } catch {
    result.report_error = 'report persistence unavailable';
  }
  if (pro && email_report) {
    await kv.platform(env, '/email/send', {
      method: 'POST',
      body: JSON.stringify({
        to: license,
        subject: `Accessibility report: ${String(url ?? 'pasted HTML').slice(0, 120)} — score ${result.score}/100`,
        html: `<p>Score: <b>${result.score}/100</b> (${result.issues.length} issues, rendered: ${rendered})</p>${result.report ? `<p>Full report: <a href="${result.report}">${result.report}</a></p>` : '<p>Shareable report link is temporarily unavailable — re-run the scan to generate one.</p>'}`,
      }),
    });
  }
  return { ok: true, result, pro, rendered };
}
