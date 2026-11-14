// report_views.js — shareable-report view customization.
// Report URLs are shared between people, so every view is a plain GET with
// query params — no client JS (the report CSP forbids it anyway):
//   ?level=A|AA|AAA|BP findings at one level (BP = best-practice checks, no WCAG conformance)
//   ?rule=wcag-1.1.1  single-criterion view — deep-link a specific failure
//   ?by=page          group findings under the page they fired on (site scans)
// CSV and PDF exports take the same params, so an export matches the view.

const LEVELS = ['A', 'AA', 'AAA', 'BP'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function reportView(searchParams) {
  const lv = searchParams.get('level');
  return {
    level: LEVELS.includes(lv) ? lv : null,
    rule: searchParams.get('rule') || null,
    byPage: searchParams.get('by') === 'page',
  };
}

export function filterIssues(rep, ruleInfo, view) {
  return (rep.issues ?? []).filter((i) => {
    if (view.rule && i.rule !== view.rule) return false;
    if (view.level && ruleInfo[i.rule]?.level !== view.level) return false;
    return true;
  });
}

export function reportCsv(issues, ruleInfo) {
  const cell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return ['rule,criterion,level,page,finding,fix', ...issues.map((i) => [i.rule, ruleInfo[i.rule]?.name ?? '', ruleInfo[i.rule]?.level ?? '', i.url ?? '', i.message, i.fix ?? ''].map(cell).join(','))].join('\r\n');
}

function viewHref(id, view, ext = '') {
  const p = new URLSearchParams();
  if (view.level) p.set('level', view.level);
  if (view.rule) p.set('rule', view.rule);
  if (view.byPage) p.set('by', 'page');
  const q = p.toString().replaceAll('&', '&amp;');
  return `/report/${esc(id)}${ext}${q ? `?${q}` : ''}`;
}

// Filter/sort nav with live counts so the reader sees what a view hides.
function viewNav(id, rep, ruleInfo, view, shown) {
  const counts = { A: 0, AA: 0, AAA: 0, BP: 0 };
  const total = (rep.issues ?? []).length;
  for (const i of rep.issues ?? []) {
    const l = ruleInfo[i.rule]?.level;
    if (l) counts[l]++;
  }
  const link = (label, v, active) => (active ? `<b>${label}</b>` : `<a href="${viewHref(id, v)}">${label}</a>`);
  const parts = [
    link(`All (${total})`, { level: null, rule: null, byPage: view.byPage }, !view.level && !view.rule),
    ...LEVELS.map((l) => link(`${l} (${counts[l]})`, { ...view, level: l, rule: null }, view.level === l && !view.rule)),
    view.byPage
      ? link('Ungroup', { ...view, byPage: false }, false)
      : link('Group by page', { ...view, byPage: true }, false),
  ];
  const active = view.rule ? `rule ${esc(view.rule)}` : view.level ? `Level ${view.level}` : null;
  const summary = active || view.byPage
    ? ` — ${active ? `${active}: ` : ''}showing ${shown} of ${total}${active ? ` · <a href="${viewHref(id, { level: null, rule: null, byPage: view.byPage })}">clear</a>` : ''}`
    : '';
  return `<p style="font-size:0.9em;color:#555">View: ${parts.join(' · ')}${summary}</p>`;
}

function issueRow(i, ruleInfo, id, view) {
  const meta = ruleInfo[i.rule];
  const label = meta ? `<br><span style="color:#555;font-size:0.9em">${esc(meta.name)} · Level ${esc(meta.level)}</span>` : '';
  return `<tr><td style="font-family:monospace;word-break:break-all"><a href="${viewHref(id, { ...view, rule: i.rule })}" style="color:inherit">${esc(i.rule)}</a>${label}</td><td style="word-break:break-word;overflow-wrap:anywhere">${esc(i.message)}${i.fix ? `<br><span style="color:#555;font-size:0.9em">Fix: ${esc(i.fix)}</span>` : ''}</td></tr>`;
}

function issueTables(rep, issues, ruleInfo, id, view) {
  const total = (rep.issues ?? []).length;
  if (!issues.length) {
    return total
      ? `<p>No findings match this view — <a href="${viewHref(id, { level: null, rule: null, byPage: false })}">show all ${esc(String(total))}</a>.</p>`
      : '<table style="width:100%;border-collapse:collapse"><tr><td>No issues found.</td></tr></table>';
  }
  const table = (rows) => `<table style="width:100%;border-collapse:collapse;table-layout:fixed">${rows}</table>`;
  if (!view.byPage) return table(issues.map((i) => issueRow(i, ruleInfo, id, view)).join(''));
  const groups = new Map();
  for (const i of issues) {
    const k = i.url ?? rep.url ?? 'pasted HTML';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  return [...groups].map(([page, gi]) => `<h3 style="font-size:0.95em;margin:1.2em 0 0.2em;font-family:monospace;font-weight:normal;word-break:break-all">${esc(page)} <span style="color:#555">(${gi.length})</span></h3>${table(gi.map((i) => issueRow(i, ruleInfo, id, view)).join(''))}`).join('');
}

export function reportHtml(id, rep, issues, ruleInfo, view, origin, trialDays = 0) {
  return `<!doctype html><meta charset="utf-8"><title>Accessibility report — ${esc(rep.url ?? 'paste')}</title>
<body style="font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem">
<h1>Accessibility report</h1><p><b>${esc(rep.url ?? 'pasted HTML')}</b> · ${new Date(rep.ts).toUTCString()} · rendered: ${rep.rendered}</p>
<p style="font-size:3rem;margin:0"><b>${rep.score}</b>/100${rep.site ? ' <span style="font-size:1rem;color:#555">site-wide (mean of ' + esc(String((rep.pages ?? []).length)) + ' pages)</span>' : ''}</p>
${rep.benchmark ? `<p style="color:#555;font-size:0.9em">Better than ${esc(String(rep.benchmark.pct))}% of ${esc(String(rep.benchmark.sites))} sites scanned by this tool.</p>` : ''}
${rep.section508 ? `<p style="color:#555">Section 508: ${rep.section508.conforms ? 'conforms' : `${rep.section508.criteria_failed.length} WCAG criteria failed — FPC ${esc(rep.section508.clauses_implicated.join(', '))}`}</p>` : ''}
${Array.isArray(rep.pages) && rep.pages.length ? `<table style="width:100%;border-collapse:collapse;margin:0.5rem 0;table-layout:fixed">${rep.pages.map((p) => `<tr><td style="font-family:monospace;font-size:0.85em;word-break:break-all">${esc(p.url)}</td><td style="text-align:right"><b>${p.score}</b>/100</td></tr>`).join('')}</table>` : ''}
<p><a href="${viewHref(id, view, '.csv')}">Download CSV</a> · <a href="${viewHref(id, view, '.json')}">Download JSON</a> · <a href="${viewHref(id, view, '.pdf')}">Download PDF</a> · <img src="/badge/${esc(id)}.svg" alt="accessibility score badge" style="vertical-align:middle"></p>
${rep.plan === 'agency' ? '' : `<p style="font-size:0.85em;color:#555">Embed this badge: <code style="user-select:all;word-break:break-all">${esc(`<a href="${origin}/report/${id}"><img src="${origin}/badge/${id}.svg" alt="Accessibility score"></a>`)}</code></p>`}
${viewNav(id, rep, ruleInfo, view, issues.length)}
${issueTables(rep, issues, ruleInfo, id, view)}
${rep.plan === 'agency'
  ? '<p style="font-size:0.85em;color:#555">Accessibility report generated by an automated WCAG scanner.</p>'
  : `${trialDays
    ? `<p style="padding:0.8em 1em;border:1px solid #2d6;background:#f2fff6;border-radius:6px"><b>You ran a real scan — extend your free Pro trial to ${esc(String(trialDays))} days.</b> Unlimited scans and site monitoring while you fix these findings. <a href="/checkout?trial=extended">Claim the extended trial →</a></p>`
    : `<p style="padding:0.8em 1em;border:1px solid #ccc;border-radius:6px"><b>Go Pro</b> — unlimited scans and site monitoring while you fix these findings. <a href="/checkout">Start a 14-day free trial →</a></p>`}
<p><a href="/">Run your own scan →</a></p>`}`;
}
