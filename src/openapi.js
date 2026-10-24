// OpenAPI 3.1 description of the REST surface, served at GET /openapi.json.
// Hand-maintained alongside worker.js — test/openapi.test.mjs asserts every
// route the worker exposes is represented here, so the spec can't silently
// drift behind the implementation.

const err = (d) => ({
  description: d,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});
const json = (schema, d = 'OK') => ({
  description: d,
  content: { 'application/json': { schema } },
});

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Lazynext Accessibility Checker API',
    version: '1.0.0',
    description: [
      'WCAG 2.1/2.2 accessibility scanning: rendered single-page checks,',
      'whole-site crawls, daily score monitoring, and shareable reports.',
      '',
      'All endpoints also answer HEAD (identical headers, no body). Errors are',
      '`{"error": string}` JSON. Quotas: free scans are limited to 3 rendered',
      'scans per IP per day; a Pro `license` (purchase email) raises that to',
      '100/day/IP plus a 500/day per-license ceiling.',
      '',
      'Agent surfaces (MCP JSON-RPC, A2A) run the same scan pipeline and quota;',
      'see `docs/agent-protocols.md` and `/.well-known/agent.json`.',
    ].join('\n'),
    'x-repo': 'https://github.com/Lazynext-AI/accessibility-checker',
  },
  servers: [
    { url: 'https://api.lazynext.com', description: 'API host' },
    { url: 'https://checker.lazynext.com', description: 'brand host (same worker)' },
  ],
  paths: {
    '/': {
      get: {
        summary: 'Service descriptor or product UI',
        description: 'API callers (`Accept` without `text/html`) get a JSON usage doc; browsers — and every request on `checker.lazynext.com` — get the single-page product UI.',
        responses: {
          '200': {
            description: 'JSON descriptor or HTML UI depending on Accept/host',
            content: {
              'application/json': { schema: { type: 'object', additionalProperties: { type: 'string' } } },
              'text/html': { schema: { type: 'string' } },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        summary: 'Liveness probe',
        responses: { '200': json({ type: 'object', properties: { ok: { type: 'boolean' }, service: { type: 'string' } }, required: ['ok', 'service'] }) },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'This OpenAPI document',
        responses: { '200': json({ type: 'object' }) },
      },
    },
    '/rules': {
      get: {
        summary: 'Detection coverage manifest',
        description: 'Every rule the scanner can emit, with WCAG criterion, conformance level, version, and detection method (`static` markup, `rendered` live-trace, or `crosspage` site-scan). JSON by default; `Accept: text/html` returns a browsable catalog (responses vary on `Accept`).',
        responses: {
          '200': {
            description: 'Rule manifest (JSON) or human-readable catalog (HTML)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RuleManifest' } },
              'text/html': { schema: { type: 'string' } },
            },
          },
        },
      },
    },
    '/scan': {
      post: {
        summary: 'Scan a page or site for WCAG issues',
        description: 'Provide `url` (public http/https page — rendered via headless browser at a mobile 390×844 viewport by default; `viewport: "desktop"` opts out) or raw `html` (static rules only). `site: true` crawls same-origin pages — 3 pages free, 10 Pro. Free URL scans consume the 3/day/IP quota; `html` scans do not. A Pro `license` email unlocks higher limits, deeper crawls, and `email_report`.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ScanRequest' } } },
        },
        responses: {
          '200': json({ $ref: '#/components/schemas/ScanResult' }),
          '400': err('Provide `{"url"}` or `{"html"}`'),
          '402': err('Free limit reached (3/day) — `upgrade` points at /checkout'),
          '413': err('`html` larger than 512KB'),
          '429': err('Daily scan quota exceeded (Pro IP or license ceiling)'),
          '502': err('Page fetch/crawl failed — `detail` carries the reason'),
        },
      },
    },
    '/report/{id}': {
      get: {
        summary: 'Shareable report (HTML)',
        description: 'Reports persist for 30 days. Append `.csv`, `.json`, or `.pdf` to the id for export formats (`.json` returns the stored report object with the filtered `issues` list — the machine-readable export for SDK/CI consumers). `level` (A|AA|AAA|BP) and `rule` (e.g. `wcag-1.4.3`) filter findings identically across formats; `by=page` groups findings under their page in the HTML and PDF views (CSV/JSON stay flat).',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'level', in: 'query', schema: { type: 'string', enum: ['A', 'AA', 'AAA', 'BP'] } },
          { name: 'rule', in: 'query', schema: { type: 'string' } },
          { name: 'by', in: 'query', schema: { type: 'string', enum: ['page'] } },
        ],
        responses: {
          '200': {
            description: 'Report in the requested format',
            content: {
              'text/html': { schema: { type: 'string' } },
              'text/csv': { schema: { type: 'string' } },
              'application/json': { schema: { $ref: '#/components/schemas/StoredReport' } },
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
            },
          },
          '404': err('Report not found or expired (30-day TTL)'),
          '502': err('PDF export unavailable'),
        },
      },
    },
    '/badge/{id}.svg': {
      get: {
        summary: 'Shields-style score badge for a stored report',
        description: 'Embed `https://api.lazynext.com/badge/{id}.svg` on a scanned site; links back to the report.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'SVG badge', content: { 'image/svg+xml': { schema: { type: 'string' } } } },
          '404': err('Report not found or expired'),
        },
      },
    },
    '/checkout': {
      get: {
        summary: 'Redirect to paid checkout (Dodo Payments)',
        description: '302 → hosted checkout. `?plan=pro|agency` picks the tier (default pro); `?term=monthly|annual` picks billing period (default monthly). `?trial=extended` applies the configured extended-trial offer (clamped 15–90 days; unset/invalid → standard 14-day trial).',
        parameters: [{ name: 'trial', in: 'query', schema: { type: 'string', enum: ['extended'] } }],
        responses: {
          '302': { description: 'Redirect to Dodo hosted checkout' },
          '502': err('Checkout unavailable'),
        },
      },
    },
    '/cancel': {
      post: {
        summary: 'Request Pro cancellation (email-confirmed)',
        security: [{ LicenseEmail: [] }],
        description: 'Sends a confirmation link to the purchase email; the subscription ends only after `GET /confirm` consumes the token.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { license: { type: 'string', format: 'email' } }, required: ['license'] } } } },
        responses: {
          '200': json({ $ref: '#/components/schemas/Ok' }, 'Confirmation email sent'),
          '400': err('Purchase email required'),
          '404': err('No active Pro license for that email'),
          '429': err('Confirmation-rate limit (10/day/license, 30/day/IP)'),
        },
      },
    },
    '/lead': {
      post: {
        summary: 'Join the tips + updates list',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'] } } } },
        responses: {
          '200': json({ $ref: '#/components/schemas/Ok' }),
          '400': err('Valid email required'),
          '429': err('Rate limit — try again later'),
          '502': err('Lead capture unavailable'),
        },
      },
    },
    '/monitor': {
      get: {
        summary: 'List monitors for a Pro license',
        security: [{ LicenseEmail: [] }],
        parameters: [{ name: 'license', in: 'query', required: true, schema: { type: 'string', format: 'email' } }],
        responses: {
          '200': json({ type: 'object', properties: { monitors: { type: 'array', items: { $ref: '#/components/schemas/Monitor' } } }, required: ['monitors'] }),
          '402': err('Pro license required'),
          '502': err('Monitor list unavailable'),
        },
      },
      post: {
        summary: 'Add a daily monitor (email-confirmed)',
        security: [{ LicenseEmail: [] }],
        description: 'Daily rendered rescan with score-drop email alerts. Max 50 monitors per license. Sends a confirmation link; the monitor activates on `GET /confirm`. The monitor pins the `viewport` it was created with (default mobile); monitors created before viewport support stay on desktop.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { license: { type: 'string', format: 'email' }, url: { type: 'string', format: 'uri' }, viewport: { type: 'string', enum: ['mobile', 'desktop'], description: 'Render profile the monitor pins for rescans (default mobile)' } }, required: ['license', 'url'] } } } },
        responses: {
          '200': json({ $ref: '#/components/schemas/ConfirmRequired' }),
          '400': err('Provide `{"url"}`'),
          '402': err('Pro license required — `upgrade` points at /checkout'),
          '429': err('Monitor limit (50) or confirmation-rate limit'),
          '502': err('Could not create confirmation'),
        },
      },
      delete: {
        summary: 'Remove a monitor (email-confirmed)',
        security: [{ LicenseEmail: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { license: { type: 'string', format: 'email' }, url: { type: 'string', format: 'uri' } }, required: ['license', 'url'] } } } },
        responses: {
          '200': json({ $ref: '#/components/schemas/ConfirmRequired' }),
          '400': err('Provide `{"url"}`'),
          '402': err('Pro license required'),
          '429': err('Confirmation-rate limit'),
          '502': err('Could not create confirmation'),
        },
      },
    },
    '/confirm': {
      get: {
        summary: 'Consume an emailed confirmation token',
        security: [{ ConfirmToken: [] }],
        description: 'Single-use 15-minute tokens created by /cancel and /monitor mutations. Returns an HTML outcome page.',
        parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'HTML confirmation outcome page', content: { 'text/html': { schema: { type: 'string' } } } },
        },
      },
    },
    '/unsubscribe': {
      get: {
        summary: 'Unsubscribe page (signed link from report/alert emails)',
        security: [{ UnsubscribeSig: [] }],
        parameters: [
          { name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } },
          { name: 'sig', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'HTML unsubscribe confirmation page', content: { 'text/html': { schema: { type: 'string' } } } },
          '403': { description: 'Invalid link', content: { 'text/html': { schema: { type: 'string' } } } },
        },
      },
      post: {
        summary: 'Unsubscribe (one-click, RFC 8058)',
        security: [{ UnsubscribeSig: [] }],
        parameters: [
          { name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email' } },
          { name: 'sig', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': json({ $ref: '#/components/schemas/Ok' }),
          '403': err('Invalid link'),
          '502': err('Unsubscribe write failed'),
        },
      },
    },
    '/mcp': {
      post: {
        summary: 'Model Context Protocol endpoint (JSON-RPC 2.0)',
        description: 'Tools: `scan_url`, `scan_html`, `get_report`, `list_rules` — same pipeline and quota as POST /scan. GET returns 405 (no SSE transport). Wire format: `docs/agent-protocols.md`.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcRequest' } } } },
        responses: { '200': json({ $ref: '#/components/schemas/JsonRpcResponse' }, 'JSON-RPC result or error envelope') },
      },
    },
    '/a2a': {
      post: {
        summary: 'A2A endpoint — message/send, tasks/send, tasks/get',
        description: 'Task ids are report ids: a completed task can be replayed from the stored report while it lives (30 days). Agent card at `/.well-known/agent.json`.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcRequest' } } } },
        responses: { '200': json({ type: 'object' }, 'A2A task/message envelope') },
      },
    },
    '/a2a/tasks/{id}': {
      get: {
        summary: 'REST shortcut for A2A tasks/get',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': json({ type: 'object' }),
          '404': err('Task/report not found or expired'),
        },
      },
    },
    '/.well-known/agent.json': {
      get: {
        summary: 'A2A agent card',
        responses: { '200': json({ type: 'object' }) },
      },
    },
    '/widget.js': {
      get: {
        summary: 'Shadow-DOM embed script',
        description: '`<script src="…/widget.js"></script>` mounts a self-contained scan form on any site; its scans are quota-gated like every other surface.',
        responses: { '200': { description: 'JavaScript embed', content: { 'application/javascript': { schema: { type: 'string' } } } } },
      },
    },
    '/sw.js': {
      get: {
        summary: 'Service worker (PWA shell cache)',
        responses: { '200': { description: 'Service worker source', content: { 'application/javascript': { schema: { type: 'string' } } } } },
      },
    },
    '/manifest.json': {
      get: {
        summary: 'PWA manifest',
        responses: { '200': json({ type: 'object' }) },
      },
    },
    '/llms.txt': {
      get: {
        summary: 'LLM-facing service summary',
        responses: { '200': { description: 'Plain-text summary', content: { 'text/plain': { schema: { type: 'string' } } } } },
      },
    },
  },
  components: {
    // Auth model, stated honestly: this API issues no API keys, no bearer tokens,
    // and holds no user accounts. Three mechanisms do the work, and each is
    // declared below so a consumer (or a security scanner) can see which
    // operations are gated by what. Read-only + compute endpoints are
    // deliberately anonymous — gated by IP quota, not by identity.
    //
    //   LicenseEmail      entitlement identifier (the purchase email). NOT a
    //                     secret: it selects the Pro plan and raises limits, so
    //                     leaking it grants no data access, only quota. Mutations
    //                     that spend it (cancel, monitor changes) are additionally
    //                     gated by ConfirmToken.
    //   ConfirmToken      single-use, 15-minute token emailed to the license
    //                     address. Consumed by GET /confirm. This is the real
    //                     authorization step for state changes.
    //   UnsubscribeSig    HMAC-SHA256 signature over the address, minted by the
    //                     platform and embedded in outbound mail footers. Required
    //                     so a link scanner can't unsubscribe a bystander.
    securitySchemes: {
      LicenseEmail: {
        type: 'apiKey',
        in: 'query',
        name: 'license',
        description: 'Pro purchase email. Entitlement selector, not a secret — see the auth-model note at the top of this document. Sent as a query parameter on GET /monitor and in the JSON body elsewhere.',
      },
      ConfirmToken: {
        type: 'apiKey',
        in: 'query',
        name: 'token',
        description: 'Single-use confirmation token emailed to the license address (15-minute TTL). The actual authorization step for /cancel and /monitor mutations.',
      },
      UnsubscribeSig: {
        type: 'apiKey',
        in: 'query',
        name: 'sig',
        description: 'HMAC-SHA256 signature over the address (first 24 hex chars), minted by the platform. Prevents third-party unsubscribes.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          upgrade: { type: 'string', description: 'Present on 402 responses — path to /checkout' },
          detail: { type: 'string' },
          skipped: { type: 'array', items: { type: 'string' } },
          report_error: { type: 'string' },
        },
        required: ['error'],
      },
      Ok: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      ConfirmRequired: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, confirm: { type: 'string', enum: ['email'], description: 'Mutation completes only via the emailed confirmation link' } },
        required: ['ok', 'confirm'],
      },
      Monitor: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          license: { type: 'string', format: 'email' },
          created: { type: 'number', description: 'epoch ms' },
          viewport: { type: 'string', enum: ['mobile', 'desktop'], description: 'Pinned render profile — rescans always use it so score comparisons are like-for-like' },
          last_score: { type: 'number' },
          last_scan: { type: 'number', description: 'epoch ms' },
          alerted: { type: 'boolean' },
        },
      },
      ScanRequest: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri', description: 'Public http/https page. Rendered via headless browser; consumes daily quota.' },
          html: { type: 'string', description: 'Raw markup to scan statically (≤512KB, no quota).' },
          site: { type: 'boolean', description: 'Crawl same-origin pages (3 free / 10 Pro) and add cross-page checks.' },
          license: { type: 'string', format: 'email', description: 'Pro purchase email — higher limits, deeper crawls, monitoring.' },
          email_report: { type: 'boolean', description: 'Pro only: email the report to the license address.' },
          viewport: { type: 'string', enum: ['mobile', 'desktop'], description: 'Rendered-scan viewport profile — mobile emulates a 390×844 handset (touch + mobile UA, the default); desktop keeps the pre-mobile baseline render. Ignored for `html` scans and site crawls.' },
        },
      },
      ScanResult: {
        type: 'object',
        properties: {
          score: { type: 'number', minimum: 0, maximum: 100 },
          score_model: { type: 'string', enum: ['weighted-v1'], description: 'Scoring model version — weighted-v1 sums findings weighted by WCAG level and detection confidence (warn-class heuristics count half), repeat instances of the same rule at half marginal weight. Level-A confirmed failures still weigh 1.0.' },
          issues: { type: 'array', items: { $ref: '#/components/schemas/Issue' } },
          rendered: { type: 'boolean', description: 'true when the headless-browser path ran (false = static fallback)' },
          viewport: { type: 'string', enum: ['mobile', 'desktop'], description: 'Viewport the render ran at — present only when rendered: true' },
          plan: { type: 'string', enum: ['free', 'pro'] },
          report: { type: 'string', format: 'uri', description: 'Shareable report URL (30-day TTL)' },
          render_error: { type: 'string', description: 'Present when rendering failed and the static fallback ran' },
          site: { type: 'boolean' },
          pages: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, score: { type: 'number' }, count: { type: 'number' } } }, description: 'Per-page rollups for site scans' },
          section508: { $ref: '#/components/schemas/Section508' },
          benchmark: { type: 'object', properties: { pct: { type: 'number' }, sites: { type: 'number' } }, description: 'Percentile vs the public scan corpus — present once ≥10 distinct sites are on record' },
        },
        required: ['score', 'issues', 'rendered', 'plan'],
      },
      Issue: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'Emitted rule id — `wcag-N.N.N`, `sec508-*`, or `bp-*` (best practice, not a numbered criterion)' },
          level: { type: 'string', enum: ['A', 'AA', 'AAA', 'BP'] },
          message: { type: 'string' },
          url: { type: 'string', description: 'Per-page attribution on site scans' },
          recommendation: { type: 'string', description: 'Fix guidance joined from the ruleset' },
        },
      },
      Section508: {
        type: 'object',
        properties: {
          basis: { type: 'string', description: 'Incorporation basis — 508 defines no web test rules of its own; E205.4 incorporates WCAG 2.0 AA by reference' },
          conforms: { type: 'boolean', description: 'true when no WCAG criterion fired' },
          criteria_failed: { type: 'array', items: { type: 'string' }, description: 'Sorted `wcag-*` rule ids that fired' },
          clauses_implicated: { type: 'array', items: { type: 'string' }, description: 'Chapter 3 Functional Performance Criteria (302.x) the failures map onto — the language a VPAT/procurement review cites' },
          clause_count: { type: 'number' },
        },
        required: ['basis', 'conforms', 'criteria_failed', 'clauses_implicated', 'clause_count'],
        description: '36 CFR 1194 clause mapping derived from the WCAG findings',
      },
      StoredReport: {
        type: 'object',
        description: 'The object persisted under `report:{id}` (30-day TTL), returned by `/report/{id}.json`. ScanResult fields plus `url`/`ts`; the `issues` list reflects any `level`/`rule` filters applied server-side.',
        properties: {
          url: { type: ['string', 'null'], description: 'Scanned URL, or null for pasted-HTML scans' },
          ts: { type: 'number', description: 'Persist time, epoch ms' },
          score: { type: 'number', minimum: 0, maximum: 100 },
          score_model: { type: 'string', enum: ['weighted-v1'] },
          issues: { type: 'array', items: { $ref: '#/components/schemas/Issue' } },
          rendered: { type: 'boolean' },
          plan: { type: 'string', enum: ['free', 'pro'] },
          render_error: { type: 'string' },
          site: { type: 'boolean' },
          pages: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, score: { type: 'number' }, count: { type: 'number' } } } },
          section508: { $ref: '#/components/schemas/Section508' },
          benchmark: { type: 'object', properties: { pct: { type: 'number' }, sites: { type: 'number' } } },
        },
        required: ['url', 'ts', 'score', 'score_model', 'issues', 'rendered', 'plan', 'section508'],
      },
      RuleManifest: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rule: { type: 'string' },
                name: { type: 'string' },
                level: { type: 'string', enum: ['A', 'AA', 'AAA', 'BP'] },
                wcag: { type: 'string', description: 'WCAG version the criterion was introduced in, or `bp` for best-practice checks' },
                how: { type: 'string', enum: ['static', 'rendered', 'crosspage'] },
                detects: { type: 'string' },
              },
              required: ['rule', 'name', 'level', 'wcag', 'how', 'detects'],
            },
          },
        },
        required: ['count', 'rules'],
      },
      JsonRpcRequest: {
        type: 'object',
        properties: {
          jsonrpc: { type: 'string', enum: ['2.0'] },
          id: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
          method: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['jsonrpc', 'method'],
      },
      JsonRpcResponse: {
        type: 'object',
        properties: {
          jsonrpc: { type: 'string', enum: ['2.0'] },
          id: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
          result: {},
          error: { type: 'object', properties: { code: { type: 'number' }, message: { type: 'string' }, data: {} } },
        },
      },
    },
  },
};
