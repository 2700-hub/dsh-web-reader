/**
 * 在 Node 里加载 userscript，取出纯函数。
 *
 * 原理：脚本是 IIFE，只要给它一套最小的 window/document/localStorage 桩，
 * 再设 window.__DSH_NO_BOOT = true，它就不会去碰 DOM、不建面板，
 * 只把 window.__dshTest 挂出来。
 *
 * 这样测的是「线上那份文件本身」，不是另抄一份，避免测试和代码漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(root, 'dsh-web-reader.user.js'), 'utf8');

const noop = () => {};

export function loadReader() {
  const store = new Map();

  const ctx = {
    console,
    setTimeout: noop,
    setInterval: noop,
    clearTimeout: noop,
    clearInterval: noop,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    location: { hostname: '127.0.0.1', href: 'http://127.0.0.1:3080/' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      readyState: 'complete',
      addEventListener: noop,
      querySelectorAll: () => [],
      getElementById: () => null,
      body: null,
    },
    navigator: { userAgent: 'node-test' },
  };

  // window 自引用：脚本里有 window.top !== window.self 的守卫
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.top = ctx;
  ctx.window.speechSynthesis = {
    getVoices: () => [],
    speak: noop,
    cancel: noop,
    pause: noop,
    resume: noop,
  };
  ctx.window.__DSH_NO_BOOT = true;

  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'dsh-web-reader.user.js' });

  const api = ctx.window.__dshTest;
  if (!api) {
    throw new Error('没拿到 window.__dshTest：检查 userscript 里的测试钩子是否被改动');
  }

  return { api, state: ctx.window.__dshState, window: ctx.window };
}
