// Screenshot a layout file as the studio renders it in a plain browser (dev Tauri mock, no live
// sensors). Usage (from client/, with `npm run dev` or `tauri dev` serving port 1420):
//   node scripts/shot-layout.mjs <layout.json> <out.png> [baseUrl]
// Optional: PW_EXE=<path to a Chromium binary> when the Playwright-managed browser is not installed.
// The studio canvas is captured at the mock monitor's size (1920×1032 work area), so what you see
// is geometry, cards, fonts and placeholders — readings show as "—" or the plugin hint.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [layoutPath, outPath, baseUrl = 'http://localhost:1420'] = process.argv.slice(2);
if (!layoutPath || !outPath) {
	console.error('usage: node scripts/shot-layout.mjs <layout.json> <out.png> [baseUrl]');
	process.exit(2);
}
// Minified: the mock reads `?mockLayout=` from location.search. The server never sees it — the
// init script rewrites the URL client-side, so a large layout does not hit the request-line limit.
const layout = JSON.stringify(JSON.parse(readFileSync(layoutPath, 'utf8')));
const browser = await chromium.launch(
	process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {}
);
const page = await browser.newPage({ viewport: { width: 2400, height: 1300 } });
const errors = [];
page.on('console', (m) => {
	if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.addInitScript(
	(search) => {
		history.replaceState(null, '', search);
	},
	`/?mockLayout=${encodeURIComponent(layout)}`
);
await page.goto(`${baseUrl}/`);
await page.locator('.canvas.studio.edit').waitFor({ state: 'visible', timeout: 30_000 });
// Let fonts, sparklines and the first telemetry tick settle.
await page.waitForTimeout(1500);
const widgets = await page.locator('[data-w]').count();
const groups = await page.locator('[data-group]').count();
await page.locator('.canvas.studio').screenshot({ path: outPath });
console.log(`saved ${outPath}: widgets=${widgets} groups=${groups}`);
if (errors.length) console.log('console errors:\n' + errors.slice(0, 8).join('\n'));
await browser.close();
