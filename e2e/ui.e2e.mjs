/**
 * End-to-end verification of the UI, in a real browser.
 *
 * Drives every user-facing flow: analyse, read the verdict, move through every
 * tab, prove an index, run a settings what-if, open the plan diff, select nodes
 * from both the graph and the list, switch theme, and the failure paths. Also
 * checks the things only observable in a browser — layout overflow, console
 * errors, whether the vendored fonts actually applied, and measured colour
 * contrast.
 *
 *   node e2e/ui.e2e.mjs
 *
 * Requires the agent (5174) and the web dev server (5173) running.
 */

import { chromium } from 'playwright';

const URL = process.env.QUERYNOT_WEB_URL ?? 'http://127.0.0.1:5173/';
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

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
  check('empty state explains the product before any query is run',
    /prove|test|hypothetical/i.test(await page.locator('.empty').first().innerText()));

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map((f) => ({ family: f.family, status: f.status }));
  });
  check('SF Pro loaded', fonts.some((f) => /SF Pro/i.test(f.family) && f.status === 'loaded'),
    JSON.stringify(fonts));
  check('SF Mono loaded', fonts.some((f) => /SF Mono/i.test(f.family) && f.status === 'loaded'));
  check('body renders in SF Pro',
    await page.evaluate(() => getComputedStyle(document.body).fontFamily.startsWith('"SF Pro"')),
    await page.evaluate(() => getComputedStyle(document.body).fontFamily));
  check('editor renders in SF Mono', await page.evaluate(() => {
    const el = document.querySelector('.editor');
    return el ? getComputedStyle(el).fontFamily.startsWith('"SF Mono"') : false;
  }));
  check('vendored subset covers the UI glyph set', await page.evaluate(async () => {
    await document.fonts.ready;
    return ['→', '—', '…', '×', '·', '▸', '▾'].every((g) => document.fonts.check('15px "SF Pro"', g));
  }));

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// ── The verdict hero ─────────────────────────────────────────────────────────

section('Verdict hero');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
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

// ── Estimate-only ────────────────────────────────────────────────────────────

section('Estimate-only mode');
{
  const { ctx, page } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });

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
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
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
  await page.goto(URL, { waitUntil: 'networkidle' });
  await analyse(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`${name}: no horizontal overflow`, overflow <= 0, `${overflow}px`);
  if (OUT && viewport.width === 390) await page.screenshot({ path: `${OUT}/e2e-mobile.png`, fullPage: true });
  await ctx.close();
}

// ── Accessibility ────────────────────────────────────────────────────────────

section('Accessibility');
{
  const { ctx, page } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
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
