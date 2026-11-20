import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.DSH_TTS_PORT || 5050);
const VOICE = process.env.DSH_TTS_VOICE || 'zh-CN-YunjianNeural';
const CACHE_DIR = path.join(os.tmpdir(), 'dsh-tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

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
    engineReady = engine.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
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

// 边合成边把数据块交给调用方：首字延迟取决于云端的首包，而不是整段合成时间
async function streamText(text, onChunk) {
  const key = keyOf(text);
  const file = path.join(CACHE_DIR, key + '.mp3');
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    onChunk(buf);
    return { cached: true, bytes: buf.length };
  }

  return enqueue(async () => {
    const tts = await ensureEngine();
    const res = tts.toStream(text);
    const stream = res.audioStream || res;

    const chunks = [];
    let bytes = 0;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('合成超时')), 20000);
        stream.on('data', (d) => {
          chunks.push(d);
          bytes += d.length;
          try { onChunk(d); } catch (err) { /* 客户端断开 */ }
        });
        stream.on('end', () => {
          clearTimeout(timer);
          try { fs.writeFileSync(file, Buffer.concat(chunks)); } catch (err) { /* 缓存失败不影响播放 */ }
          resolve();
        });
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
    return { cached: false, bytes };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, voice: VOICE }));
    return;
  }

  if (url.pathname === '/tts') {
    const text = (url.searchParams.get('text') || '').slice(0, 2000);
    if (!text.trim()) { res.writeHead(400); res.end('text required'); return; }
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'public, max-age=86400',
    });
    try {
      const r = await streamText(text, (buf) => res.write(buf));
      res.end();
      console.log(`[tts] ${text.slice(0, 18)}… ${r.bytes} bytes${r.cached ? ' (缓存)' : ''}`);
    } catch (err) {
      console.error('[tts] 失败:', (err && (err.stack || err.message)) || String(err));
      try { res.end(); } catch (e) { /* 忽略 */ }
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
  ensureEngine()
    .then(() => console.log('[engine] 就绪（连接已预建）'))
    .catch((e) => console.error('[engine] 失败:', e && (e.stack || e.message) || String(e)));
});
