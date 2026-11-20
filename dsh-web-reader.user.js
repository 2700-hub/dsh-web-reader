// ==UserScript==
// @name         dsh web 朗读
// @namespace    local.dsh.reader
// @version      1.12.2
// @description  dsh web 回复朗读：连续播、语速、可拖动进度条、Alt+点哪儿从哪儿读
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/2700-hub/dsh-web-reader
// @supportURL   https://github.com/2700-hub/dsh-web-reader/issues
// @downloadURL  https://raw.githubusercontent.com/2700-hub/dsh-web-reader/main/dsh-web-reader.user.js
// @updateURL    https://raw.githubusercontent.com/2700-hub/dsh-web-reader/main/dsh-web-reader.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 全站匹配 + 运行时自检：只有本机 dsh web 才注入，其他网站立刻退出。
  // 这样就不依赖脚本猫对「带端口地址」的 @match 解析了。
  if (!/^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/i.test(location.hostname)) return;

  // ThoughtDAG 等插件用同源 iframe 承载画布（/thoughtdag/），
  // 在子框架里再注入会多出一个面板。只在顶层文档注入。
  if (window.top !== window.self) return;

  // 版本号：优先读管理器提供的 GM_info，拿不到再用本地常量
  const LOCAL_VERSION = '1.12.2';
  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version)
    ? GM_info.script.version
    : LOCAL_VERSION;

  // 更新检查：拉取仓库 main 上的脚本，比对 @version
  const UPDATE_URL = 'https://raw.githubusercontent.com/2700-hub/dsh-web-reader/main/dsh-web-reader.user.js';
  // raw 有 CDN 缓存（几分钟）；API 读的是当前 main 的真实内容，用于「立刻」检查
  const UPDATE_API = 'https://api.github.com/repos/2700-hub/dsh-web-reader/contents/dsh-web-reader.user.js?ref=main';

  function compareVersions(a, b) {
    const A = String(a).split('.').map(Number);
    const B = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      const x = A[i] || 0;
      const y = B[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  // 注入标记：Console 里敲 window.__dshProbe 就能确认脚本是否执行到这一行
  window.__dshProbe = 'v' + SCRIPT_VERSION;

  if (window.__dshReader) return;
  window.__dshReader = true;

  const synth = window.speechSynthesis;
  if (!synth) {
    console.warn('[dsh-reader] 当前浏览器不支持 speechSynthesis');
    return;
  }

  const TURN_SEL = '[data-chat-turn]';
  const ANSWER_SEL = '[data-turn-process-answer]';
  const LS_RATE = 'dsh-reader.rate';
  const LS_VOICE = 'dsh-reader.voice';
  const LS_VOL = 'dsh-reader.volume';
  const CHUNK_CHARS = 300;
  const BLOCK_TAGS = /^(P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|TD|TH|PRE|DIV|SECTION|ARTICLE)$/;

  const state = {
    sentences: [],
    chunks: [],
    index: 0,
    queued: 0,
    rate: Number(localStorage.getItem(LS_RATE) || 1) || 1,
    voiceName: localStorage.getItem(LS_VOICE) || '',
    volume: Number(localStorage.getItem(LS_VOL) ?? 1),
    playing: false,
    paused: false,
    pausedAt: 0,
    warned: false,
    gen: 0,
    current: null,
    boundary: null,
    scopeEl: null,
    hlCache: null,
    hlChunk: null,
    hlSearchPos: 0,
    lastScrollAt: 0,
    lastUserScroll: 0,
    autoScrollAt: 0,
    scrollTimer: 0,
  };
  window.__dshState = state; // 调试用
  window.__dshHighlight = highlightChar; // 调试用

  /* ---------------- 文本处理 ---------------- */

  function splitSentences(raw) {
    let text = String(raw || '')
      .replace(/\r/g, '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) return [];

    const rough = text.split(/(?<=[。！？!?；;…])|(?<=\n)/);
    const out = [];
    for (let piece of rough) {
      piece = piece.trim();
      if (!piece) continue;
      while (piece.length > 220) {
        let cut = piece.lastIndexOf('，', 200);
        if (cut < 80) cut = piece.lastIndexOf('、', 200);
        if (cut < 80) cut = 200;
        out.push(piece.slice(0, cut + 1).trim());
        piece = piece.slice(cut + 1).trim();
      }
      if (!piece) continue;
      const last = out[out.length - 1];
      const endsSentence = /[。！？!?；;…]$/.test(piece);
      // 只把"没有句末标点的超短碎片"并进上一句；完整短句保留独立，方便按行定位
      if (last && !endsSentence && piece.length < 6 && last.length < 260) {
        out[out.length - 1] = last + piece;
      } else {
        out.push(piece);
      }
    }
    return out;
  }

  function buildChunksFrom(start) {
    const chunks = [];
    let buf = '';
    let from = start;
    for (let i = start; i < state.sentences.length; i += 1) {
      const s = state.sentences[i];
      if (buf && buf.length + s.length > CHUNK_CHARS) {
        chunks.push({ text: buf, from });
        buf = s;
        from = i;
      } else {
        // 上一句没有句末标点时用换行隔开，避免两句黏在一起听不清
        buf += (buf && !/[。！？!?；;…]$/.test(buf) ? '\n' : '') + s;
      }
    }
    if (buf) chunks.push({ text: buf, from });
    return chunks;
  }

  function pickTurn(el) {
    if (!el) return null;
    return el.closest ? el.closest(TURN_SEL) : null;
  }

  function lastTurn() {
    const turns = document.querySelectorAll(TURN_SEL);
    return turns.length ? turns[turns.length - 1] : null;
  }

  const BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th';

  function scopeOfTurn(turn) {
    if (!turn) return null;
    return turn.querySelector(ANSWER_SEL) || turn;
  }

  // 按"块"取文本：段落 / 列表项 / 标题各算一块，块之间用换行分隔。
  // 同时记下每块在全文里的起始位置——点哪块就从哪块读，不再有行数偏差。
  function collectBlocks(scope) {
    if (!scope) return [];
    const all = Array.prototype.slice.call(scope.querySelectorAll(BLOCK_SEL));
    const leaf = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    const blocks = [];
    let start = 0;
    leaf.forEach((el) => {
      let t = (el.innerText || '').trim();
      if (!t) t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      if (el.tagName === 'PRE') {
        // 代码块逐行念会一顿一顿的：压成一行，当一句话读完
        t = t.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (t.length > 400) t = t.slice(0, 400) + '…';
      }
      blocks.push({ el, text: t, start });
      start += t.length + 1;
    });
    if (!blocks.length) {
      const t = (scope.innerText || '').trim();
      if (t) blocks.push({ el: scope, text: t, start: 0 });
    }
    return blocks;
  }

  function textFromBlocks(blocks) {
    return blocks.map((b) => b.text).join('\n');
  }

  function textOfTurn(turn) {
    const scope = scopeOfTurn(turn);
    if (!scope) return '';
    const blocks = collectBlocks(scope);
    if (blocks.length) return textFromBlocks(blocks);
    const clone = scope.cloneNode(true);
    clone.querySelectorAll('button, [data-actions-reveal], [data-scroll-down], [data-scroll-up], textarea, input')
      .forEach((n) => n.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  function docOf(node) {
    return (node && node.ownerDocument) || document;
  }

  // 穿透 shadow DOM 取命中元素（画布类插件常把文字放进 shadow root）
  function deepElementFromPoint(x, y, doc) {
    const d = doc || document;
    let el = d.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard < 5) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
      guard += 1;
    }
    return el;
  }

  // 点击位置 → 命中的块 → 该块在全文里的起始偏移
  function offsetOfBlockAtPoint(x, y, blocks, doc) {
    const el = deepElementFromPoint(x, y, doc);
    if (!el) return null;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].el === el || blocks[i].el.contains(el)) return blocks[i].start;
    }
    return null;
  }

  // 鼠标所在的那一行：不依赖 caretRangeFromPoint，直接按字形的行矩形找
  function blockOf(el) {
    let b = el;
    while (b && !BLOCK_TAGS.test(b.tagName || '')) b = b.parentElement;
    return b;
  }

  function lineRectAt(x, y, doc) {
    const el = deepElementFromPoint(x, y, doc);
    if (!el) return null;
    const block = blockOf(el);
    if (!block) return null;
    const d = docOf(block);
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const len = (node.textContent || '').length;
      if (!len) continue;
      const r = d.createRange();
      r.setStart(node, 0);
      r.setEnd(node, len);
      const rects = Array.prototype.slice.call(r.getClientRects());
      for (let i = 0; i < rects.length; i += 1) {
        const rect = rects[i];
        if (y >= rect.top - 2 && y <= rect.bottom + 2 && x >= rect.left - 60 && x <= rect.right + 60) {
          return { node, rect, block };
        }
      }
    }
    return null;
  }

  // 行首字符在该文本节点里的下标
  function lineStartOf(node, rect) {
    const d = docOf(node);
    const len = (node.textContent || '').length;
    if (!len) return 0;
    const r = d.createRange();
    const limit = Math.min(len, 3000);
    for (let i = 0; i < limit; i += 1) {
      r.setStart(node, i);
      r.setEnd(node, Math.min(i + 1, len));
      const rr = r.getClientRects()[0];
      if (!rr) continue;
      if (Math.abs(rr.top - rect.top) <= 2) return i;
    }
    return 0;
  }

  // 行首 → 全文偏移
  function offsetOfLineAtPoint(x, y, blocks, doc) {
    const hit = lineRectAt(x, y, doc);
    if (!hit) return null;
    let block = null;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].el === hit.block || blocks[i].el.contains(hit.block)) { block = blocks[i]; break; }
    }
    if (!block) return null;
    try {
      const r = docOf(block.el).createRange();
      r.selectNodeContents(block.el);
      r.setEnd(hit.node, lineStartOf(hit.node, hit.rect));
      return block.start + r.toString().length;
    } catch (err) {
      return block.start;
    }
  }

  /* ---------------- 朗读中的当前字高亮 ---------------- */

  // 每个文档一套覆盖框：顶层文档一套，同源 iframe 各一套
  const playHlDocs = new Map();
  function hlListFor(doc) {
    if (!playHlDocs.has(doc)) playHlDocs.set(doc, []);
    return playHlDocs.get(doc);
  }
  function ensurePlayHl(i, doc) {
    const d = doc || document;
    const list = hlListFor(d);
    if (!list[i]) {
      const el = d.createElement('div');
      el.className = 'dshr-play-hl';
      el.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;'
        + 'background:rgba(255,214,102,.26);border-radius:2px;display:none;box-sizing:border-box;'
        + 'transition:left .06s linear,top .06s linear,width .06s linear,height .06s linear';
      (d.body || d.documentElement).appendChild(el);
      list[i] = el;
    }
    return list[i];
  }
  function clearPlayHighlight() {
    playHlDocs.forEach((list) => list.forEach((el) => { if (el) el.style.display = 'none'; }));
  }

  function buildHlCache(scopeEl) {
    if (!scopeEl) return null;
    const nodes = [];
    let raw = '';
    const walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent || '';
      if (!t) continue;
      nodes.push({ node, start: raw.length, len: t.length });
      raw += t;
    }
    if (!raw) return null;
    let norm = '';
    const map = [];
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (/\s/.test(ch)) continue;
      norm += ch;
      map.push(i);
    }
    return { nodes, raw, norm, map, scope: scopeEl };
  }

  function locatePos(cache, pos) {
    for (let i = 0; i < cache.nodes.length; i += 1) {
      const n = cache.nodes[i];
      if (pos >= n.start && pos < n.start + n.len) return { node: n.node, offset: pos - n.start };
    }
    const last = cache.nodes[cache.nodes.length - 1];
    return last ? { node: last.node, offset: last.len } : null;
  }

  function ensureCache(scopeEl) {
    if (!state.hlCache || state.hlCache.scope !== scopeEl) {
      state.hlCache = buildHlCache(scopeEl);
    }
    return state.hlCache;
  }

  // 让当前朗读位置始终靠近视口中线：像提词器一样平滑下滚
  function revealRect(rect, node) {
    if (!rect || state.paused) return;
    const now = Date.now();
    // 用户刚手动滚过，先别抢控制权
    if (now - (state.lastUserScroll || 0) < 2000) return;
    // 我们自己刚滚过，等它稳定，避免和滚动事件互相拉扯
    if (now - (state.autoScrollAt || 0) < 500) return;
    const vh = window.innerHeight;
    const target = vh * 0.45;
    const delta = rect.top - target;
    if (Math.abs(delta) < 8) return;
    if (now - (state.lastScrollAt || 0) < 250) return;
    state.lastScrollAt = now;
    state.autoScrollAt = now;
    let p = node && node.parentElement;
    let scroller = null;
    const win = (node && node.ownerDocument && node.ownerDocument.defaultView) || window;
    const rootBody = (node && node.ownerDocument && node.ownerDocument.body) || document.body;
    while (p && p !== rootBody) {
      const st = win.getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 8) { scroller = p; break; }
      p = p.parentElement;
    }
    try {
      if (scroller) scroller.scrollBy({ top: delta, behavior: 'smooth' });
      else win.scrollBy({ top: delta, behavior: 'smooth' });
      // 滚动动画结束后再定位一次，高亮框才不会被留在旧位置（只定位，不再滚）
      clearTimeout(state.scrollTimer);
      state.scrollTimer = setTimeout(() => {
        if (state.playing && state.hlChunk && state.scopeEl && !state.paused) {
          highlightChar(state.scopeEl, state.hlChunk.text, state.hlChunk.index, { noScroll: true });
        }
      }, 420);
    } catch (err) { /* 忽略 */ }
  }

  // 逐字高亮：charIndex 是这一段文本里的字符下标
  function highlightChar(scopeEl, chunkText, charIndex, opts) {
    if (!scopeEl || !chunkText) return;
    const cache = ensureCache(scopeEl);
    if (!cache) return;
    try {
      let ci = Math.max(0, Math.min(charIndex, chunkText.length - 1));
      let guard = 0;
      while (ci < chunkText.length - 1 && /\s/.test(chunkText[ci]) && guard < 30) { ci += 1; guard += 1; }
      // 取 14 个字的窗口做定位：单个字在全文里会重名，窗口才够唯一
      const WIN = 14;
      const winStart = Math.max(0, Math.min(ci, chunkText.length - WIN));
      const context = chunkText.slice(winStart, winStart + WIN).replace(/\s+/g, '');
      if (context.length < 2) return;
      const targetOffset = chunkText.slice(winStart, ci).replace(/\s+/g, '').length;
      const from = Math.max(0, (state.hlSearchPos || 0) - 80);
      let idx = cache.norm.indexOf(context, from);
      if (idx < 0) idx = cache.norm.indexOf(context);
      if (idx < 0) return;
      state.hlSearchPos = idx + context.length;
      state.hlChunk = { text: chunkText, index: charIndex };

      const pos = Math.min(cache.map.length - 1, idx + Math.min(targetOffset, context.length - 1));
      const startRaw = cache.map[pos];
      const endRaw = cache.map[pos] + 1;
      const a = locatePos(cache, startRaw);
      const b = locatePos(cache, endRaw);
      if (!a || !b) return;
      const doc = docOf(scopeEl);
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const rects = Array.prototype.slice.call(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) return;
      clearPlayHighlight();
      const r = rects[0];
      const d = ensurePlayHl(0, doc);
      d.style.left = (r.left - 2) + 'px';
      d.style.top = (r.top - 1) + 'px';
      d.style.width = (r.width + 4) + 'px';
      d.style.height = (r.height + 2) + 'px';
      d.style.display = 'block';
      if (!opts || !opts.noScroll) revealRect(r, a.node);
    } catch (err) { /* 忽略 */ }
  }

  // 边界事件很密，用 rAF 合并
  let charTick = null;
  let pendingChar = null;
  function queueCharHighlight(scopeEl, chunkText, charIndex) {
    pendingChar = { scopeEl, chunkText, charIndex };
    if (charTick) return;
    charTick = requestAnimationFrame(() => {
      charTick = null;
      const p = pendingChar;
      pendingChar = null;
      if (p && state.playing) highlightChar(p.scopeEl, p.chunkText, p.charIndex);
    });
  }

  // 通用模式：不在聊天消息里时，向上找一段可读内容（ThoughtDAG、普通网页）
  function genericScopeAt(el) {
    let node = el;
    let best = null;
    while (node && node !== document.body) {
      const txt = (node.innerText || '').trim() || (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length >= 20 && txt.length <= 3000) {
        best = node;
        // 找到能装下多个段落的容器就停，避免只读到第一段
        const blocks = node.querySelectorAll('p, li, pre, h1, h2, h3, h4, h5, h6, blockquote');
        if (blocks.length >= 2) return node;
      }
      node = node.parentElement;
    }
    return best;
  }

  /* ---------------- 语音 ---------------- */

  function zhVoices() {
    const all = synth.getVoices() || [];
    const isZh = (v) => /zh[-_]?CN|zh[-_]?HK|zh[-_]?TW|Chinese|中文|普通话|普通話|國語|粤語|粵語/i
      .test(v.lang + ' ' + v.name);
    const zh = all.filter(isZh);
    const pool = zh.length ? zh : all;
    // 本机音色优先（在线音色断网就没声），其次 Microsoft/Windows 的排前面
    return pool.slice().sort((a, b) => {
      const rank = (v) => {
        let r = 0;
        if (v.localService === false) r += 10;
        if (!/Microsoft|Windows/i.test(v.name)) r += 1;
        return r;
      };
      return rank(a) - rank(b);
    });
  }

  const PREFERRED = ['Yunxi', 'Xiaoxiao', '云希', '晓晓', 'Yaoyao', '瑶瑶', 'Yunjian', '云健', 'Kangkang', '康康'];

  function pickVoice() {
    const voices = zhVoices();
    if (!voices.length) return null;
    const saved = voices.find((v) => v.name === state.voiceName);
    if (saved) return saved;
    for (const key of PREFERRED) {
      const hit = voices.find((v) => v.name.toLowerCase().includes(key.toLowerCase()));
      if (hit) return hit;
    }
    const local = voices.find((v) => /Microsoft|Windows|Huihui|Yaoyao|Kangkang/i.test(v.name));
    return local || voices[0];
  }

  /* ---------------- 播放控制 ---------------- */

  // 只提前排 2 段：改语速时后面最多 2 段还按旧速度念，绝不回头重读
  // 提前排 2 段（当前 + 前方 1 段）：既不断句，改语速时等一两段就生效
  const LOOKAHEAD = 2;

  function stop() {
    state.gen += 1;
    state.playing = false;
    state.paused = false;
    state.chunks = [];
    state.index = 0;
    state.queued = 0;
    state.current = null;
    state.hlCache = null;
    state.hlChunk = null;
    state.hlSearchPos = 0;
    clearPlayHighlight();
    synth.cancel();
    render();
  }

  function finish() {
    state.playing = false;
    state.paused = false;
    state.current = null;
    state.index = state.chunks.length;
    state.hlChunk = null;
    state.hlSearchPos = 0;
    clearPlayHighlight();
    render('朗读完成');
  }

  function queueOne(i, gen) {
    const chunk = state.chunks[i];
    if (!chunk) return;
    const u = new SpeechSynthesisUtterance(chunk.text);
    u.lang = 'zh-CN';
    u.rate = state.rate;
    u.volume = Number.isFinite(state.volume) ? state.volume : 1;
    const voice = pickVoice();
    if (voice) u.voice = voice;

    u.onstart = () => {
      if (gen !== state.gen) return;
      state.index = i;
      state.current = chunk.text;
      state.boundary = null;
      if (state.scopeEl) {
        state.hlSearchPos = 0;
        queueCharHighlight(state.scopeEl, chunk.text, 0);
      }
      render();
    };

    // 记录"念到第几个字"，同时把高亮挪到当前字
    u.onboundary = (ev) => {
      if (gen !== state.gen) return;
      if (typeof ev.charIndex !== 'number') return;
      state.boundary = { i, charIndex: ev.charIndex };
      if (state.scopeEl) queueCharHighlight(state.scopeEl, chunk.text, ev.charIndex);
    };

    u.onend = () => {
      if (gen !== state.gen || !state.playing) return;
      // 暂停期间收到的 onend 不可信，别让它把播放推进/结束
      if (state.paused) return;
      if (i >= state.chunks.length - 1) { finish(); return; }
      fillQueue(gen);
    };

    u.onerror = (e) => {
      if (gen !== state.gen) return;
      if (state.paused) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (!state.warned) {
        state.warned = true;
        if (e.error === 'not-allowed') toast('浏览器拦住了语音：先点一下页面任意处再试');
        else if (e.error === 'audio-busy') toast('音频设备被占用，关掉别的播放器再试');
        else toast('语音合成失败：' + e.error);
      }
      if (i >= state.chunks.length - 1) finish();
      else fillQueue(gen);
    };

    synth.speak(u);
  }

  function fillQueue(gen) {
    const g = gen === undefined ? state.gen : gen;
    while (state.playing
      && state.queued < state.chunks.length
      && state.queued - state.index < LOOKAHEAD) {
      queueOne(state.queued, g);
      state.queued += 1;
    }
  }

  // 从第 sentenceIndex 句开始读
  function startFrom(sentenceIndex) {
    if (!state.sentences.length) {
      toast('先读一条消息');
      return;
    }
    const idx = Math.max(0, Math.min(sentenceIndex, state.sentences.length - 1));
    synth.cancel();
    state.gen += 1;
    const gen = state.gen;
    state.chunks = buildChunksFrom(idx);
    state.index = 0;
    state.queued = 0;
    state.playing = true;
    state.paused = false;
    state.warned = false;
    state.current = null;
    render();
    setTimeout(() => {
      if (gen === state.gen) fillQueue(gen);
    }, 90);
  }

  // 从某个字符偏移处对应的句子开始读
  function playTextFrom(text, offset, label) {
    stop();
    state.sentences = splitSentences(text);
    if (!state.sentences.length) {
      render('没有可朗读的文字');
      return;
    }
    let idx = 0;
    let acc = 0;
    for (let i = 0; i < state.sentences.length; i += 1) {
      acc += state.sentences[i].length;
      if (acc > offset) { idx = i; break; }
      idx = i;
    }
    toast('从第 ' + (idx + 1) + ' / ' + state.sentences.length + ' 句开始');
    startFrom(idx);
  }

  function play(text, label) {
    playTextFrom(text, 0, label);
  }

  // 长暂停后 Chrome 的 resume() 经常静默失效：speaking 仍为 true、paused 卡住。
  // 超过 8 秒的暂停不走 resume，直接取消并从当前段重排。
  const LONG_PAUSE_MS = 8000;

  function hardResume(reason) {
    const cur = state.chunks[state.index];
    const from = cur ? cur.from : 0;
    startFrom(from);
    if (reason) toast(reason);
  }

  function togglePause() {
    if (!state.playing) {
      // 播放状态被意外中断（比如暂停期间收到 onend）时，按钮也能把声音拉回来
      if (state.chunks.length && state.index < state.chunks.length) {
        hardResume('继续播放');
      }
      return;
    }
    if (state.paused) {
      const pausedFor = Date.now() - (state.pausedAt || 0);
      state.paused = false;
      state.pausedAt = 0;

      if (pausedFor > LONG_PAUSE_MS) {
        hardResume('已从当前段恢复');
        return;
      }

      synth.resume();
      render();
      // 部分浏览器要连按两次 resume 才动
      setTimeout(() => {
        if (state.playing && !state.paused && synth.paused) synth.resume();
      }, 200);

      const gen = state.gen;
      setTimeout(() => {
        if (gen !== state.gen || !state.playing || state.paused) return;
        if (!synth.speaking || synth.paused) {
          hardResume('已从当前段恢复');
        }
      }, 1000);
    } else {
      synth.pause();
      state.paused = true;
      state.pausedAt = Date.now();
      state.autoScrollAt = Date.now();
      clearTimeout(state.scrollTimer);
      render('已暂停');
    }
  }

  /* ---------------- 界面 ---------------- */

  let root, barBox, bar, statusEl, curEl, hintEl, btnPause, voiceSel, rateInput, rateLabel, volInput, volLabel, collapsed = false;

  function injectStyle() {
    const css = `
      #dsh-reader { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        font: 12px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        color: #e8eaed; background: rgba(24,26,31,.96); border: 1px solid rgba(255,255,255,.14);
        border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.45); padding: 10px 12px;
        width: 280px; backdrop-filter: blur(8px); user-select: none; }
      #dsh-reader[data-collapsed="1"] { width: 200px; padding: 6px 8px; }
      #dsh-reader[data-collapsed="1"] .dshr-label { display: none; }
      #dsh-reader[data-collapsed="1"] .dshr-row { margin-top: 4px; gap: 4px; }
      #dsh-reader[data-collapsed="1"] button { padding: 1px 4px; font-size: 11px; line-height: 16px; }
      #dsh-reader[data-collapsed="1"] .dshr-min,
      #dsh-reader[data-collapsed="1"] .dshr-close { width: 18px; padding: 1px 0; }
      #dsh-reader[data-collapsed="1"] .dshr-bar { height: 6px; margin-top: 4px; }
      #dsh-reader[data-collapsed="1"] .dshr-head button { width: 18px; padding: 1px 0; font-size: 11px; }
      #dsh-reader .dshr-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
      #dsh-reader .dshr-row:first-child { margin-top: 0; }
      #dsh-reader button { flex: 1; cursor: pointer; border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.07); color: #e8eaed; border-radius: 8px; padding: 5px 6px; font-size: 12px; }
      #dsh-reader button:hover { background: rgba(255,255,255,.15); }
      #dsh-reader button:active { transform: translateY(1px); }
      #dsh-reader .dshr-title { font-weight: 600; font-size: 12px; opacity: .85; flex: 1; }
      #dsh-reader .dshr-head { cursor: move; }
      #dsh-reader .dshr-head button { flex: 0 0 auto; width: 24px; padding: 2px 0; }
      #dsh-reader .dshr-min { flex: 0 0 auto; width: 22px; padding: 2px 0; }
      #dsh-reader .dshr-close { flex: 0 0 auto; width: 22px; padding: 2px 0; }
      #dsh-reader .dshr-bar { position: relative; height: 10px; border-radius: 5px; background: rgba(255,255,255,.14);
        margin-top: 8px; cursor: pointer; touch-action: none; }
      #dsh-reader .dshr-bar:hover { background: rgba(255,255,255,.2); }
      #dsh-reader .dshr-bar i { display: block; height: 100%; width: 0; background: #6b8afd; border-radius: 5px;
        transition: width .2s ease; pointer-events: none; }
      #dsh-reader .dshr-hint { opacity: .5; font-size: 11px; margin-top: 4px; min-height: 14px; }
      #dsh-reader .dshr-status { opacity: .8; margin-top: 6px; min-height: 18px; word-break: break-all; }
      #dsh-reader .dshr-cur { opacity: .55; margin-top: 2px; max-height: 36px; overflow: hidden; word-break: break-all; }
      #dsh-reader select, #dsh-reader input[type=range] { width: 100%; }
      #dsh-reader select { background: rgba(255,255,255,.07); color: #e8eaed; border: 1px solid rgba(255,255,255,.16);
        border-radius: 8px; padding: 4px; font-size: 12px; }
      #dsh-reader .dshr-voicebadge { margin-top: 8px; font-size: 12px; padding: 4px 8px;
        border-radius: 8px; background: rgba(107,138,253,.16); border: 1px solid rgba(107,138,253,.5); }
      #dsh-reader .dshr-voicebadge b { color: #a9c0ff; }
      #dsh-reader .dshr-update-link { flex: 1; text-align: center; text-decoration: none;
        color: #a9c0ff; border: 1px solid rgba(107,138,253,.6); border-radius: 8px;
        padding: 4px 6px; background: rgba(107,138,253,.12); }
      #dsh-reader .dshr-update-link:hover { background: rgba(107,138,253,.22); }
      #dsh-reader .dshr-kbd { opacity: .55; font-size: 11px; margin-top: 6px; }
      #dsh-reader .dshr-pop { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px);
        background: rgba(24,26,31,.98); border: 1px solid rgba(255,255,255,.16);
        border-radius: 10px; padding: 8px 10px; display: none; align-items: center; gap: 8px;
        box-shadow: 0 6px 20px rgba(0,0,0,.45); }
      #dsh-reader .dshr-pop[data-open="1"] { display: flex; }
      #dsh-reader .dshr-pop-label { opacity: .7; flex: 0 0 auto; }
      #dsh-reader .dshr-pop input[type=range] { flex: 1; width: auto; }
      #dsh-reader .dshr-pop-val { width: 32px; text-align: right; flex: 0 0 auto; }
      #dsh-reader[data-collapsed="1"] .dshr-collapsible { display: none; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function build() {
    root = document.createElement('div');
    root.id = 'dsh-reader';
    root.innerHTML = `
      <div class="dshr-row dshr-head" title="拖动可移动面板，双击复位">
        <span class="dshr-title"><span class="dshr-ico">🔊</span><span class="dshr-label"> 朗读</span></span>
        <button data-act="update" title="检查更新">⟳</button>
        <button data-act="rate" title="语速">⚡</button>
        <button data-act="vol" title="音量">🔉</button>
        <button data-act="pause" title="暂停 / 继续">⏸</button>
        <button data-act="stop" title="停止">■</button>
        <button class="dshr-min" title="收起/展开">–</button>
        <button class="dshr-close" title="关闭面板（Alt+P 找回）">×</button>
      </div>
      <div class="dshr-bar" title="拖动或点击，从对应句子开始读"><i></i></div>
      <div class="dshr-collapsible">
        <div class="dshr-hint">拖动/点击进度条跳句 · Alt+点正文从该句开始</div>
        <div class="dshr-status">就绪 · Alt+点击任意消息朗读</div>
        <div class="dshr-cur"></div>
        <div class="dshr-voicebadge">当前音色：<b class="dshr-voice-name">-</b></div>
        <div class="dshr-row"><a class="dshr-update-link" target="_blank" rel="noopener" style="display:none">安装新版</a></div>
        <div class="dshr-row"><select class="dshr-voice"></select></div>
        <div class="dshr-kbd">Alt+点击正文从该句读 · Alt+X 停止 · Alt+P 面板</div>
      </div>
      <div class="dshr-pop" data-pop="rate">
        <span class="dshr-pop-label">语速</span>
        <input type="range" class="dshr-rate-input" min="0.6" max="3" step="0.1">
        <span class="dshr-rate dshr-pop-val">1.0</span>
      </div>
      <div class="dshr-pop" data-pop="vol">
        <span class="dshr-pop-label">音量</span>
        <input type="range" class="dshr-vol" min="0" max="1" step="0.05">
        <span class="dshr-vol-label dshr-pop-val">1.0</span>
      </div>
    `;
    document.body.appendChild(root);

    barBox = root.querySelector('.dshr-bar');
    bar = root.querySelector('.dshr-bar i');
    hintEl = root.querySelector('.dshr-hint');
    statusEl = root.querySelector('.dshr-status');
    curEl = root.querySelector('.dshr-cur');
    btnPause = root.querySelector('[data-act="pause"]');
    voiceSel = root.querySelector('.dshr-voice');
    rateInput = root.querySelector('.dshr-rate-input');
    rateLabel = root.querySelector('.dshr-rate');
    volInput = root.querySelector('.dshr-vol');
    volLabel = root.querySelector('.dshr-vol-label');

    root.querySelector('.dshr-min').addEventListener('click', () => {
      collapsed = !collapsed;
      root.dataset.collapsed = collapsed ? '1' : '0';
      root.querySelector('.dshr-min').textContent = collapsed ? '+' : '–';
    });

    // ---------- 拖动、关闭、位置记忆 ----------
    const POS_KEY = 'dsh-reader.pos';
    const head = root.querySelector('.dshr-head');

    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        root.style.left = saved.x + 'px';
        root.style.top = saved.y + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      }
    } catch (err) { /* 忽略 */ }

    let dragState = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = root.getBoundingClientRect();
      dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const w = root.offsetWidth || 280;
      const x = Math.max(0, Math.min(window.innerWidth - w - 4, e.clientX - dragState.dx));
      const y = Math.max(0, Math.min(window.innerHeight - 44, e.clientY - dragState.dy));
      root.style.left = x + 'px';
      root.style.top = y + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    });
    head.addEventListener('pointerup', () => {
      if (!dragState) return;
      dragState = null;
      try {
        const r = root.getBoundingClientRect();
        localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      } catch (err) { /* 忽略 */ }
    });
    head.addEventListener('dblclick', () => {
      root.style.left = '';
      root.style.top = '';
      root.style.right = '16px';
      root.style.bottom = '16px';
      try { localStorage.removeItem(POS_KEY); } catch (err) { /* 忽略 */ }
    });

    root.querySelector('.dshr-close').addEventListener('click', () => {
      root.style.display = 'none';
      toast('面板已关闭，Alt+P 可找回');
    });

    // 检查更新：优先 GitHub API（无 CDN 延迟），失败退回 raw
    async function fetchRemoteVersion() {
      try {
        const res = await fetch(UPDATE_API, {
          headers: { Accept: 'application/vnd.github.raw' },
          cache: 'no-store',
        });
        if (res.ok) {
          const text = await res.text();
          const m = /\/\/\s*@version\s+([\d.]+)/.exec(text);
          if (m) return m[1];
        }
      } catch (err) { /* 忽略，走 raw 回退 */ }
      const res = await fetch(UPDATE_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const m = /\/\/\s*@version\s+([\d.]+)/.exec(text);
      if (!m) throw new Error('解析版本号失败');
      return m[1];
    }

    function showUpdateLink(remote) {
      const a = root.querySelector('.dshr-update-link');
      if (!a) return;
      a.href = UPDATE_URL + '?t=' + Date.now();
      a.textContent = '安装 v' + remote;
      a.style.display = '';
    }

    root.querySelector('[data-act="update"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const a = root.querySelector('.dshr-update-link');
      if (a) a.style.display = 'none';
      toast('正在检查更新…');
      try {
        const remote = await fetchRemoteVersion();
        if (compareVersions(remote, SCRIPT_VERSION) > 0) {
          toast('发现 v' + remote + '，正在打开安装页…');
          // 用户手势后几秒内 window.open 通常放行；被拦截时退化为面板里的链接
          const win = window.open(UPDATE_URL, '_blank', 'noopener');
          if (!win) {
            showUpdateLink(remote);
            toast('发现 v' + remote + '，点面板里的「安装」');
          }
        } else {
          toast('已是最新版本 v' + SCRIPT_VERSION + '（远程 ' + remote + '）');
        }
      } catch (err) {
        toast('检查更新失败：' + (err && err.message ? err.message : err));
      }
    });

    btnPause.addEventListener('click', togglePause);
    root.querySelector('[data-act="stop"]').addEventListener('click', () => stop());

    // ---------- 进度条：可拖动、可点击 ----------
    let dragging = false;

    function ratioAt(clientX) {
      const r = barBox.getBoundingClientRect();
      if (!r.width) return 0;
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    }

    function sentenceAt(clientX) {
      if (!state.sentences.length) return 0;
      return Math.min(state.sentences.length - 1, Math.floor(ratioAt(clientX) * state.sentences.length));
    }

    function showHint(clientX) {
      if (!state.sentences.length) return;
      const i = sentenceAt(clientX);
      const s = state.sentences[i] || '';
      hintEl.textContent = '第 ' + (i + 1) + ' / ' + state.sentences.length + ' 句：' + s.slice(0, 22) + (s.length > 22 ? '…' : '');
      hintEl.style.opacity = '0.8';
      return i;
    }

    function seekTo(clientX) {
      if (!state.sentences.length) { toast('先读一条消息'); return; }
      const i = sentenceAt(clientX);
      startFrom(i);
      toast('从第 ' + (i + 1) + ' / ' + state.sentences.length + ' 句开始');
    }

    barBox.addEventListener('pointerdown', (e) => {
      if (!state.sentences.length) { toast('先读一条消息'); return; }
      dragging = true;
      try { barBox.setPointerCapture(e.pointerId); } catch (err) {}
      const i = showHint(e.clientX);
      bar.style.width = Math.round(((i + 1) / state.sentences.length) * 100) + '%';
      e.preventDefault();
    });

    barBox.addEventListener('pointermove', (e) => {
      if (!state.sentences.length) return;
      if (dragging) {
        const i = showHint(e.clientX);
        bar.style.width = Math.round(((i + 1) / state.sentences.length) * 100) + '%';
      } else {
        showHint(e.clientX);
      }
    });

    barBox.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      seekTo(e.clientX);
    });

    barBox.addEventListener('pointercancel', () => { dragging = false; });

    barBox.addEventListener('pointerleave', () => {
      if (dragging) return;
      hintEl.textContent = '拖动/点击进度条跳句 · Alt+点正文从该句开始';
      hintEl.style.opacity = '0.5';
    });

    rateInput.value = String(state.rate);
    rateLabel.textContent = state.rate.toFixed(1);

    // 从"当前念到的位置"接着念：改语速 / 音量 / 音色都走这里，最多重复 3 个字
    function resumeAtBoundary(msg) {
      const b = state.boundary;
      const cur = state.chunks[state.index];
      if (!(b && cur && b.i === state.index)) return false;
      const from = Math.max(0, b.charIndex - 3);
      const prefix = cur.text.slice(from);
      synth.cancel();
      state.gen += 1;
      const gen = state.gen;
      const rest = prefix ? [{ text: prefix, from: cur.from }] : [];
      state.chunks = rest.concat(state.chunks.slice(state.index + 1));
      state.index = 0;
      state.queued = 0;
      state.boundary = null;
      state.playing = true;
      state.paused = false;
      render();
      setTimeout(() => { if (gen === state.gen) fillQueue(gen); }, 60);
      toast(msg);
      return true;
    }

    function applyRate() {
      const v = Number(rateInput.value);
      rateLabel.textContent = v.toFixed(1);
      if (v === state.rate) return;
      state.rate = v;
      localStorage.setItem(LS_RATE, String(v));
      if (!state.playing) return;
      if (!resumeAtBoundary('语速改为 ' + v.toFixed(1) + '，接着念')) {
        toast('语速改为 ' + v.toFixed(1) + '，下一段生效');
      }
    }

    let rateTimer = 0;
    // 拖动过程中只更新数字；停下 350ms 或松手时才真正应用，避免反复重排
    rateInput.addEventListener('input', () => {
      rateLabel.textContent = Number(rateInput.value).toFixed(1);
      clearTimeout(rateTimer);
      rateTimer = setTimeout(applyRate, 350);
    });
    rateInput.addEventListener('change', () => {
      clearTimeout(rateTimer);
      applyRate();
    });

    // ---------- 音量 ----------
    const fmtVol = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    volInput.value = String(state.volume);
    volLabel.textContent = fmtVol(state.volume);

    function applyVolume() {
      const v = Number(volInput.value);
      volLabel.textContent = fmtVol(v);
      if (v === state.volume) return;
      state.volume = v;
      localStorage.setItem(LS_VOL, String(v));
      if (!state.playing) return;
      if (!resumeAtBoundary('音量改为 ' + fmtVol(v) + '，接着念')) {
        toast('音量改为 ' + fmtVol(v) + '，下一段生效');
      }
    }

    let volTimer = 0;
    volInput.addEventListener('input', () => {
      volLabel.textContent = fmtVol(Number(volInput.value));
      clearTimeout(volTimer);
      volTimer = setTimeout(applyVolume, 250);
    });
    volInput.addEventListener('change', () => {
      clearTimeout(volTimer);
      applyVolume();
    });

    // ---------- 音色：标亮当前选择 + 自动试听 ----------
    function updateVoiceBadge() {
      const nameEl = root.querySelector('.dshr-voice-name');
      if (nameEl) nameEl.textContent = state.voiceName || '（系统默认）';
    }

    function speakSample() {
      const u = new SpeechSynthesisUtterance('你好，我是当前选择的音色。');
      u.lang = 'zh-CN';
      u.rate = state.rate;
      u.volume = state.volume;
      const v = pickVoice();
      if (v) u.voice = v;
      synth.speak(u);
    }

    function previewVoice() {
      // 正在朗读：从当前位置换声接着念，立刻能听到新音色
      if (state.playing) {
        if (!resumeAtBoundary('已切换音色，继续朗读')) toast('已切换音色，下一段生效');
        return;
      }
      stop();
      speakSample();
    }

    voiceSel.addEventListener('change', () => {
      state.voiceName = voiceSel.value;
      localStorage.setItem(LS_VOICE, state.voiceName);
      updateVoiceBadge();
      previewVoice();
    });

    // 标题栏的语速 / 音量按钮：点开对应的弹出条
    root.querySelectorAll('.dshr-head button[data-act]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const name = btn.dataset.act;
        if (name !== 'rate' && name !== 'vol') return;
        const pop = root.querySelector('.dshr-pop[data-pop="' + name + '"]');
        const wasOpen = pop && pop.dataset.open === '1';
        root.querySelectorAll('.dshr-pop').forEach((p) => { p.dataset.open = '0'; });
        if (pop) pop.dataset.open = wasOpen ? '0' : '1';
      });
    });

    document.addEventListener('click', (ev) => {
      if (root && root.contains(ev.target)) return;
      root.querySelectorAll('.dshr-pop').forEach((p) => { p.dataset.open = '0'; });
    }, true);

    fillVoices();
    if (synth.addEventListener) synth.addEventListener('voiceschanged', fillVoices);
  }

  function fillVoices() {
    if (!voiceSel) return;
    const voices = zhVoices();
    const prev = state.voiceName;
    voiceSel.innerHTML = '';
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name + ' (' + v.lang + ')' + (v.localService === false ? ' · 在线' : '');
      voiceSel.appendChild(o);
    });
    const chosen = voices.find((v) => v.name === prev) || pickVoice();
    if (chosen) {
      voiceSel.value = chosen.name;
      state.voiceName = chosen.name;
    }
    const nameEl = root && root.querySelector('.dshr-voice-name');
    if (nameEl) nameEl.textContent = state.voiceName || '（系统默认）';
  }

  function render(msg) {
    if (!root) return;
    const total = state.sentences.length || 0;
    const done = state.chunks[state.index] ? state.chunks[state.index].from : (state.playing ? 0 : total);

    if (msg) statusEl.textContent = msg;
    else if (state.playing) {
      statusEl.textContent = (state.paused ? '已暂停' : '朗读中') + ' · 第 ' + (done + 1) + ' / ' + total + ' 句';
    } else if (total && done >= total) {
      statusEl.textContent = '朗读完成';
    }

    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (bar) bar.style.width = pct + '%';
    if (curEl) curEl.textContent = state.current && state.playing ? state.current : '';
    if (btnPause) btnPause.textContent = state.paused ? '▶' : '⏸';
  }

  let toastEl = null;
  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', right: '16px', bottom: '110px', zIndex: '2147483647',
        background: 'rgba(24,26,31,.96)', color: '#e8eaed', padding: '6px 10px',
        borderRadius: '8px', font: '12px/1.5 "Microsoft YaHei", sans-serif',
        border: '1px solid rgba(255,255,255,.14)', pointerEvents: 'none',
        opacity: '0', transition: 'opacity .2s',
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 2000);
  }

  // 左下角的探针：脚本有没有跑、初始化有没有报错，直接显示在页面上
  let probeEl = null;
  function probeNote(msg, bad) {
    try {
      if (!document.body) return;
      if (!probeEl) {
        probeEl = document.createElement('div');
        probeEl.id = 'dsh-probe';
        probeEl.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;'
          + 'font:12px/1.5 monospace;background:#2d6cdf;color:#fff;padding:6px 10px;'
          + 'border-radius:8px;max-width:70vw;box-shadow:0 4px 16px rgba(0,0,0,.4)';
        document.body.appendChild(probeEl);
      }
      probeEl.textContent = '🔊 dsh朗读 ' + msg;
      probeEl.style.background = bad ? '#c0392b' : '#2d6cdf';
      probeEl.style.display = '';
    } catch (err) { /* 忽略 */ }
  }
  function probeHide() {
    if (probeEl) probeEl.style.display = 'none';
  }

  // 行高亮：每个文档一个覆盖框（顶层 + 同源 iframe 各一份）
  const hoverHlDocs = new Map();
  function ensureHighlight(doc) {
    const d = doc || document;
    let el = hoverHlDocs.get(d);
    if (el && el.isConnected) return el;
    el = d.createElement('div');
    el.id = 'dsh-line-hl';
    el.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;'
      + 'background:rgba(107,138,253,.20);border:1px solid rgba(107,138,253,.55);'
      + 'border-radius:4px;display:none;box-sizing:border-box;transition:all .05s linear';
    (d.body || d.documentElement).appendChild(el);
    hoverHlDocs.set(d, el);
    return el;
  }
  function hideHighlight(doc) {
    if (doc) {
      const el = hoverHlDocs.get(doc);
      if (el) el.style.display = 'none';
      return;
    }
    hoverHlDocs.forEach((el) => { if (el) el.style.display = 'none'; });
  }

  /* ---------------- 事件 ---------------- */

  function turnAtPoint(x, y, doc) {
    const d = doc || document;
    const turns = d.querySelectorAll(TURN_SEL);
    for (const t of turns) {
      const r = t.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return t;
      }
    }
    return null;
  }

  function blockAtPoint(x, y, doc) {
    const d = doc || document;
    let el = deepElementFromPoint(x, y, d);
    while (el && el !== d.body) {
      const txt = (el.innerText || '').trim();
      if (txt.length > 60 && txt.length < 20000) return el;
      el = el.parentElement;
    }
    return null;
  }

  function handleAltClick(e, doc) {
    const d = doc || document;
    if (!e.altKey) return;
    const win = d.defaultView || window;
    const sel = String(win.getSelection ? win.getSelection() : '').trim();
    const path = (e.composedPath && e.composedPath()) || [];
    const realTarget = path[0] || e.target;
    const turn = pickTurn(realTarget) || turnAtPoint(e.clientX, e.clientY, d);

    // 通用模式：不在聊天消息里（ThoughtDAG 画布、普通网页）
    if (!turn) {
      e.preventDefault();
      e.stopPropagation();
      if (sel.length > 1) {
        state.scopeEl = null;
        play(sel, '选中内容');
        return;
      }
      const scope = genericScopeAt(realTarget);
      if (!scope) { toast('这里没有可朗读的内容'); return; }
      const blocks = collectBlocks(scope);
      let text = blocks.length ? textFromBlocks(blocks) : (scope.innerText || '').trim();
      if (!text) text = (scope.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) { toast('这里没有可朗读的内容'); return; }
      state.scopeEl = scope;
      state.hlCache = null;
      let offset = offsetOfLineAtPoint(e.clientX, e.clientY, blocks, d);
      if (offset === null || offset === undefined) offset = 0;
      playTextFrom(text, offset, '这段内容');
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (sel.length > 1) {
      state.scopeEl = null;
      play(sel, '选中内容');
      return;
    }
    const scope = scopeOfTurn(turn);
    state.scopeEl = scope;
    state.hlCache = null;
    const blocks = collectBlocks(scope);
    const text = blocks.length ? textFromBlocks(blocks) : textOfTurn(turn);
    let offset = offsetOfLineAtPoint(e.clientX, e.clientY, blocks, d);
    if (offset === null || offset === undefined) offset = offsetOfBlockAtPoint(e.clientX, e.clientY, blocks, d);
    if (offset === null || offset === undefined) offset = 0;
    playTextFrom(text, offset, '这条消息');
  }

  // 鼠标指到哪一行，哪一行就亮
  let hlTick = null;
  function handleHover(e, doc) {
    if (hlTick) return;
    hlTick = requestAnimationFrame(() => {
      hlTick = null;
      const d = doc || document;
      try {
        const hoverPath = (e.composedPath && e.composedPath()) || [];
        const target = hoverPath[0] || e.target;
        if (!target) { hideHighlight(d); return; }
        if (d === document && root && root.contains(target)) { hideHighlight(d); return; }
        const line = lineRectAt(e.clientX, e.clientY, d);
        if (!line || !line.rect) { hideHighlight(d); return; }
        if (!pickTurn(target) && (!line.block || line.block === d.body)) { hideHighlight(d); return; }
        const box = ensureHighlight(d);
        box.style.left = (line.rect.left - 2) + 'px';
        box.style.top = (line.rect.top - 1) + 'px';
        box.style.width = (line.rect.width + 4) + 'px';
        box.style.height = (line.rect.height + 2) + 'px';
        box.style.display = 'block';
      } catch (err) { /* 忽略 */ }
    });
  }

  // 所属文档滚动了，重新定位当前字
  let hlScrollTick = null;
  function handlePageScroll(doc) {
    if (!state.playing || !state.hlChunk || !state.scopeEl) return;
    if ((state.scopeEl.ownerDocument || document) !== doc) return;
    if (hlScrollTick) return;
    hlScrollTick = requestAnimationFrame(() => {
      hlScrollTick = null;
      if (state.playing && state.hlChunk) {
        highlightChar(state.scopeEl, state.hlChunk.text, state.hlChunk.index, { noScroll: true });
      }
    });
  }

  // 用户自己滚动时：暂停自动跟随 2 秒，并停掉正在进行的平滑滚动
  function handleUserScroll(win) {
    state.lastUserScroll = Date.now();
    state.autoScrollAt = Date.now();
    clearTimeout(state.scrollTimer);
    try {
      const y = win.scrollY;
      win.scrollTo({ top: y, behavior: 'auto' });
    } catch (err) { /* 忽略 */ }
  }

  function handleKey(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'x') {
      e.preventDefault();
      stop();
    } else if (k === 'p') {
      e.preventDefault();
      togglePanel();
    }
  }

  // 把同一套监听挂到顶层文档和各个同源 iframe 上
  const attachedDocs = new WeakSet();
  function attachDoc(doc) {
    if (!doc || !doc.body || attachedDocs.has(doc)) return;
    attachedDocs.add(doc);
    doc.addEventListener('click', (e) => handleAltClick(e, doc), true);
    doc.addEventListener('mousemove', (e) => handleHover(e, doc), { passive: true });
    doc.addEventListener('keydown', handleKey, true);
    doc.addEventListener('mouseleave', () => hideHighlight(doc));
    doc.addEventListener('scroll', () => {
      hideHighlight(doc);
      handlePageScroll(doc);
    }, true);
    const win = doc.defaultView;
    if (win) {
      win.addEventListener('blur', () => hideHighlight(doc));
      ['wheel', 'touchstart'].forEach((evt) => {
        win.addEventListener(evt, () => handleUserScroll(win), { passive: true, capture: true });
      });
    }
  }

  function attachFrames() {
    attachDoc(document);
    document.querySelectorAll('iframe').forEach((f) => {
      try {
        const doc = f.contentDocument;
        if (doc && doc.body) attachDoc(doc);
      } catch (err) { /* 跨域忽略 */ }
    });
  }

  function ensureAttached() {
    if (!root || !document.body) return;
    if (!root.isConnected) document.body.appendChild(root);
    hoverHlDocs.forEach((el, doc) => {
      if (el && !el.isConnected && doc.body) doc.body.appendChild(el);
    });
  }

  function togglePanel() {
    if (!root) return;
    const hidden = root.style.display === 'none';
    root.style.display = hidden ? '' : 'none';
    toast(hidden ? '面板已显示' : '面板已隐藏，Alt+P 可找回');
  }

  let booted = false;
  function boot() {
    if (booted) return;
    if (!document.body) { setTimeout(boot, 50); return; }
    booted = true;
    probeNote('v' + SCRIPT_VERSION + ' 已注入，初始化中…');

    // 单实例保护：页面上已经有面板就不再建第二个（重复安装时最常见的问题）
    const existing = document.getElementById('dsh-reader');
    if (existing) {
      const oldVer = existing.dataset.version || '未知';
      console.warn('[dsh-reader] 已存在面板（' + oldVer + '），本次注入跳过。'
        + '若功能异常或版本不符，请到脚本猫里删除重复的脚本后刷新。');
      window.__dshProbe = 'v' + SCRIPT_VERSION + ' (skipped, running: ' + oldVer + ')';
      return;
    }

    // 清掉上一次残留的覆盖层（面板被关闭/页面切换时可能留下）
    document.querySelectorAll('.dshr-play-hl').forEach((n) => n.remove());
    const lineHl = document.getElementById('dsh-line-hl');
    if (lineHl) lineHl.remove();
    const staleProbe = document.getElementById('dsh-probe');
    if (staleProbe) staleProbe.remove();

    try {
      injectStyle();
      build();
      root.dataset.version = SCRIPT_VERSION;
      render('就绪 · Alt+点击任意消息朗读');
      setTimeout(probeHide, 1800);
    } catch (err) {
      console.error('[dsh-reader] 初始化失败：', err);
      probeNote('初始化失败：' + (err && err.message ? err.message : err), true);
      return;
    }
    try {
      new MutationObserver(() => ensureAttached()).observe(document.body, { childList: true });
    } catch (err) { /* 忽略 */ }
    setInterval(ensureAttached, 2000);
    // 顶层监听 + 同源 iframe 监听（ThoughtDAG 画布在 iframe 里）
    attachFrames();
    setInterval(attachFrames, 2000);
    console.log('[dsh-reader] v' + SCRIPT_VERSION + ' 已注入:', location.href,
      '| turns =', document.querySelectorAll(TURN_SEL).length,
      '| answers =', document.querySelectorAll(ANSWER_SEL).length,
      '| voices =', (synth.getVoices() || []).length);
  }

  // document-start 注入时 body 可能还不存在，等它出现
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
    setTimeout(boot, 300);
  } else {
    boot();
  }
})();
