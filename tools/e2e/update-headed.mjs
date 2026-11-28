/**
 * 有头 Edge：实测"检查更新"按钮会打开什么。
 * 不装任何扩展，所以能看到脚本自身的裸行为。
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = fs.readFileSync(path.join(root, 'dsh-web-reader.user.js'), 'utf8');
const EDGE = process.env.E2E_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3098;
const FAKE_VERSION = '9.9.9';
const FAKE_SRC = `// ==UserScript==\n// @name fake\n// @version ${FAKE_VERSION}\n// ==/UserScript==\nconsole.log('fake');\n`;

const HTML = '<!doctype html><html><body><div id="x">update test</div></body></html>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: EDGE, headless: false, args: ['--no-first-run'] });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });

// 伪造 GitHub API：报告 9.9.9
await context.route('https://api.github.com/**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ content: Buffer.from(FAKE_SRC).toString('base64'), encoding: 'base64' }),
}));
await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({
  status: 200, contentType: 'text/plain', body: FAKE_SRC,
}));

await context.addInitScript({ content: SCRIPT });
const page = await context.newPage();
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await page.waitForSelector('#dsh-reader', { timeout: 20000 });

const popups = [];
context.on('page', (p) => popups.push(p));

await page.click('[data-act="update"]');
await page.waitForTimeout(2500);
console.log('打开的新页面数量:', popups.length);
for (const p of popups) {
  console.log('  URL:', p.url());
}
const link = await page.evaluate(() => {
  const a = document.querySelector('.dshr-update-link');
  return a ? { href: a.href, text: a.textContent, display: a.style.display } : null;
});
console.log('面板里的安装链接:', JSON.stringify(link));

// 直接尝试 chrome-extension:// 导航，看浏览器允不允许
const extResult = await page.evaluate(() => {
  try {
    const w = window.open('chrome-extension://ndcooeababalnlpkfedmmbbbgkljhpjf/src/options.html', '_blank');
    return { opened: !!w };
  } catch (err) { return { opened: false, error: String(err && err.message || err) }; }
});
await page.waitForTimeout(1500);
console.log('chrome-extension 尝试:', JSON.stringify(extResult), '新页面数:', popups.length);
for (let i = 0; i < popups.length; i += 1) {
  const p = popups[i];
  let text = '';
  try { text = (await p.evaluate(() => document.body ? document.body.innerText.slice(0, 80) : '')).replace(/\s+/g, ' '); } catch (err) { text = '(无法读取)'; }
  console.log(`  弹窗${i}: ${p.url()} | ${text}`);
}

await browser.close();
server.close();
process.exit(0);
