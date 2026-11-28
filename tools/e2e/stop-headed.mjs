/**
 * 有头 Edge + 真实 speechSynthesis：验证 Alt+X 之后引擎是否真的停了。
 * 会弹出浏览器窗口，并可能真的读出测试句子（这是有意的）。
 *
 * 判据不是"听见没"，而是引擎自己的状态：
 *   speechSynthesis.speaking === false 且 pending === false
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = fs.readFileSync(path.join(root, 'dsh-web-reader.user.js'), 'utf8');
const EDGE = process.env.E2E_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3099;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>stop test</title></head><body>
<div id="chat">
  <div data-chat-turn="1" data-chat-flow-kind="assistant-step"><p>旧消息，用来建立基线。</p></div>
  <div data-turn-tail="1" data-actions-reveal="always"></div>
</div>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  —— ' + detail : ''));
}

const browser = await chromium.launch({ executablePath: EDGE, headless: false, args: ['--no-first-run'] });
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
await context.addInitScript(() => {
  try { localStorage.setItem('dsh-reader.auto', '1'); } catch (err) { /* 忽略 */ }
  try { localStorage.setItem('dsh-reader.local', '0'); } catch (err) { /* 忽略 */ }
});
await context.addInitScript({ content: SCRIPT });

const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR: ' + String(e && e.message || e)));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 20000 });
await page.waitForSelector('#dsh-reader', { timeout: 20000 });

// 真实引擎需要一次用户手势
await page.mouse.click(500, 400);
await page.waitForTimeout(300);

const engine = await page.evaluate(() => ({
  voices: window.speechSynthesis.getVoices().length,
  zh: window.speechSynthesis.getVoices().filter((v) => /zh|Chinese/i.test(v.lang + v.name)).length,
}));
check('有头 Edge 有真实音色', engine.voices > 0, JSON.stringify(engine));

// 加载后再插入"新回合"，避免被当成历史基线
await page.evaluate(() => {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div data-chat-turn="2" data-chat-flow-kind="assistant-step"><p id="p1">这是第一段测试文字，用来验证按下停止之后声音是不是真的停了。</p></div>
    <div data-chat-turn="2" data-chat-flow-kind="tool-call"><pre>tool</pre></div>
    <div data-chat-turn="2" data-chat-flow-kind="assistant-step"><p id="p2">这是第二段测试文字，中间隔着一个工具调用。</p></div>
    <div data-turn-tail="2" data-actions-reveal="always"></div>`;
  document.body.appendChild(wrap);
});

const state = () => page.evaluate(() => ({
  speaking: window.speechSynthesis.speaking,
  pending: window.speechSynthesis.pending,
  paused: window.speechSynthesis.paused,
  playing: window.__dshState.playing,
}));

// 场景 1：正在朗读时按 Alt+X
await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 10000 });
check('朗读真的开始了（真实引擎）', true, JSON.stringify(await state()));

await page.keyboard.press('Alt+x');
await page.waitForTimeout(900);
const afterStop = await state();
check('Alt+X 后引擎停止（speaking=false）', afterStop.speaking === false && afterStop.pending === false,
  JSON.stringify(afterStop));
check('Alt+X 后状态也是停止', afterStop.playing === false, JSON.stringify({ playing: afterStop.playing }));

// 场景 2：暂停后按 Alt+X（Chromium 的 cancel 在 paused 下可能失效）
await page.evaluate(() => {
  const el = document.getElementById('p1');
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, altKey: true,
    clientX: Math.round(r.left + 4), clientY: Math.round(r.top + 4),
  }));
});
await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 10000 });
await page.evaluate(() => document.querySelector('[data-act="pause"]').click());
await page.waitForTimeout(300);
const pausedState = await state();
check('暂停生效（paused=true）', pausedState.paused === true, JSON.stringify(pausedState));

await page.keyboard.press('Alt+x');
await page.waitForTimeout(900);
const afterPausedStop = await state();
check('暂停状态下 Alt+X 也能停', afterPausedStop.speaking === false && afterPausedStop.pending === false,
  JSON.stringify(afterPausedStop));

// 场景 3：暂停 → 停止 → 再朗读，必须还能出声（引擎别被留在 paused）
await page.evaluate(() => {
  const el = document.getElementById('p2');
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, altKey: true,
    clientX: Math.round(r.left + 4), clientY: Math.round(r.top + 4),
  }));
});
let resumed = false;
try {
  await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 8000 });
  resumed = true;
} catch (err) { resumed = false; }
const afterResume = await state();
check('暂停+停止后还能重新朗读', resumed && afterResume.speaking === true, JSON.stringify(afterResume));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL PASS ${results.length}/${results.length}`));
process.exit(failed.length ? 1 : 0);
