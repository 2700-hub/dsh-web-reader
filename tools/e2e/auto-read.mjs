/**
 * 自动验收：用 Playwright 驱动本机 Chrome，加载 DSH 页面并注入 userscript。
 *
 * 能验的：面板注入、DOM 契约、自动朗读的决策链（日志）、朗读调用的文本、
 *         多段回答拼接、Alt+点击整段读取。
 * 不能验的：真实出声（无头浏览器没有音频），这里用假的 speechSynthesis 记录调用。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = fs.readFileSync(path.join(root, 'dsh-web-reader.user.js'), 'utf8');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.DSH_URL || 'http://127.0.0.1:3080';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  —— ' + detail : ''));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

// 假引擎：只记录被朗读的文本，不出声
await context.addInitScript(() => {
  window.__spoken = [];
  const fake = {
    speaking: false,
    pending: false,
    paused: false,
    speak(u) {
      window.__spoken.push(String((u && u.text) || ''));
      // 模拟真实引擎：先 onstart，再 onend，让播放队列能继续往下走
      setTimeout(() => { try { u.onstart && u.onstart({}); } catch (err) { /* 忽略 */ } }, 1);
      setTimeout(() => { try { u.onend && u.onend({}); } catch (err) { /* 忽略 */ } }, 8);
    },
    cancel() {},
    pause() {},
    resume() {},
    getVoices() { return []; },
    addEventListener() {},
  };
  try {
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
  } catch (err) { window.speechSynthesis = fake; }
  try { localStorage.setItem('dsh-reader.auto', '1'); } catch (err) { /* 忽略 */ }
  try { localStorage.setItem('dsh-reader.local', '0'); } catch (err) { /* 忽略 */ }
});

await context.addInitScript({ content: SCRIPT });

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e)));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#dsh-reader', { timeout: 30000 });

const build = await page.evaluate(() => window.__dshBuild || '');
check('脚本注入并建立面板', !!build, build);

// 真实页面的 DOM 契约
const probe = await page.evaluate(() => (window.__dshAutoProbe ? window.__dshAutoProbe() : []));
if (probe.length) {
  const last = probe[probe.length - 1];
  check('真实页面能识别回合', true, probe.length + ' 个回合');
  check('真实回合有完成标记', last.closed === true, JSON.stringify({ turn: last.turn, closed: last.closed }));
  check('真实回合有回答行', last.answer !== null, String(last.answer));
} else {
  console.log('INFO 真实页面没有回合（新会话），跳过契约检查；下面用合成回合验证');
}

// 先放一条"旧回合"：让脚本建立基线，避免新回合被当成历史
await page.evaluate(() => {
  const old = document.createElement('div');
  old.id = 'e2e-old';
  old.innerHTML = `
    <div data-chat-turn="1" data-chat-flow-kind="assistant-step"><p>旧消息，仅用于建立基线。</p></div>
    <div data-turn-tail="1" data-actions-reveal="always"></div>
  `;
  document.body.appendChild(old);
});
await page.waitForTimeout(2200);

// 注入一个合成的"已回答"回合（模拟 dsh 0.2.2 的多段结构）
await page.evaluate(() => {
  const wrap = document.createElement('div');
  wrap.id = 'e2e-turn';
  wrap.innerHTML = `
    <div data-chat-turn="999" data-chat-flow-kind="assistant-step"><p id="e2e-p1">第一段测试文字，包含 alpha。</p></div>
    <div data-chat-turn="999" data-chat-flow-kind="tool-call"><pre>tool output</pre></div>
    <div data-chat-turn="999" data-chat-flow-kind="assistant-step"><p id="e2e-p2">第二段测试文字，包含 beta。</p></div>
    <div data-turn-tail="999" data-actions-reveal="always"></div>
  `;
  document.body.appendChild(wrap);
});

await page.waitForTimeout(3000);

const autoLog = await page.evaluate(() => window.__dshAutoLog.slice(-12));
const ready = autoLog.find((e) => e.event === 'ready' && e.turn === 999);
const played = autoLog.find((e) => e.event === 'play' && e.turn === 999);
check('自动朗读识别到合成回合', !!ready, JSON.stringify(ready || null));
check('自动朗读触发了播放', !!played, JSON.stringify(played || null));

const spokenAuto = (await page.evaluate(() => window.__spoken)).join('\n');
const dbg = await page.evaluate(() => ({
  sentences: window.__dshState.sentences,
  chunks: window.__dshState.chunks.map((c) => c.text),
}));
check('朗读文本包含两段回答', spokenAuto.includes('alpha') && spokenAuto.includes('beta'), spokenAuto.slice(0, 80) + ' | ' + JSON.stringify(dbg).slice(0, 160));
check('朗读文本不含工具输出', !spokenAuto.includes('tool output'), '');

// 手动 Alt+点击第二段：应从该段开始，且能读完整条（含另一段）
await page.evaluate(() => {
  const btn = document.querySelector('[data-act="stop"]');
  if (btn) btn.click();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  window.__spoken.length = 0;
  const el = document.getElementById('e2e-p2');
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, altKey: true,
    clientX: Math.round(r.left + 4), clientY: Math.round(r.top + 4),
  }));
});
await page.waitForTimeout(1200);
const spokenManual = (await page.evaluate(() => window.__spoken)).join('\n');
const sents = await page.evaluate(() => window.__dshState.sentences.length);
const scopeInfo = await page.evaluate(() => ({
  len: Array.isArray(window.__dshState.scopeEl) ? window.__dshState.scopeEl.length : (window.__dshState.scopeEl ? 1 : 0),
  turn: document.getElementById('e2e-p2') ? !!document.getElementById('e2e-p2').closest('[data-chat-turn]') : false,
}));
check('Alt+点击能取到整条回答', sents >= 2, '句数=' + sents + ' scope=' + JSON.stringify(scopeInfo));
check('Alt+点击从所点段落开始', spokenManual.includes('beta'), spokenManual.slice(0, 80));

await page.screenshot({ path: path.join(root, 'tools', 'e2e', 'out.png'), fullPage: false });

check('页面无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL PASS ${results.length}/${results.length}`));
process.exit(failed.length ? 1 : 0);
