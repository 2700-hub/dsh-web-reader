import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.DSH_TTS_PORT || 5050);
const VOICE = process.env.DSH_TTS_VOICE || 'zh-CN-YunjianNeural';
const CACHE_DIR = path.join(os.tmpdir(), 'dsh-tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// 缓存上限：超过 7 天或超过 300MB 就清理，避免临时目录无限增长
const CACHE_MAX_BYTES = 300 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
let cacheWrites = 0;

function pruneCache() {
  let entries;
  try {
    entries = fs.readdirSync(CACHE_DIR).map((name) => {
      const full = path.join(CACHE_DIR, name);
      const st = fs.statSync(full);
      return { full, size: st.size, mtime: st.mtimeMs };
    });
  } catch (err) {
    return;
  }
  const now = Date.now();
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (now - e.mtime > CACHE_MAX_AGE_MS) {
      try { fs.unlinkSync(e.full); total -= e.size; e.gone = true; } catch (err) { /* 忽略 */ }
    }
  }
  if (total > CACHE_MAX_BYTES) {
    const rest = entries.filter((e) => !e.gone).sort((a, b) => a.mtime - b.mtime);
    for (const e of rest) {
      if (total <= CACHE_MAX_BYTES) break;
      try { fs.unlinkSync(e.full); total -= e.size; } catch (err) { /* 忽略 */ }
    }
  }
}

let MsEdgeTTS;
let OUTPUT_FORMAT;
try {
  ({ MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts'));
} catch (err) {
  console.error('缺少依赖：请在当前目录运行 npm install');
  process.exit(1);
}

function keyOf(text) {
  return createHash('sha1').update(VOICE + '\n' + text).digest('hex');
}

// 复用同一个连接：每次新建 WebSocket 要多花 1–2 秒（实测 setMetadata 约 1.1 秒），
// 复用后第二句起首字节能降到 0.7 秒左右。
let engine = null;
let engineReady = null;
let queue = Promise.resolve();

async function ensureEngine() {
  if (!engine) {
    engine = new MsEdgeTTS();
    engineReady = engine.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
  }
  await engineReady;
  return engine;
}

function resetEngine() {
  engine = null;
  engineReady = null;
}

// 串行化请求：一个连接同时只跑一段
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

// 合成一段并返回完整 Buffer（带 content-length，浏览器能可靠地开始播放；
// 流式响应虽然首字更早，但没有长度时 Chrome 会一直缓冲，实测反而更慢）
function parseBoundaries(meta) {
  const out = [];
  const re = /"Type"\s*:\s*"WordBoundary"[\s\S]*?"Offset"\s*:\s*(\d+)[\s\S]*?"Duration"\s*:\s*(\d+)[\s\S]*?"Text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(meta))) {
    let word = m[3];
    try { word = JSON.parse('"' + word + '"'); } catch (err) { /* 原样 */ }
    out.push({ t: Math.round(Number(m[1]) / 10000), d: Math.round(Number(m[2]) / 10000), w: word });
  }
  return out;
}

async function synthBuffer(text) {
  const key = keyOf(text);
  const file = path.join(CACHE_DIR, key + '.mp3');
  const timingFile = path.join(CACHE_DIR, key + '.timings.json');
  if (fs.existsSync(file)) {
    let timings = [];
    try { timings = JSON.parse(fs.readFileSync(timingFile, 'utf8')); } catch (err) { timings = []; }
    return { buffer: fs.readFileSync(file), cached: true, timings };
  }

  return enqueue(async () => {
    const tts = await ensureEngine();
    const res = tts.toStream(text);
    const stream = res.audioStream || res;
    let meta = '';
    if (res.metadataStream) res.metadataStream.on('data', (d) => { meta += d.toString(); });

    const chunks = [];
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('合成超时')), 20000);
        stream.on('data', (d) => chunks.push(d));
        stream.on('end', () => { clearTimeout(timer); resolve(); });
        stream.on('error', (e) => {
          clearTimeout(timer);
          const msg = e && (e.stack || e.message) ? (e.stack || e.message) : String(e && e.code ? e.code : e);
          reject(new Error(msg || '未知错误'));
        });
      });
    } catch (err) {
      resetEngine();
      throw err;
    }
    const buffer = Buffer.concat(chunks);
    await new Promise((r) => setTimeout(r, 120)); // 等 metadata 流收尾
    const timings = parseBoundaries(meta);
    try { fs.writeFileSync(file, buffer); } catch (err) { /* 缓存失败不影响播放 */ }
    try { fs.writeFileSync(timingFile, JSON.stringify(timings)); } catch (err) { /* 忽略 */ }
    cacheWrites += 1;
    if (cacheWrites % 20 === 0) pruneCache();
    return { buffer, cached: false, timings };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, voice: VOICE }));
    return;
  }

  if (url.pathname === '/tts') {
    const text = (url.searchParams.get('text') || '').slice(0, 2000);
    if (!text.trim()) { res.writeHead(400); res.end('text required'); return; }
    try {
      const r = await synthBuffer(text);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': r.buffer.length,
        'cache-control': 'public, max-age=86400',
      });
      res.end(r.buffer);
      console.log(`[tts] ${text.slice(0, 18)}… ${r.buffer.length} bytes${r.cached ? ' (缓存)' : ''}`);
    } catch (err) {
      console.error('[tts] 失败:', (err && (err.stack || err.message)) || String(err));
      try { res.end(); } catch (e) { /* 忽略 */ }
    }
    return;
  }

  if (url.pathname === '/timings') {
    const text = (url.searchParams.get('text') || '').slice(0, 2000);
    const file = path.join(CACHE_DIR, keyOf(text) + '.timings.json');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('[]');
    }
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地语音服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`音色: ${VOICE}`);
  console.log('保持此窗口打开；关闭即停止服务。');
  console.log('代理环境:', JSON.stringify({
    HTTP_PROXY: process.env.HTTP_PROXY || null,
    HTTPS_PROXY: process.env.HTTPS_PROXY || null,
    ALL_PROXY: process.env.ALL_PROXY || null,
  }));
  pruneCache();
  ensureEngine()
    .then(() => console.log('[engine] 就绪（连接已预建）'))
    .catch((e) => console.error('[engine] 失败:', e && (e.stack || e.message) || String(e)));
});
