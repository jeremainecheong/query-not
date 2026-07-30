/**
 * End-to-end verification of the UI, in a real browser.
 *
 * Drives every user-facing flow: analyse, prove an index, run a settings
 * what-if, open the plan diff, select a node, switch theme, and the failure
 * paths. Also checks the things that are only observable in a browser — layout
 * overflow, console errors, the webfont actually loading, and colour contrast
 * in both themes.
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

async function newPage(colorScheme = 'light', viewport = { width: 1280, height: 1000 }) {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    // A favicon 404 is not an application error.
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  return { ctx, page, errors };
}

async function setSql(page, sql) {
  await page.fill('.editor', sql);
}

async function analyse(page) {
  await page.click('button:has-text("Analyse")');
  await page.waitForSelector('.stats', { timeout: 90000 });
}

// ── Load and connection status ───────────────────────────────────────────────

section('Initial load');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });

  check('page loads', (await page.title()) === 'query-not');
  check('agent connection shown', await page.locator('.pill', { hasText: 'querynot' }).count() > 0);
  check('read-only role badge shown', await page.locator('.pill', { hasText: 'read-only' }).count() > 0);
  check('no "no hypopg" warning, since it is installed',
    await page.locator('.pill', { hasText: 'no hypopg' }).count() === 0);
  check('empty state explains the product before any query is run',
    /prove|test|hypothetical/i.test(await page.locator('.empty').first().innerText()));

  // The webfont must actually be applied, not merely requested.
  const fontLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((f) => /Inter/i.test(f.family) && f.status === 'loaded');
  });
  check('Inter webfont loaded and applied', fontLoaded);
  check('font stack prefers the Apple system font first', await page.evaluate(() => {
    const stack = getComputedStyle(document.body).fontFamily;
    return stack.indexOf('-apple-system') === 0 || stack.startsWith('-apple-system');
  }), await page.evaluate(() => getComputedStyle(document.body).fontFamily));

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// ── The main analysis flow ───────────────────────────────────────────────────

section('Analysis flow');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await analyse(page);

  check('stat tiles rendered', await page.locator('.stat').count() >= 4);
  check('narration rendered', (await page.locator('.narration').innerText()).length > 80);
  check('findings rendered', await page.locator('.finding').count() > 0);
  check('severity uses an icon, not colour alone',
    await page.locator('.finding__icon').first().innerText() !== '');
  check('flame graph rendered', await page.locator('svg.flame rect').count() > 0);
  check('flame legend present', await page.locator('.legend').count() > 0);
  check('plan tree rendered', await page.locator('.tree__row').count() > 0);
  check('index suggestion offered', await page.locator('.suggestion__ddl').count() > 0);
  check('rewrite section present', await page.locator('text=Rewrite the query').count() > 0);
  check('settings what-if section present', await page.locator('text=What if the settings were different?').count() > 0);

  // Loops must be shown as totals, never bare per-loop figures.
  const treeText = await page.locator('.tree').innerText();
  check('plan tree labels totals rather than per-loop', /self/.test(treeText));

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// ── Node selection ───────────────────────────────────────────────────────────

section('Node selection');
{
  const { ctx, page } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await analyse(page);

  await page.locator('.tree__row').last().click();
  await page.waitForSelector('text=Node detail', { timeout: 15000 });
  check('clicking a plan row opens node detail', await page.locator('text=Node detail').count() > 0);
  check('node detail shows the predicate',
    /Filter|Index condition|Operation/.test(await page.locator('.card', { hasText: 'Node detail' }).innerText()));

  await page.click('button:has-text("Clear")');
  check('detail can be dismissed', await page.locator('text=Node detail').count() === 0);

  // Clicking a flame cell should select too.
  await page.locator('svg.flame g.flame__cell').last().click();
  await page.waitForSelector('text=Node detail', { timeout: 15000 });
  check('clicking a flame cell selects the same node', await page.locator('text=Node detail').count() > 0);
  await ctx.close();
}

// ── The proof loop ───────────────────────────────────────────────────────────

section('Proof loop (hypothetical index)');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await analyse(page);

  await page.locator('button:has-text("Prove it")').first().click();
  await page.waitForSelector('.proof__verdict', { timeout: 90000 });

  const verdict = (await page.locator('.proof__verdict').first().innerText()).trim();
  check('verdict is Proven', /Proven/i.test(verdict), verdict);

  const headline = await page.locator('.proof__headline').first().innerText();
  check('headline reports the cost drop', /fell by/i.test(headline), headline.slice(0, 90));
  check('headline disclaims measurement', /not a measured speedup/i.test(headline));
  check('hypopg internal index name is not shown', !/<\d+>/.test(headline), headline.slice(0, 90));
  check('before/after bars rendered', await page.locator('.compare__fill').count() === 2);
  check('access changes listed', await page.locator('.changes li').count() > 0);

  // The node-level diff, collapsed by default.
  const toggle = page.locator('.diff__toggle').first();
  check('plan diff toggle present', await toggle.count() > 0);
  check('plan diff collapsed by default', await page.locator('.diff__body').count() === 0);
  await toggle.click();
  await page.waitForSelector('.diff__body', { timeout: 15000 });
  check('plan diff expands to node level', await page.locator('.diff__row').count() > 0);
  check('diff badges use a glyph, not colour alone',
    (await page.locator('.diff__badge').first().innerText()).trim().length > 0);

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await page.locator('.card', { has: page.locator('.suggestion') }).screenshot({ path: `${OUT}/e2e-proof.png` });
  await ctx.close();
}

// ── Settings what-if ─────────────────────────────────────────────────────────

section('Settings what-if');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await setSql(page, 'SELECT customer_id, total_cents FROM orders ORDER BY total_cents, customer_id');
  await analyse(page);

  const card = page.locator('.card', { hasText: 'What if the settings were different?' });
  await card.locator('button:has-text("random_page_cost")').click();
  await card.locator('.proof__verdict').waitFor({ timeout: 90000 });

  check('settings what-if returns a verdict',
    (await card.locator('.proof__verdict').innerText()).trim().length > 0);
  check('measured run does not claim to be an estimate',
    !/not a measured/i.test(await card.locator('.proof__headline').innerText()));

  check('no console errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// ── Rewrite advisor in the UI ────────────────────────────────────────────────

section('Rewrite advisor');
{
  const { ctx, page, errors } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await setSql(page, SMELLY);
  await analyse(page);

  const card = page.locator('.card', { hasText: 'Rewrite the query' });
  const text = await card.innerText();

  check('flags the function-wrapped column', /date\(\)/.test(text) || /created_at/.test(text), text.slice(0, 120));
  check('flags NOT IN', /NOT IN/i.test(text));
  check('flags the deep OFFSET', /OFFSET/i.test(text));
  check('flags SELECT *', /SELECT \*/i.test(text));
  check('semantic-change warning is visually separated',
    await card.locator('.suggestion__caveat').count() > 0,
    'a rewrite that changes results must not look like one that only changes speed');
  check('semantic warning says results change',
    /Changes results/i.test(await card.locator('.suggestion__caveat').first().innerText()));

  check('no console errors', errors.length === 0, errors.join('; '));
  if (OUT) await card.screenshot({ path: `${OUT}/e2e-rewrites.png` });
  await ctx.close();
}

// ── Estimate-only mode ───────────────────────────────────────────────────────

section('Estimate-only mode');
{
  const { ctx, page } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.uncheck('.toggle input');
  await analyse(page);

  const body = await page.locator('.main').innerText();
  check('warns that the plan was not executed', /not executed|estimate/i.test(body));
  check('shows estimated cost rather than elapsed time', /Estimated cost/i.test(body));
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
  check('an unknown table shows a hint', await page.locator('.alert__hint').count() > 0);

  // Recovery: a good query after a failure must clear the error.
  await setSql(page, 'SELECT 1');
  await analyse(page);
  check('a successful run clears the previous error', await page.locator('.alert').count() === 0);
  await ctx.close();
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

section('Keyboard');
{
  const { ctx, page } = await newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.click('.editor');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.stats', { timeout: 90000 });
  check('Ctrl+Enter runs the analysis', await page.locator('.stats').count() > 0);
  await ctx.close();
}

// ── Theme and layout ─────────────────────────────────────────────────────────

section('Theme and layout');
{
  const { ctx, page, errors } = await newPage('dark');
  await page.goto(URL, { waitUntil: 'networkidle' });
  await analyse(page);

  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark scheme applies a dark surface', /rgb\((\d+), (\d+), (\d+)\)/.test(darkBg) &&
    darkBg.match(/\d+/g).slice(0, 3).every((v) => Number(v) < 60), darkBg);

  // The theme toggle must beat the OS setting in both directions.
  await page.click('button[title^="Theme"]');
  await page.waitForTimeout(200);
  const afterToggle = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('theme toggle stamps data-theme', afterToggle !== null, String(afterToggle));

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

  check('flame graph has an accessible label',
    (await page.locator('svg.flame').getAttribute('aria-label'))?.length > 10);
  check('findings are keyboard-focusable',
    await page.locator('.finding[tabindex="0"]').count() > 0);
  check('severity word is available to screen readers',
    await page.locator('.sr-only').count() > 0);

  // Flame labels sit on coloured fills; both must clear 4.5:1.
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
