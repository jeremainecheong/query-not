/**
 * End-to-end verification of the UI, in a real browser.
 *
 * Drives every user-facing flow: analyse, read the verdict, move through every
 * tab, prove an index, run a settings what-if, open the plan diff, select nodes
 * from both the graph and the list, switch theme, and the failure paths. Also
 * checks the things only observable in a browser — layout overflow, console
 * errors, whether the vendored font actually applied, and measured colour
 * contrast.
 *
 *   node e2e/ui.e2e.mjs
 *
 * Requires the agent (5174) and the web dev server (5173) running.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const URL = process.env.QUERYNOT_WEB_URL ?? 'http://127.0.0.1:5173/';
const ANALYSE = '/analyse';
const OUT = process.env.QUERYNOT_SHOT_DIR ?? null;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  [32m✓[0m ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [31m✗[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

const SMELLY = `SELECT *
FROM orders
WHERE date(created_at) = '2024-01-01'
  AND id NOT IN (SELECT order_id FROM order_items)
ORDER BY id OFFSET 100000 LIMIT 20`;

const SORT_QUERY = 'SELECT customer_id, total_cents FROM orders ORDER BY total_cents, customer_id';
const SEQ_QUERY = "SELECT * FROM orders WHERE status = 'disputed' AND created_at > now() - interval '30 days'";

/*
 * Some sandboxes preinstall Chromium at a fixed path and skip the download;
 * CI runners use Playwright's own managed location. Pointing at a path that
 * does not exist fails to launch, so only pass it when it is really there.
 */
const PINNED_CHROMIUM = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(
  existsSync(PINNED_CHROMIUM) ? { executablePath: PINNED_CHROMIUM } : {},
);

async function newPage(colorScheme = 'light', viewport = { width: 1280, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  return { ctx, page, errors };
}

const setSql = (page, sql) => page.fill('.editor', sql);

async function analyse(page) {
  await page.click('button:has-text("Analyse")');
  await page.waitForSelector('.verdict', { timeout: 90000 });
}

/** Switch to a tab in the segmented control. */
async function tab(page, label) {
  await page.locator('.segmented__item', { hasText: label }).first().click();
  await page.waitForTimeout(160);
}

// ── Load ─────────────────────────────────────────────────────────────────────

section('Initial load');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });

  check('page loads', (await page.title()) === 'query-not');
  check('agent connection shown', (await page.locator('.pill', { hasText: 'querynot' }).count()) > 0);
  check('read-only role badge shown', (await page.locator('.pill', { hasText: 'read-only' }).count()) > 0);
  check('no "no hypopg" warning, since it is installed',
    (await page.locator('.pill', { hasText: 'no hypopg' }).count()) === 0);
  check('the root is a landing page, not a bare composer',
    (await page.locator('.hero__title').count()) > 0 && (await page.locator('.composer').count()) === 0);
  check('the landing page states what the tool does',
    /prove|hypothetical|re-plan/i.test(await page.locator('.hero__sub').innerText()));
  check('the landing page offers the primary action',
    (await page.locator('.hero__actions a:has-text("Analyse a query")').count()) > 0);
  check('the landing page links every section',
    (await page.locator('.card-tile').count()) >= 4);
  check('the landing page reports connection state',
    (await page.locator('.hero__status').count()) > 0);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map((f) => ({ family: f.family, status: f.status }));
  });
  check('Inter loaded', fonts.some((f) => /Inter/i.test(f.family) && f.status === 'loaded'),
    JSON.stringify(fonts));
  // The stack leads with -apple-system by design — Apple devices render SF from
  // the OS — so on this Linux runner Inter is the first family that resolves,
  // and webfonts only load on use, so 'loaded' means it is what rendered.
  check('body renders in Inter', await page.evaluate(() =>
    /\bInter\b/.test(getComputedStyle(document.body).fontFamily) && document.fonts.check('15px Inter')),
    await page.evaluate(() => getComputedStyle(document.body).fontFamily));
  check('Inter answers for the UI glyph set', await page.evaluate(async () => {
    await document.fonts.ready;
    return ['→', '—', '…', '×', '·', '▸', '▾'].every((g) => document.fonts.check('15px Inter', g));
  }));

  // Mono is deliberately not vendored — every platform ships a usable
  // monospace — so Inter must be the only registered webfont, and the editor
  // must draw its type from the system stack.
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  check('no webfont beyond Inter is registered', await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].every((f) => /Inter/i.test(f.family));
  }));
  check('editor renders from the system mono stack', await page.evaluate(() => {
    const el = document.querySelector('.editor');
    return el ? getComputedStyle(el).fontFamily.startsWith('ui-monospace') : false;
  }));

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// ── The verdict hero ─────────────────────────────────────────────────────────

section('Verdict hero');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);

  const headline = await page.locator('.verdict__headline').innerText();
  check('headline present', headline.trim().length > 10, headline);
  check('headline is rendered at hero size', await page.evaluate(() => {
    const el = document.querySelector('.verdict__headline');
    return el ? parseFloat(getComputedStyle(el).fontSize) >= 28 : false;
  }), await page.evaluate(() => {
    const el = document.querySelector('.verdict__headline');
    return el ? getComputedStyle(el).fontSize : 'missing';
  }));
  check('supporting detail present', (await page.locator('.verdict__sub').innerText()).length > 30);
  check('inline metrics present', (await page.locator('.metrics').innerText()).includes('elapsed'));

  // The hero must be derived from a real finding, never composed separately —
  // otherwise the headline and the findings list can disagree.
  await tab(page, 'Findings');
  const firstFinding = await page.locator('.finding__title').first().innerText();
  check('headline matches the top finding', firstFinding.includes(headline.trim()),
    `hero="${headline.trim()}" finding="${firstFinding}"`);

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

section('Progressive disclosure');
{
  const { ctx, page } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);

  check('segmented control rendered', (await page.locator('.segmented__item').count()) === 6);
  check('Hotspots selected by default',
    (await page.locator('.segmented__item[aria-selected="true"]').innerText()).includes('Hotspots'));
  check('only one view is shown at a time', (await page.locator('.segmented__item[aria-selected="true"]').count()) === 1);
  check('tab counts are shown', (await page.locator('.segmented__count').count()) > 0);

  for (const [label, selector] of [
    ['Findings', '.finding'],
    ['Rewrites', '.group'],
    ['Indexes', '.group'],
    ['What-if', '.group'],
    ['Plan', '.tree__row'],
    ['Hotspots', 'svg.graph'],
  ]) {
    await tab(page, label);
    check(`${label} tab renders`, (await page.locator(selector).count()) > 0);
  }
  await ctx.close();
}

// ── The plan graph ───────────────────────────────────────────────────────────

section('Plan graph');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);
  await tab(page, 'Hotspots');

  const nodes = await page.locator('svg.graph g.graph__node').count();
  const edges = await page.locator('svg.graph path.graph__edge').count();
  check('graph renders one node per plan operation', nodes >= 5, `${nodes} nodes`);
  check('graph renders edges between operations', edges === nodes - 1, `${edges} edges for ${nodes} nodes`);

  // The whole point of the graph: edge thickness encodes row volume, so a plan
  // where cardinality changes must show visibly different thicknesses.
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('svg.graph path.graph__edge')]
      .map((p) => parseFloat(p.getAttribute('stroke-width'))));
  check('edge thickness varies with rows flowing',
    Math.max(...widths) - Math.min(...widths) > 2,
    `widths: ${widths.map((w) => w.toFixed(1)).join(', ')}`);

  check('the hotspot is called out explicitly',
    (await page.locator('svg.graph text.graph__badge').filter({ hasText: 'HOTSPOT' }).count()) === 1);
  check('every node shows a self-time bar',
    (await page.locator('svg.graph rect.graph__fill').count()) === nodes);
  check('graph has an accessible description',
    ((await page.locator('svg.graph').getAttribute('aria-label')) ?? '').length > 40);
  check('legend explains both encodings',
    /thickness/i.test(await page.locator('.legend').first().innerText()) &&
    /share of total work/i.test(await page.locator('.legend').first().innerText()));

  // Hover produces a tooltip with the row-flow detail.
  await page.locator('svg.graph g.graph__node').first().hover();
  await page.waitForSelector('.tooltip', { timeout: 15000 });
  check('hovering a node shows detail', (await page.locator('.tooltip__title').innerText()).length > 3);

  // Clicking selects.
  await page.locator('svg.graph g.graph__node').last().click();
  await page.waitForSelector('text=Node detail', { timeout: 15000 });
  check('clicking a graph node opens node detail', (await page.locator('text=Node detail').count()) > 0);

  check('slowest operations are ranked, not just drawn',
    (await page.locator('.ranked__row').count()) > 0);
  check('the ranked list is sorted descending', await page.evaluate(() => {
    const w = [...document.querySelectorAll('.ranked__fill')].map((e) => parseFloat(e.style.width));
    return w.every((v, i) => i === 0 || w[i - 1] >= v);
  }));
  check('clicking a ranked row selects that node', await (async () => {
    await page.locator('.ranked__row').nth(1).click();
    await page.waitForSelector('text=Node detail', { timeout: 15000 });
    return (await page.locator('text=Node detail').count()) > 0;
  })());

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-graph.png`, fullPage: true });
  await ctx.close();
}

// ── Node selection from the plan list ────────────────────────────────────────

section('Node selection');
{
  const { ctx, page } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);
  await tab(page, 'Plan');

  await page.locator('.tree__row').last().click();
  await page.waitForSelector('text=Node detail', { timeout: 15000 });
  check('clicking a plan row opens node detail', (await page.locator('text=Node detail').count()) > 0);
  check('node detail shows the operation',
    /Operation/.test(await page.locator('.group').last().innerText()));

  await page.click('button:has-text("Clear")');
  check('detail can be dismissed', (await page.locator('text=Node detail').count()) === 0);

  check('narration available on the Plan tab',
    /returned|estimate/i.test(await page.locator('.main').innerText()));
  check('flame graph lives with the plan detail', (await page.locator('svg.flame').count()) > 0);
  await ctx.close();
}

// ── Proof loop ───────────────────────────────────────────────────────────────

section('Proof loop (hypothetical index)');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await setSql(page, SEQ_QUERY);
  await analyse(page);
  await tab(page, 'Indexes');

  await page.locator('button:has-text("Prove it")').first().click();
  await page.waitForSelector('.proof__verdict', { timeout: 90000 });

  const verdict = (await page.locator('.proof__verdict').first().innerText()).trim();
  check('verdict is Proven', /Proven/i.test(verdict), verdict);

  const headline = await page.locator('.proof__headline').first().innerText();
  check('headline reports the cost drop', /fell by/i.test(headline), headline.slice(0, 90));
  check('headline disclaims measurement', /not a measured speedup/i.test(headline));
  check('hypopg internal index name is not shown', !/<\d+>/.test(headline), headline.slice(0, 90));
  check('before/after bars rendered', (await page.locator('.compare__fill').count()) === 2);
  check('access changes listed', (await page.locator('.changes li').count()) > 0);

  const toggle = page.locator('.diff__toggle').first();
  check('plan diff toggle present', (await toggle.count()) > 0);
  check('plan diff collapsed by default', (await page.locator('.diff__body').count()) === 0);
  await toggle.click();
  await page.waitForSelector('.diff__body', { timeout: 15000 });
  check('plan diff expands to node level', (await page.locator('.diff__row').count()) > 0);
  check('diff badges use a glyph, not colour alone',
    (await page.locator('.diff__badge').first().innerText()).trim().length > 0);

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-proof.png`, fullPage: true });
  await ctx.close();
}

// ── Settings what-if ─────────────────────────────────────────────────────────

section('Settings what-if');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await setSql(page, SORT_QUERY);
  await analyse(page);
  await tab(page, 'What-if');

  await page.locator('button:has-text("random_page_cost")').click();
  await page.waitForSelector('.proof__verdict', { timeout: 90000 });

  check('settings what-if returns a verdict',
    (await page.locator('.proof__verdict').innerText()).trim().length > 0);
  check('measured run does not claim to be an estimate',
    !/not a measured/i.test(await page.locator('.proof__headline').innerText()));

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// ── Rewrite advisor ──────────────────────────────────────────────────────────

section('Rewrite advisor');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await setSql(page, SMELLY);
  await analyse(page);
  await tab(page, 'Rewrites');

  const text = await page.locator('.group').first().innerText();
  check('flags the function-wrapped column', /date\(\)|created_at/.test(text), text.slice(0, 120));
  check('flags NOT IN', /NOT IN/i.test(text));
  check('flags the deep OFFSET', /OFFSET/i.test(text));
  check('flags SELECT *', /SELECT \*/i.test(text));
  check('semantic-change warning is visually separated', (await page.locator('.caveat').count()) > 0,
    'a rewrite that changes results must not look like one that only changes speed');
  check('semantic warning says results change',
    /Changes results/i.test(await page.locator('.caveat').first().innerText()));

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-rewrites.png`, fullPage: true });
  await ctx.close();
}

// ── Generated rewrite, proven in the browser ─────────────────────────────────

section('Generated rewrite proof');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  // Clean NOT IN with both columns NOT NULL: the full proven path.
  await setSql(page,
    'SELECT o.id FROM orders o WHERE o.id < 30000 AND o.id NOT IN (SELECT oi.order_id FROM order_items oi WHERE oi.qty > 3)');
  await analyse(page);
  await tab(page, 'Rewrites');

  const candidate = page.locator('.code--candidate').first();
  check('the generated statement is shown', (await candidate.count()) > 0);
  check('and it is the NOT EXISTS form', /NOT EXISTS/.test(await candidate.innerText()));
  check('a copy button sits beside it', (await page.locator('button:has-text("Copy")').count()) > 0);

  await page.locator('.suggestion button:has-text("Prove it")').first().click();
  await page.waitForSelector('.preconditions', { timeout: 90000 });
  await page.waitForTimeout(300);

  const panel = await page.locator('.proof').first().innerText();
  check('precondition evidence cites NOT NULL', /NOT NULL/.test(panel), panel.slice(0, 160));
  check('the row comparison is reported', /Rows compared|identical/i.test(panel));
  check('the note claims equivalence on this data only', /on this data/.test(panel));
  check('the verdict is a real outcome, not a vibe',
    /Proven|No effect/.test(panel), panel.slice(0, 80));

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-rewrite-proof.png`, fullPage: true });
  await ctx.close();
}

section('Tier B rewrite proofs');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });

  // The hidden N+1: a scalar subquery per row, provable as a LEFT JOIN
  // because customers.id is unique.
  await setSql(page,
    'SELECT o.id, (SELECT c.email FROM customers c WHERE c.id = o.customer_id) AS email FROM orders o WHERE o.id < 20000');
  await analyse(page);
  await tab(page, 'Rewrites');

  const candidate = page.locator('.code--candidate').first();
  check('the correlated finding shows the LEFT JOIN candidate',
    /LEFT JOIN customers/.test(await candidate.innerText()));

  await page.locator('.suggestion button:has-text("Prove it")').first().click();
  await page.waitForSelector('.preconditions', { timeout: 90000 });
  await page.waitForTimeout(300);

  const panel = await page.locator('.proof').first().innerText();
  check('the unique index is cited as the reason it cannot fan out',
    /customers_pkey/.test(panel) && /at most one row/.test(panel), panel.slice(0, 200));
  check('the verdict is Proven', /Proven/.test(panel), panel.slice(0, 80));

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-tierb-proof.png`, fullPage: true });
  await ctx.close();
}

{
  // A fresh page, like every other analysis in this file: analyse() waits on
  // .verdict, and a verdict left over from a previous run on the same page
  // resolves that wait instantly — the tab click then races the pending
  // analysis, which resets the active tab when it lands. CI's slower planner
  // loses that race deterministically; a fast machine never sees it.
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });

  // The OR split: exact by construction, honestly worse without indexes —
  // and with no preconditions, no empty list may render.
  await setSql(page, "SELECT id FROM orders WHERE status = 'disputed' OR total_cents > 495000");
  await analyse(page);
  await tab(page, 'Rewrites');

  const orCandidate = page.locator('.code--candidate').first();
  check('the OR finding shows the guarded UNION ALL candidate',
    /UNION ALL/.test(await orCandidate.innerText()) && /IS NOT TRUE/.test(await orCandidate.innerText()));

  await page.locator('.suggestion button:has-text("Prove it")').first().click();
  await page.waitForSelector('.proof', { timeout: 90000 });
  await page.waitForTimeout(300);

  const orPanel = await page.locator('.proof').first().innerText();
  check('the losing split says so', /Made it worse/.test(orPanel), orPanel.slice(0, 80));
  check('while the rows still matched', /identical rows/.test(orPanel), orPanel.slice(0, 200));
  check('no empty precondition list renders for a construction-exact rewrite',
    (await page.locator('.proof .preconditions').count()) === 0);

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-tierb-orsplit.png`, fullPage: true });
  await ctx.close();
}

// ── Estimate-only ────────────────────────────────────────────────────────────

section('Estimate-only mode');
{
  const { ctx, page } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await page.uncheck('.toggle input');
  await analyse(page);

  const body = await page.locator('.main').innerText();
  check('warns that the plan was not executed', /not executed|estimates only/i.test(body));
  check('shows estimated cost rather than elapsed time', /estimated cost/i.test(body));
  await tab(page, 'Hotspots');
  check('graph still renders without measurements', (await page.locator('svg.graph g.graph__node').count()) > 0);
  await ctx.close();
}

// ── Failure paths ────────────────────────────────────────────────────────────

section('Failure paths');
{
  const { ctx, page } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });

  await setSql(page, 'DELETE FROM orders');
  await page.click('button:has-text("Analyse")');
  await page.waitForSelector('.alert', { timeout: 30000 });
  const alert = await page.locator('.alert').innerText();
  check('a write is refused with a visible explanation', /refus/i.test(alert), alert.slice(0, 100));
  check('refusal explains the alternative', /allowWrites|read/i.test(alert));

  await setSql(page, 'SELECT * FROM no_such_table');
  await page.click('button:has-text("Analyse")');
  await page.waitForSelector('.alert', { timeout: 30000 });
  check('an unknown table shows a hint', (await page.locator('.alert__hint').count()) > 0);

  await setSql(page, 'SELECT 1');
  await analyse(page);
  check('a successful run clears the previous error', (await page.locator('.alert').count()) === 0);
  await ctx.close();
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

section('Keyboard');
{
  const { ctx, page } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await page.click('.editor');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.verdict', { timeout: 90000 });
  check('Ctrl+Enter runs the analysis', (await page.locator('.verdict').count()) > 0);
  await ctx.close();
}

// ── Theme ────────────────────────────────────────────────────────────────────

section('Theme and layout');
{
  const { ctx, page, errors } = await newPage('dark');
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);

  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark scheme applies a dark surface',
    darkBg.match(/\d+/g).slice(0, 3).every((v) => Number(v) < 60), darkBg);

  await page.click('button[title^="Theme"]');
  await page.waitForTimeout(200);
  check('theme toggle stamps data-theme',
    (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) !== null);

  check('no console errors in dark mode', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-dark.png`, fullPage: true });
  await ctx.close();
}

section('Responsive layout');
for (const [name, viewport] of [
  ['desktop 1280', { width: 1280, height: 1000 }],
  ['tablet 768', { width: 768, height: 1024 }],
  ['mobile 390', { width: 390, height: 850 }],
]) {
  const { ctx, page } = await newPage('light', viewport);
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${name}: no horizontal overflow`, overflow <= 0, `${overflow}px`);
  if (OUT && viewport.width === 390) await page.screenshot({ path: `${OUT}/e2e-mobile.png`, fullPage: true });
  await ctx.close();
}

// ── Routing and persistence ──────────────────────────────────────────────────

section('Routing');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  check('the landing page is at the root', new globalThis.URL(page.url()).pathname === '/');

  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);
  const analysisPath = new globalThis.URL(page.url()).pathname;
  check('a run gets a shareable URL', /^\/a\/[\w-]+$/.test(analysisPath), analysisPath);

  // Deep link: open the same URL cold in a fresh page. Nothing is re-run
  // against the database — the recorded analysis is served back.
  const fresh = await ctx.newPage();
  await fresh.goto(new globalThis.URL(analysisPath, URL).toString(), { waitUntil: 'networkidle' });
  await fresh.waitForSelector('.verdict', { timeout: 60000 });
  check('a shared link opens the recorded analysis cold',
    (await fresh.locator('.verdict__headline').innerText()).length > 10);
  check('the shared link restores the original SQL',
    (await fresh.locator('.editor').inputValue()).length > 10);
  await fresh.close();

  // Nav + back button.
  await page.click('.header__link:has-text("Saved")');
  await page.waitForTimeout(250);
  check('nav reaches the saved page', new globalThis.URL(page.url()).pathname === '/saved');
  await page.goBack();
  await page.waitForTimeout(250);
  check('the back button returns to the analysis',
    new globalThis.URL(page.url()).pathname === analysisPath, page.url());
  check('the view follows the back button, not just the URL',
    (await page.locator('.verdict').count()) > 0);

  // Refresh on a deep link must not 404.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.verdict', { timeout: 60000 });
  check('refreshing a deep link still works', (await page.locator('.verdict').count()) > 0);

  // Unknown paths fall back to the front door rather than a dead end.
  await page.goto(new globalThis.URL('/nonsense/path', URL).toString(), { waitUntil: 'networkidle' });
  check('an unknown path falls back to the landing page', (await page.locator('.hero__title').count()) > 0);

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

section('Saving and history');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);

  check('save and share controls appear once there is a result',
    (await page.locator('.toolbar__input').count()) > 0);

  const name = `e2e query ${Date.now()}`;
  await page.fill('.toolbar__input', name);
  await page.click('.toolbar button:has-text("Save")');
  await page.waitForSelector('.toolbar__notice', { timeout: 30000 });
  check('saving confirms', /Saved as/i.test(await page.locator('.toolbar__notice').innerText()));

  await page.click('.header__link:has-text("Saved")');
  await page.waitForSelector('.saved-row', { timeout: 30000 });
  check('the saved query is listed', (await page.locator('.saved-row__name').allInnerTexts()).includes(name));
  check('a saved query shows its run count',
    /run/.test(await page.locator('.saved-row__meta').first().innerText()));

  // History, from the saved list.
  await page.locator('.saved-row', { hasText: name }).locator('a:has-text("History")').click();
  await page.waitForSelector('.verdict', { timeout: 30000 });
  check('history opens from the saved list', /\/history\//.test(page.url()), page.url());
  check('history shows a summary', (await page.locator('.verdict__sub').innerText()).length > 20);
  check('history charts cost over runs', (await page.locator('svg.graph').count()) > 0);
  check('history lists every run', (await page.locator('.tree__row').count()) > 0);
  check('the cost chart is described for screen readers',
    ((await page.locator('svg.graph').getAttribute('aria-label')) ?? '').length > 20);

  // Opening a run from history round-trips back to an analysis.
  await page.locator('.tree__row').first().click();
  await page.waitForSelector('.segmented', { timeout: 60000 });
  check('a run opens from history', /\/a\//.test(page.url()), page.url());

  // Clean up so repeat runs stay deterministic.
  await page.click('.header__link:has-text("Saved")');
  await page.waitForSelector('.saved-row', { timeout: 30000 });
  await page.locator('.saved-row', { hasText: name }).locator('button:has-text("Delete")').click();
  await page.waitForTimeout(400);
  check('a saved query can be deleted',
    !(await page.locator('.saved-row__name').allInnerTexts()).includes(name));

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-saved.png`, fullPage: true });
  await ctx.close();
}

// ── The operation reference ──────────────────────────────────────────────────

section('Operation reference');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL('/reference', URL).toString(), { waitUntil: 'networkidle' });

  const cards = await page.locator('.ref-card').count();
  check('every operation in the glossary is documented', cards >= 20, `${cards} cards`);
  check('every card carries a diagram', (await page.locator('.ref-card .diag').count()) === cards);
  check('operations are grouped into families', (await page.locator('.section-label').count()) >= 5);

  // The diagrams are a set, so they must render at one consistent size —
  // scaling with the card made the same caption tiny in one row and oversized
  // in another.
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('.diag')].map((d) => Math.round(d.getBoundingClientRect().width)));
  check('diagrams render at a consistent size',
    new Set(widths).size === 1, `widths: ${[...new Set(widths)].join(', ')}`);

  check('every diagram is described for screen readers', await page.evaluate(() =>
    [...document.querySelectorAll('.diag')].every((d) => (d.getAttribute('aria-label') ?? '').length > 20)));

  // Search and filter.
  await page.fill('.ref-controls .toolbar__input', 'hash');
  await page.waitForTimeout(200);
  const hits = await page.locator('.ref-card__name').allInnerTexts();
  check('search narrows the list', hits.length > 0 && hits.length < cards, `${hits.length} of ${cards}`);
  check('search matches operation names', hits.some((h) => /hash/i.test(h)), hits.join(', '));

  await page.fill('.ref-controls .toolbar__input', 'zzzznope');
  await page.waitForTimeout(200);
  check('a search with no matches says so', (await page.locator('.empty').count()) > 0);

  await page.fill('.ref-controls .toolbar__input', '');
  await page.locator('.ref-controls .segmented__item:has-text("Combining tables")').click();
  await page.waitForTimeout(200);
  const joins = await page.locator('.ref-card__name').allInnerTexts();
  check('family filter narrows to that family', joins.length > 0 && joins.length < cards,
    joins.join(', '));
  check('the join family contains the joins', joins.includes('Hash Join') && joins.includes('Nested Loop'));

  // The reference must agree with the narrator, since both read one source.
  check('reference text matches the narrator glossary', await page.evaluate(() => {
    const seq = [...document.querySelectorAll('.ref-card')]
      .find((c) => c.querySelector('.ref-card__name')?.textContent === 'Hash Join');
    return /hash table/i.test(seq?.querySelector('.ref-card__what')?.textContent ?? '');
  }));

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-reference.png`, fullPage: true });
  await ctx.close();
}

section('Query index');
{
  const { ctx, page, errors } = await newPage();
  // Make sure at least one query exists.
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);

  await page.click('.header__link:has-text("History")');
  await page.waitForTimeout(400);
  check('history nav reaches the query index', new globalThis.URL(page.url()).pathname === '/queries');
  check('queries are listed', (await page.locator('.query-row').count()) > 0);
  check('each query shows its run count',
    /run/.test(await page.locator('.query-row__meta').first().innerText()));

  await page.locator('.query-row').first().click();
  await page.waitForTimeout(600);
  check('a query opens its plan history', /\/history\//.test(page.url()), page.url());

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-queries.png`, fullPage: true });
  await ctx.close();
}

// ── Workload and decisions ───────────────────────────────────────────────────

section('Workload page');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL('/workload', URL).toString(), { waitUntil: 'networkidle' });
  await page.waitForSelector('.verdict, .alert', { timeout: 60000 });

  const installed = (await page.locator('.workload-row').count()) > 0
    || /snapshot/i.test(await page.locator('.main').innerText());

  check('the workload page renders', installed);
  if (await page.locator('.workload-row').count()) {
    check('entries show total time, calls and share',
      /total/.test(await page.locator('.workload-row__meta').first().innerText()));
    check('the page explains it ranks by total, not mean',
      /total time rather than mean|cheap query running constantly/i.test(await page.locator('.verdict__sub').innerText()));
    check('a snapshot can be taken from the UI',
      (await page.locator('button:has-text("Take snapshot")').count()) > 0);
  }

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-workload.png`, fullPage: true });
  await ctx.close();
}

section('Decisions page');
{
  const { ctx, page, errors } = await newPage();
  // Prove an index so there is a decision to show.
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await setSql(page, SEQ_QUERY);
  await analyse(page);
  await tab(page, 'Indexes');
  await page.locator('button:has-text("Prove it")').first().click();
  await page.waitForSelector('.proof__verdict', { timeout: 90000 });
  await page.waitForTimeout(600);

  await page.goto(new globalThis.URL('/decisions', URL).toString(), { waitUntil: 'networkidle' });
  await page.waitForSelector('.decision-row, .empty', { timeout: 30000 });

  check('proving an index records a decision automatically',
    (await page.locator('.decision-row').count()) > 0,
    'the decisions page should fill without an extra button nobody presses');
  check('a decision shows what was tested',
    /CREATE INDEX/i.test(await page.locator('.decision-row__change').first().innerText()));
  check('a decision shows its verdict',
    (await page.locator('.decision-row__verdict').first().innerText()).trim().length > 0);
  check('a decision can be marked as shipped',
    (await page.locator('.decision-row__actions input[type="checkbox"]').count()) > 0);

  await page.locator('.decision-row__actions input[type="checkbox"]').first().check();
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.decision-row', { timeout: 30000 });
  check('shipped survives a reload',
    await page.locator('.decision-row__actions input[type="checkbox"]').first().isChecked());

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-decisions.png`, fullPage: true });
  await ctx.close();
}

section('Indexes page');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(new globalThis.URL('/indexes', URL).toString(), { waitUntil: 'networkidle' });
  await page.waitForSelector('.indexrow, .alert', { timeout: 60000 });

  check('the deep link renders the inventory',
    (await page.locator('.indexrow').count()) > 0);
  check('the page frames idx_scan honestly, caveats first',
    /replica|reset/i.test(await page.locator('.verdict__sub').innerText()));
  check('semantics-enforcing indexes are separated with their evidence',
    /Not droppable for performance/i.test(await page.locator('.main').innerText()) &&
    /indisprimary/.test(await page.locator('.main').innerText()));
  check('candidate rows carry the usage evidence sentence',
    /since/.test(await page.locator('.indexrow__evidence').first().innerText()));
  check('the prove button is enabled when the capability is on',
    await page.locator('button:has-text("Prove drop")').first().isEnabled());

  // Prove the safe drop end to end. The store has queries from the sections
  // above, none of which plan through promotions_applied_at_idx.
  const promoRow = page.locator('.indexrow', { hasText: 'promotions_applied_at_idx' });
  await promoRow.locator('button:has-text("Prove drop")').click();
  await page.waitForSelector('.proof__verdict', { timeout: 90000 });
  check('a completed proof shows its outcome',
    (await page.locator('.proof__verdict').first().innerText()).trim().length > 0);
  check('the proof is labelled estimate-only',
    (await page.locator('.chip', { hasText: 'estimate only' }).count()) > 0);
  check('coverage is stated on the panel',
    /tested/.test(await page.locator('.proof').first().innerText()));

  // Nav + back button for the new route.
  await page.click('.header__link:has-text("Workload")');
  await page.waitForTimeout(250);
  await page.goBack();
  await page.waitForTimeout(250);
  check('the back button returns to the indexes page',
    new globalThis.URL(page.url()).pathname === '/indexes', page.url());
  check('the view follows the back button', (await page.locator('.indexrow').count()) > 0);

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.screenshot({ path: `${OUT}/e2e-indexes.png`, fullPage: true });
  await ctx.close();
}

section('Command palette');
{
  const { ctx, page } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });

  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette', { timeout: 15000 });
  check('cmd-K opens the palette', (await page.locator('.palette__input').count()) > 0);

  await page.fill('.palette__input', 'hash join');
  await page.waitForTimeout(200);
  check('the palette searches operations, not just pages',
    (await page.locator('.palette__item').allInnerTexts()).some((t) => /Hash Join/.test(t)));

  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  check('selecting an operation goes to the reference',
    new globalThis.URL(page.url()).pathname === '/reference');

  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette', { timeout: 15000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('escape closes it', (await page.locator('.palette').count()) === 0);
  await ctx.close();
}

// ── Accessibility ────────────────────────────────────────────────────────────

section('Accessibility');
{
  const { ctx, page } = await newPage();
  await page.goto(new globalThis.URL(ANALYSE, URL).toString(), { waitUntil: 'networkidle' });
  await analyse(page);

  check('tabs use the tablist role', (await page.locator('[role="tablist"]').count()) > 0);
  check('editor is labelled', (await page.locator('.editor[aria-label]').count()) > 0);

  await tab(page, 'Findings');
  check('findings are keyboard-focusable', (await page.locator('.finding[tabindex="0"]').count()) > 0);
  check('severity word is available to screen readers', (await page.locator('.sr-only').count()) > 0);

  await tab(page, 'Plan');
  const contrasts = await page.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out = [];
    for (const g of document.querySelectorAll('svg.flame g.flame__cell')) {
      const rect = g.querySelector('rect');
      const text = g.querySelector('text');
      if (!rect || !text) continue;
      const a = lum(getComputedStyle(rect).fill);
      const b = lum(getComputedStyle(text).fill);
      out.push((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
    }
    return out;
  });
  check('every flame label clears 4.5:1 against its fill',
    contrasts.length > 0 && contrasts.every((c) => c >= 4.5),
    contrasts.map((c) => c.toFixed(2)).join(', '));

  // Body and secondary text must clear WCAG AA against the page too.
  const inkContrast = await page.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const surface = lum(getComputedStyle(document.body).backgroundColor);
    const sample = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = lum(getComputedStyle(el).color);
      return (Math.max(surface, c) + 0.05) / (Math.min(surface, c) + 0.05);
    };
    return { hero: sample('.verdict__headline'), lead: sample('.verdict__sub') };
  });
  check('hero text clears 4.5:1', (inkContrast.hero ?? 0) >= 4.5, String(inkContrast.hero?.toFixed(2)));
  check('lead text clears 4.5:1', (inkContrast.lead ?? 0) >= 4.5, String(inkContrast.lead?.toFixed(2)));

  if (OUT) await page.screenshot({ path: `${OUT}/e2e-light.png`, fullPage: true });
  await ctx.close();
}

await browser.close();

console.log(`\n${'─'.repeat(60)}`);
console.log(`[1mUI E2E: ${passed} passed, ${failed} failed[0m`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
