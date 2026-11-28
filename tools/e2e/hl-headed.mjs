/**
 * 有头 Edge：采样真实朗读时的"读到哪 vs 高亮在哪"，判断高亮为什么跟不上。
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = fs.readFileSync(path.join(root, 'dsh-web-reader.user.js'), 'utf8');
const EDGE = process.env.E2E_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3097;

const LONG = '高亮追踪的测试文本，用来观察朗读进度和高亮位置是否一致。'
  + '这一段故意写得比较长，方便看到每个字被念到的时候，黄色框有没有跟上去。'
  + '如果边界事件很少，高亮就会一段一段地跳，而不是平滑地走。'
  + '最后再加一句，确认读完之后高亮是不是还停在中间。';

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div data-chat-turn="1" data-chat-flow-kind="assistant-step"><p>旧消息。</p></div>
<div data-turn-tail="1" data-actions-reveal="always"></div>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: EDGE, headless: false, args: ['--no-first-run'] });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
await context.addInitScript(() => {
  try { localStorage.setItem('dsh-reader.auto', '1'); } catch (e) { /* 忽略 */ }
  try { localStorage.setItem('dsh-reader.local', '0'); } catch (e) { /* 忽略 */ }
  try { localStorage.setItem('dsh-reader.rate', '1.5'); } catch (e) { /* 忽略 */ }
});
await context.addInitScript({ content: SCRIPT });

const page = await context.newPage();
page.on('console', (m) => console.log('CONSOLE:', m.type(), m.text().slice(0, 160)));
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e && e.message || e)));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await page.waitForSelector('#dsh-reader', { timeout: 20000 });
await page.mouse.click(500, 350);
await page.waitForTimeout(500);

console.log('初始状态:', JSON.stringify(await page.evaluate(() => ({
  auto: window.__dshState.auto,
  sentences: window.__dshState.sentences.length,
  chunks: window.__dshState.chunks.length,
  voices: window.speechSynthesis.getVoices().length,
}))));

await page.evaluate((text) => {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div data-chat-turn="2" data-chat-flow-kind="assistant-step"><p id="long">${text}</p></div><div data-turn-tail="2" data-actions-reveal="always"></div>`;
  document.body.appendChild(wrap);
}, LONG);

await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 10000 }).catch(() => { /* 可能没开始 */ });

console.log('开始后状态:', JSON.stringify(await page.evaluate(() => ({
  playing: window.__dshState.playing,
  sentences: window.__dshState.sentences.length,
  chunks: window.__dshState.chunks.map((c) => c.text.slice(0, 12)),
  toast: (document.querySelector('.dshr-toast') || {}).textContent || '',
  palette: window.__dshAutoLog.slice(-4),
}))));

const samples = [];
for (let i = 0; i < 140; i += 1) {
  const s = await page.evaluate(() => {
    const box = document.querySelector('.dshr-play-hl');
    const r = box && box.style.display !== 'none' ? box.getBoundingClientRect() : null;
    return {
      playing: window.__dshState.playing,
      speaking: window.speechSynthesis.speaking,
      boundaryCount: window.__dshState.boundaryCount || 0,
      boundaryAt: window.__dshState.boundary ? window.__dshState.boundary.charIndex : null,
      chunkIdx: window.__dshState.index,
      chunkLen: window.__dshState.chunks[window.__dshState.index]
        ? window.__dshState.chunks[window.__dshState.index].text.length : null,
      hlLen: window.__dshState.hlChunk ? window.__dshState.hlChunk.index : null,
      searchPos: window.__dshState.hlSearchPos,
      boxTop: r ? Math.round(r.top) : null,
      boxLeft: r ? Math.round(r.left) : null,
      perf: window.__dshHlProbe ? window.__dshHlProbe().hlPerf : null,
      trace: window.__dshHlTrace ? window.__dshHlTrace.reason : null,
    };
  });
  samples.push({ ms: i * 300, ...s });
  if (!s.playing && i > 3) break;
  await page.waitForTimeout(300);
}

console.log('样本数:', samples.length);
for (const s of samples) {
  console.log(`t=${String(s.ms).padStart(5)}ms playing=${s.playing ? 1 : 0} speaking=${s.speaking ? 1 : 0} `
    + `boundary=${s.boundaryCount} char=${s.boundaryAt} chunk=${s.chunkIdx}/${s.chunkLen} hl=${s.hlLen} `
    + `searchPos=${s.searchPos} box=${s.boxTop},${s.boxLeft} trace=${s.trace} calls=${s.perf ? s.perf.calls : '-'} maxMs=${s.perf ? Math.round(s.perf.maxMs) : '-'}`);
}

await browser.close();
server.close();
process.exit(0);
