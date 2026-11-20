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

const pending = new Map(); // hash -> Promise<Buffer>

async function synthesize(text) {
  const key = createHash('sha1').update(VOICE + '\n' + text).digest('hex');
  const file = path.join(CACHE_DIR, key + '.mp3');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (pending.has(key)) return pending.get(key);

  const job = (async () => {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const res = tts.toStream(text);
    const stream = res.audioStream || res;
    const chunks = [];
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
    const buf = Buffer.concat(chunks);
    if (buf.length) fs.writeFileSync(file, buf);
    return buf;
  })();

  pending.set(key, job);
  try {
    return await job;
  } finally {
    pending.delete(key);
  }
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
    try {
      const buf = await synthesize(text);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': buf.length,
        'cache-control': 'public, max-age=86400',
      });
      res.end(buf);
      console.log(`[tts] ${text.slice(0, 18)}… ${buf.length} bytes`);
    } catch (err) {
      console.error('[tts] 失败:', (err && (err.stack || err.message)) || String(err));
      res.writeHead(502); res.end('synthesis failed');
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
  synthesize('启动自检')
    .then((b) => console.log('[selftest] ok', b.length))
    .catch((e) => console.error('[selftest] fail:', e && (e.stack || e.message) || String(e)));
});
