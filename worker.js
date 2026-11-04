import { RULES } from './src/rules/manifest.js';
import { monitorKey, buildMonitorRecord } from './src/monitor.js';
import { isEmail, isHttpUrl, isToken } from './src/validator.js';
import { PAGE_HTML } from './src/page.js';
import { STATIC_FILES } from './src/static.js';
import { runScan } from './src/scan_pipeline.js';
import { reportView, filterIssues, reportCsv, reportHtml } from './src/report_views.js';
import { AGENT_CARD, handleMcp, handleA2a, a2aTaskGet, WIDGET_JS } from './src/agent_surfaces.js';
import { OPENAPI } from './src/openapi.js';
import { rulesCatalogHtml } from './src/rules_catalog.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// Shared platform-KV helpers handed to runScan + the agent surfaces, so
// /scan, /mcp and /a2a enforce the same quota and persist the same reports.
const KV_OPS = { kvGet, kvPut, rlHit, isPro, planLevel, platform };

// Escape user- and scanned-page-controlled text before it lands in report HTML
// or email bodies — report URLs are shareable, so raw interpolation is stored XSS.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
}

// Single-file UI: everything is inline, and API calls stay same-origin on both
// hosts (workers.dev fetches resolve to this same script).
const UI_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; worker-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

async function platform(env, path, init = {}) {
  const r = await env.PLATFORM.fetch(new Request(`https://platform.internal${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.PLATFORM_TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) },
  }));
  return r;
}

async function kvGet(env, key) {
  const r = await platform(env, '/kv/get', { method: 'POST', body: JSON.stringify({ key }) });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return d?.value ?? null;
}

async function kvPut(env, key, value, ttl) {
  const r = await platform(env, '/kv/put', { method: 'POST', body: JSON.stringify({ key, value, ttl }) });
  if (!r.ok) throw new Error(`kv put failed: ${r.status}`);
}

async function kvDel(env, key) {
  const r = await platform(env, '/kv/delete', { method: 'POST', body: JSON.stringify({ key }) });
  if (!r.ok) throw new Error(`kv delete failed: ${r.status}`);
}

// Plan tiers: license:<email> stores the Dodo plan name. Levels gate
// entitlement depth (crawl pages, monitor cap, white-label reports).
const PLAN_LEVEL = { free: 0, pro: 1, agency: 2 };
const MONITOR_CAP = { 1: 5, 2: 50 };

async function planLevel(env, license) {
  if (!license) return 0;
  const v = await kvGet(env, `license:${String(license).toLowerCase()}`);
  return PLAN_LEVEL[v] ?? (v ? 1 : 0); // unknown paid plan names → pro-level
}

async function isPro(env, license) {
  return (await planLevel(env, license)) > 0;
}

// Per-key daily counters via platform KV. Returns true when the counter is at
// the cap; otherwise increments and returns false. Fail-open like kvGet — a
// KV outage shouldn't 503 every request.
async function rlHit(env, key, limit) {
  const used = parseInt((await kvGet(env, key)) ?? '0', 10);
  if (used >= limit) return true;
  await kvPut(env, key, String(used + 1), 90000).catch(() => {});
  return false;
}

// License = buyer email, which is guessable, so mutating license actions
// (cancel / monitor add/remove) require mailbox proof: POST creates a
// pending:<token> record and emails a confirmation link; GET /confirm
// executes it once (the token is deleted on use). 15-minute expiry.
async function requestConfirm(env, origin, email, action, extra = {}) {
  const token = crypto.randomUUID();
  await kvPut(env, `pending:${token}`, JSON.stringify({ action, email: String(email).toLowerCase(), ...extra }), 900);
  const link = `${origin}/confirm?token=${token}`;
  const label = { cancel: `cancel the Pro subscription for ${email}`, monitor_add: `start daily monitoring for ${extra.url}`, monitor_del: `stop monitoring ${extra.url}` }[action];
  const r = await platform(env, '/email/send', {
    method: 'POST',
    body: JSON.stringify({
      to: email,
      subject: `Confirm: ${label}`,
      html: `<p>Someone (hopefully you) asked to ${esc(label)}.</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes. If this wasn't you, ignore this email.</p>`,
    }),
  });
  // A 200 here tells the caller "check your email" — if Brevo/platform rejected
  // the send that's a lie; surface it as a 502 via the caller's catch.
  if (!r.ok) throw new Error(`confirmation email failed: ${r.status}`);
}

function confirmPage(title, inner, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:640px;margin:4rem auto;padding:0 1rem">
<h1>${title}</h1>${inner}
<p><a href="/">Back to Accessibility Checker</a></p>`,
    { status, headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}

// HMAC-SHA256(email, PLATFORM_TOKEN) — PLATFORM_TOKEN is the platform
// worker's API_TOKEN, so this verifies the sig embedded in unsubscribe
// links its marketing sends mint (see unsubSig in worker/src/services.ts).
// Wrong/missing sig → 403: only the real recipient can opt themselves out.
async function unsubSig(env, email) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.PLATFORM_TOKEN ?? ''),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(String(email).toLowerCase()));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // HEAD = bodyless GET on read-only surfaces (browsers, Lighthouse, uptime
    // probes all HEAD; Workers strips the response body on the wire). State-
    // changing GETs (/unsubscribe, /confirm) keep exact-match — a link
    // scanner's HEAD probe must not consume a token or flip a flag.
    const get = request.method === 'GET' || request.method === 'HEAD';

    if (get && url.pathname === '/health') {
      return respond({ ok: true, service: 'accessibility-checker' });
    }

    if (get && url.pathname === '/') {
      // Browsers (and the branded domain) get the product UI; API callers get
      // the usage doc. Same worker serves both — checker.lazynext.com is the
      // canonical surface, workers.dev/github.io stay working.
      const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html') || url.hostname === 'checker.lazynext.com';
      if (wantsHtml) {
        return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...UI_HEADERS } });
      }
      return respond({
        name: 'Accessibility Checker API',
        scan: 'POST /scan {"url"|"html", "site"?: bool, "license"?: email, "email_report"?: bool}',
        checkout: 'GET /checkout', cancel: 'POST /cancel {"license": email}',
        confirm: 'GET /confirm?token=…', monitor: 'GET|POST|DELETE /monitor (Pro)',
        lead: 'POST /lead {"email"}', report: 'GET /report/:id',
        badge: 'GET /badge/:id.svg', rules: 'GET /rules (JSON manifest · Accept: text/html → catalog)',
        openapi: 'GET /openapi.json',
        mcp: 'POST /mcp (JSON-RPC tools: scan_url, scan_html, get_report, list_rules)',
        a2a: 'POST /a2a (message/send, tasks/get) · GET /a2a/tasks/:id · GET /.well-known/agent.json',
        widget: 'GET /widget.js — <script> embed for any site',
        site: 'https://checker.lazynext.com/',
      });
    }

    // Discovery/static files — the branded domain is canonical, so crawlers
    // and security tools must find robots/sitemap/llms/security.txt here too.
    if (get) {
      // /favicon.ico is the default-probe path browsers/crawlers hit when no
      // <link rel="icon"> is honored — redirect to the real SVG icon.
      if (url.pathname === '/favicon.ico') {
        return Response.redirect(`${url.origin}/favicon.svg`, 301);
      }
      const sf = STATIC_FILES[url.pathname];
      if (sf) {
        // Binary entries embed as base64 (b64:true) — decode to bytes.
        const body = sf.b64 ? Uint8Array.from(atob(sf.body), c => c.charCodeAt(0)) : sf.body;
        return new Response(body, { headers: { 'content-type': sf.type } });
      }
    }

    // Lead capture → platform /leads → Brevo contact + D1 event.
    if (request.method === 'POST' && url.pathname === '/lead') {
      const b = await request.json().catch(() => ({}));
      if (!isEmail(b.email)) return respond({ error: 'valid email required' }, 400);
      // Per-IP daily cap: unauthenticated lead submission would otherwise let a
      // bot burn Brevo quota and fire an unsolicited sequence email per victim.
      const day = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
      const rlKey = `rl:lead:${ip}:${day}`;
      const used = parseInt((await kvGet(env, rlKey)) ?? '0', 10);
      if (used >= 10) return respond({ error: 'rate limit — try again later' }, 429);
      await kvPut(env, rlKey, String(used + 1), 90000).catch(() => {});
      const r = await platform(env, '/leads', { method: 'POST', body: JSON.stringify({ email: b.email, source: 'accessibility-checker' }) });
      const d = await r.json().catch(() => ({}));
      return respond({ ok: r.ok, ...(r.ok ? {} : { detail: d }) }, r.ok ? 200 : 502);
    }

    // Marketing-email opt-out (CAN-SPAM / GDPR / RFC 8058 one-click). POST is
    // the mailbox-provider one-click (List-Unsubscribe=One-Click body) AND the
    // human's "Yes, unsubscribe" form button — both run the same signed
    // mutation. GET renders a JS-free confirmation page and NEVER calls the
    // platform: with no method guard, a link scanner or mail-avatar prefetch
    // used to fire the mutation for someone who had merely opened the email.
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/unsubscribe') {
      const email = (url.searchParams.get('email') ?? '').toLowerCase();
      const sig = url.searchParams.get('sig') ?? '';
      const valid = isEmail(email) && sig === await unsubSig(env, email);
      if (!valid) {
        // Same 403 on both methods; never render a page that could reveal
        // whether an address is real.
        return respond({ error: 'invalid link' }, 403);
      }
      if (request.method !== 'POST') {
        // No `action` attr → the form re-POSTs this exact URL with the query
        // string (email + sig) intact. No platform call on this path.
        return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Unsubscribe from Lazynext emails</title>
<body style="font-family:system-ui;max-width:640px;margin:4rem auto;padding:0 1rem">
<h1>Unsubscribe ${esc(email)} from Lazynext emails?</h1>
<form method="post"><button type="submit">Yes, unsubscribe</button></form>
<p><a href="/">Keep my subscription</a></p>`,
          {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              // form-action 'self' is required: form-action falls back to
              // default-src, so a literal `default-src 'none'` alone would
              // block this very form's POST in browsers.
              'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
              'x-robots-tag': 'noindex',
              'cache-control': 'no-store',
            },
          });
      }
      const r = await platform(env, '/unsubscribe', { method: 'POST', body: JSON.stringify({ email }) });
      return respond({ ok: r.ok }, r.ok ? 200 : 502);
    }

    // Rule coverage manifest — every WCAG criterion the scanner can emit, with
    // name/level/version/detection path. Makes "X checks" claims verifiable.
    if (get && url.pathname === '/rules') {
      // Content negotiation: browsers get the browsable catalog, API/SDK
      // callers get the manifest JSON. Vary: Accept keeps shared caches
      // (and our own HEAD parity) from serving one variant to the other.
      const vary = { vary: 'Accept' };
      if ((request.headers.get('accept') ?? '').includes('text/html')) {
        return new Response(rulesCatalogHtml(url.origin), { headers: { 'content-type': 'text/html; charset=utf-8', ...UI_HEADERS, ...vary } });
      }
      return new Response(JSON.stringify({ count: RULES.length, rules: RULES }), { headers: { 'content-type': 'application/json', ...CORS, ...vary } });
    }

    if (get && url.pathname === '/openapi.json') {
      return respond(OPENAPI);
    }

    // Public score badge — shields-style SVG for a stored report. Scanned sites
    // embed it (linking back to the report) — the product's backlink loop.
    if (get && url.pathname.startsWith('/badge/')) {
      const id = url.pathname.slice(7).replace(/\.svg$/, '');
      const raw = await kvGet(env, `report:${id}`);
      if (!raw) return respond({ error: 'report not found or expired' }, 404);
      const rep = JSON.parse(raw);
      const score = Math.max(0, Math.min(100, Math.round(Number(rep.score) || 0)));
      const color = score >= 80 ? '#4c1' : score >= 50 ? '#dfb317' : '#e05d44';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="20" role="img" aria-label="accessibility: ${score}/100"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="150" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="87" height="20" fill="#555"/><rect x="87" width="63" height="20" fill="${color}"/><rect width="150" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="110"><text x="445" y="150" transform="scale(.1)" fill="#fff">accessibility</text><text x="1175" y="150" transform="scale(.1)">${score}/100</text></g></svg>`;
      return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }

    // Shareable report — scans persist here for 30 days.
    // Suffixes: .csv/.json exports, .pdf via platform /pdf; .json returns the
    // stored report object so SDK/CI consumers get the raw findings.
    if (get && url.pathname.startsWith('/report/')) {
      const seg = url.pathname.slice(8);
      const fmt = seg.endsWith('.csv') ? 'csv' : seg.endsWith('.pdf') ? 'pdf' : seg.endsWith('.json') ? 'json' : 'html';
      const id = fmt === 'html' ? seg : fmt === 'json' ? seg.slice(0, -5) : seg.slice(0, -4);
      const raw = await kvGet(env, `report:${id}`);
      if (!raw) return respond({ error: 'report not found or expired' }, 404);
      const rep = JSON.parse(raw);
      // Join findings against the rules manifest so reports carry the criterion
      // name and conformance level — "wcag-1.3.1 · Info and Relationships (A)"
      // tells a customer what to prioritise; a bare rule id does not.
      const ruleInfo = Object.fromEntries(RULES.map((r) => [r.rule, r]));
      // View customization (?level=, ?rule=, ?by=page) lives in report_views.js;
      // every export format honors it so an export matches the on-screen view.
      const view = reportView(url.searchParams);
      const issues = filterIssues(rep, ruleInfo, view);
      if (fmt === 'csv') {
        return new Response(reportCsv(issues, ruleInfo), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="accessibility-report-${id}.csv"`, 'cache-control': 'public, max-age=3600' } });
      }
      if (fmt === 'json') {
        return Response.json({ ...rep, issues }, { headers: { 'content-disposition': `attachment; filename="accessibility-report-${id}.json"`, 'cache-control': 'public, max-age=3600' } });
      }
      if (fmt === 'pdf') {
        const r = await platform(env, '/pdf', { method: 'POST', body: JSON.stringify({ url: `${url.origin}/report/${id}${url.search}` }) });
        if (!r.ok) return respond({ error: 'pdf export unavailable' }, 502);
        return new Response(r.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="accessibility-report-${id}.pdf"`, 'cache-control': 'public, max-age=3600' } });
      }
      // A completed scan lands here — the report is where a trial-extension
      // offer belongs. config:trial_offer (days) enables the extended CTA;
      // unset → the standard 14-day CTA.
      const offer = parseInt((await kvGet(env, 'config:trial_offer')) ?? '', 10);
      const trialDays = offer > 14 ? Math.min(offer, 90) : 0;
      return new Response(reportHtml(id, rep, issues, ruleInfo, view, url.origin, trialDays),
        { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'", 'cache-control': 'public, max-age=3600' } });
    }

    // Redirect to a real Dodo checkout via the platform. ?plan=pro|agency and
    // ?term=monthly|annual pick the tier's product (test-mode ids — recreate
    // live on flip). Extended-trial: config:trial_offer (platform KV) holds
    // the offered days; ?trial=extended applies it, capped at 90. Unset → 14.
    const CHECKOUT_PRODUCTS = {
      'pro:monthly': 'pdt_0NoEqD9VCMUZnIogq4Epy',
      'pro:annual': 'pdt_0Nofjy268m9bli5OaIXRs',
      'agency:monthly': 'pdt_0NofjSIpNGrV51Bi5nym7',
      'agency:annual': 'pdt_0Nofjy47Y9PR6pdx3KF3U',
    };
    if (get && url.pathname === '/checkout') {
      let trialDays = 14;
      if (url.searchParams.get('trial') === 'extended') {
        const offer = parseInt((await kvGet(env, 'config:trial_offer')) ?? '', 10);
        if (offer > 14) trialDays = Math.min(offer, 90);
      }
      const plan = url.searchParams.get('plan') === 'agency' ? 'agency' : 'pro';
      const term = url.searchParams.get('term') === 'annual' ? 'annual' : 'monthly';
      const r = await platform(env, '/api/v1/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ product_id: CHECKOUT_PRODUCTS[`${plan}:${term}`], plan, trial_days: trialDays }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.checkout_url) return respond({ error: 'checkout unavailable', detail: d }, 502);
      return Response.redirect(d.checkout_url, 302);
    }

    // Self-service cancellation — step 1 of 2. The license is the purchase
    // email (not a secret), so the actual cancel happens only after the
    // customer clicks the confirmation link we email them (/confirm).
    if (request.method === 'POST' && url.pathname === '/cancel') {
      const b = await request.json().catch(() => ({}));
      if (!isEmail(b.license)) return respond({ error: 'purchase email required' }, 400);
      if (!(await isPro(env, b.license))) return respond({ error: 'no active Pro license for that email' }, 404);
      // The license is a guessable email — bound confirm-email sends so a
      // stranger can't mail-bomb a licensed address via repeated POSTs.
      const cDay = new Date().toISOString().slice(0, 10);
      const cIp = request.headers.get('cf-connecting-ip') ?? 'anon';
      if (await rlHit(env, `rl:confirm:${String(b.license).toLowerCase()}:${cDay}`, 10) ||
          await rlHit(env, `rl:confirmip:${cIp}:${cDay}`, 30)) {
        return respond({ error: 'too many requests — try again tomorrow' }, 429);
      }
      try {
        await requestConfirm(env, url.origin, b.license, 'cancel');
      } catch {
        return respond({ error: 'could not create confirmation — try again shortly' }, 502);
      }
      return respond({ ok: true, confirm: 'email' });
    }

    // Executes a pending license action once the emailed link is clicked.
    if (request.method === 'GET' && url.pathname === '/confirm') {
      const token = url.searchParams.get('token') ?? '';
      const raw = isToken(token) ? await kvGet(env, `pending:${token}`) : null;
      const pend = raw ? JSON.parse(raw) : null;
      if (!pend) return confirmPage('Link expired', '<p>This confirmation link is invalid or has expired.</p>');

      if (pend.action === 'cancel') {
        const r = await platform(env, '/api/v1/billing/cancel', { method: 'POST', body: JSON.stringify({ email: pend.email }) });
        if (!r.ok) return confirmPage('Cancellation failed', '<p>Something went wrong on our side — please try again or reply to your receipt email.</p>');
        await kvDel(env, `pending:${token}`).catch(() => {});
        return confirmPage('Subscription cancelled', `<p>The Pro subscription for <b>${esc(pend.email)}</b> has been cancelled. Your license stays active until the end of the current billing period.</p>`);
      }
      if (pend.action === 'monitor_add') {
        try {
          await kvPut(env, monitorKey(pend.email, pend.url), JSON.stringify(buildMonitorRecord({ email: pend.email, url: pend.url, viewport: pend.viewport })), 0);
        } catch {
          return confirmPage('Monitoring setup failed', '<p>Something went wrong on our side — please try the confirmation link again or request a new one.</p>');
        }
        await kvDel(env, `pending:${token}`).catch(() => {});
        return confirmPage('Monitoring on', `<p><b>${esc(pend.url)}</b> will be rescanned daily — we email <b>${esc(pend.email)}</b> if the score drops.</p>`);
      }
      if (pend.action === 'monitor_del') {
        try {
          await kvDel(env, monitorKey(pend.email, pend.url));
        } catch {
          return confirmPage('Could not stop monitoring', '<p>Something went wrong on our side — please try the confirmation link again or request a new one.</p>');
        }
        await kvDel(env, `pending:${token}`).catch(() => {});
        return confirmPage('Monitoring stopped', `<p><b>${esc(pend.url)}</b> is no longer being monitored.</p>`);
      }
      return confirmPage('Link expired', '<p>This confirmation link is invalid or has expired.</p>');
    }

    if (request.method === 'POST' && url.pathname === '/scan') {
      const body = await request.json().catch(() => ({}));
      // Quota, fetch/render/crawl, scoring, report persistence, and Pro email
      // all live in the shared pipeline — /mcp and /a2a run the same code.
      const r = await runScan(env, KV_OPS, {
        url: body.url, html: body.html, site: body.site,
        license: body.license, email_report: body.email_report,
        viewport: body.viewport,
        ip: request.headers.get('cf-connecting-ip') ?? 'anon',
        origin: url.origin,
      });
      return r.ok ? respond(r.result) : respond(r.payload, r.status);
    }

    // Agent surfaces — MCP for tool-using agents, A2A for task-protocol
    // agents, /.well-known/agent.json for discovery. Scans through these run
    // the identical pipeline + quota as POST /scan.
    if (url.pathname === '/mcp') {
      return handleMcp(request, env, KV_OPS, request.headers.get('cf-connecting-ip') ?? 'anon', url.origin);
    }
    if (url.pathname === '/a2a') {
      return handleA2a(request, env, KV_OPS, request.headers.get('cf-connecting-ip') ?? 'anon', url.origin);
    }
    if (get && url.pathname.startsWith('/a2a/tasks/')) {
      return a2aTaskGet(env, KV_OPS, url.pathname.slice('/a2a/tasks/'.length));
    }
    if (get && url.pathname === '/.well-known/agent.json') {
      return respond(AGENT_CARD);
    }

    // Embeddable scan widget — <script src="/widget.js"> mounts a Shadow-DOM
    // scan form on any page; posts back to this worker's /scan.
    if (get && url.pathname === '/widget.js') {
      return new Response(WIDGET_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', ...CORS } });
    }

    // Pro site monitoring — register/unregister URLs for the platform's
    // daily rescan sweep; Brevo alerts when a page's score drops >= 10.
    // Both mutations are email-confirmed like /cancel — the license is an
    // email address, so registering under someone's email would otherwise
    // let strangers send them alerts or manage their list.
    if (url.pathname === '/monitor' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const level = await planLevel(env, b.license);
      if (!level) return respond({ error: 'pro license required', upgrade: '/checkout' }, 402);
      if (!isHttpUrl(b.url)) return respond({ error: 'provide {"url"}' }, 400);
      // Every monitor is a daily rendered rescan forever — cap scales with
      // plan level (pro 5, agency 50).
      const ml = await platform(env, '/kv/list', { method: 'POST', body: JSON.stringify({ prefix: `mon:${String(b.license).toLowerCase()}:` }) });
      const mCount = ml.ok ? ((await ml.json().catch(() => ({}))).keys ?? []).length : 0;
      const mCap = MONITOR_CAP[level] ?? MONITOR_CAP[1];
      if (mCount >= mCap) return respond({ error: `monitor limit reached (${mCap}) — remove one first` }, 429);
      const cDay = new Date().toISOString().slice(0, 10);
      const cIp = request.headers.get('cf-connecting-ip') ?? 'anon';
      if (await rlHit(env, `rl:confirm:${String(b.license).toLowerCase()}:${cDay}`, 10) ||
          await rlHit(env, `rl:confirmip:${cIp}:${cDay}`, 30)) {
        return respond({ error: 'too many requests — try again tomorrow' }, 429);
      }
      try {
        // Pin the viewport the monitor's rescans will run at — the rescan
        // sweep passes it through so baseline comparisons stay like-for-like.
        await requestConfirm(env, url.origin, b.license, 'monitor_add', { url: b.url, viewport: b.viewport === 'desktop' ? 'desktop' : 'mobile' });
      } catch {
        return respond({ error: 'could not create confirmation — try again shortly' }, 502);
      }
      return respond({ ok: true, confirm: 'email' });
    }
    if (url.pathname === '/monitor' && request.method === 'DELETE') {
      const b = await request.json().catch(() => ({}));
      if (!(await isPro(env, b.license))) return respond({ error: 'pro license required' }, 402);
      if (!b.url) return respond({ error: 'provide {"url"}' }, 400);
      const cDay = new Date().toISOString().slice(0, 10);
      const cIp = request.headers.get('cf-connecting-ip') ?? 'anon';
      if (await rlHit(env, `rl:confirm:${String(b.license).toLowerCase()}:${cDay}`, 10) ||
          await rlHit(env, `rl:confirmip:${cIp}:${cDay}`, 30)) {
        return respond({ error: 'too many requests — try again tomorrow' }, 429);
      }
      try {
        await requestConfirm(env, url.origin, b.license, 'monitor_del', { url: b.url });
      } catch {
        return respond({ error: 'could not create confirmation — try again shortly' }, 502);
      }
      return respond({ ok: true, confirm: 'email' });
    }
    if (url.pathname === '/monitor' && get) {
      const license = url.searchParams.get('license');
      if (!(await isPro(env, license))) return respond({ error: 'pro license required' }, 402);
      const r = await platform(env, '/kv/list', { method: 'POST', body: JSON.stringify({ prefix: `mon:${String(license).toLowerCase()}:` }) });
      if (!r.ok) return respond({ error: 'monitor list unavailable — try again shortly' }, 502);
      const { keys = [] } = await r.json().catch(() => ({}));
      const monitors = [];
      for (const k of keys) {
        const v = await kvGet(env, k);
        if (v) monitors.push(JSON.parse(v));
      }
      return respond({ monitors });
    }

    return respond({ error: 'not found' }, 404);
  },
};
