// ==UserScript==
// @name         dsh web 朗读
// @namespace    local.dsh.reader
// @version      1.10.0
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

  // 注入标记：Console 里敲 window.__dshProbe 就能确认脚本是否执行到这一行
  window.__dshProbe = 'v1.10.0';

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
    warned: false,
    gen: 0,
    current: null,
    boundary: null,
  };
  window.__dshState = state; // 调试用

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
      let t = (el.innerText || el.textContent || '').trim();
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

  // 点击位置 → 命中的块 → 该块在全文里的起始偏移
  function offsetOfBlockAtPoint(x, y, blocks) {
    const el = document.elementFromPoint(x, y);
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

  function lineRectAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const block = blockOf(el);
    if (!block) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const len = (node.textContent || '').length;
      if (!len) continue;
      const r = document.createRange();
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
    const len = (node.textContent || '').length;
    if (!len) return 0;
    const r = document.createRange();
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
  function offsetOfLineAtPoint(x, y, blocks) {
    const hit = lineRectAt(x, y);
    if (!hit) return null;
    let block = null;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].el === hit.block || blocks[i].el.contains(hit.block)) { block = blocks[i]; break; }
    }
    if (!block) return null;
    try {
      const r = document.createRange();
      r.selectNodeContents(block.el);
      r.setEnd(hit.node, lineStartOf(hit.node, hit.rect));
      return block.start + r.toString().length;
    } catch (err) {
      return block.start;
    }
  }

  /* ---------------- 语音 ---------------- */

  function zhVoices() {
    const all = synth.getVoices() || [];
    const zh = all.filter((v) => /zh[-_]?CN|Chinese|中文|普通话|國語/i.test(v.lang + ' ' + v.name));
    return zh.length ? zh : all;
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
    synth.cancel();
    render();
  }

  function finish() {
    state.playing = false;
    state.paused = false;
    state.current = null;
    state.index = state.chunks.length;
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
      render();
    };

    // 记录"念到第几个字"，改语速时从这里接着念，几乎不用回头
    u.onboundary = (ev) => {
      if (gen !== state.gen) return;
      if (typeof ev.charIndex === 'number') state.boundary = { i, charIndex: ev.charIndex };
    };

    u.onend = () => {
      if (gen !== state.gen || !state.playing) return;
      if (i >= state.chunks.length - 1) { finish(); return; }
      fillQueue(gen);
    };

    u.onerror = (e) => {
      if (gen !== state.gen) return;
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

  function togglePause() {
    if (!state.playing) return;
    if (state.paused) {
      synth.resume();
      state.paused = false;
      render();
    } else {
      synth.pause();
      state.paused = true;
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
      #dsh-reader[data-collapsed="1"] { width: 190px; padding: 6px 8px; }
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
      o.textContent = v.name + ' (' + v.lang + ')';
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

  // 行高亮：一个覆盖在正文行上的半透明框（不改 DOM，不会跟 React 打架）
  let hlEl = null;
  function ensureHighlight() {
    if (hlEl && hlEl.isConnected) return hlEl;
    hlEl = document.createElement('div');
    hlEl.id = 'dsh-line-hl';
    hlEl.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;'
      + 'background:rgba(107,138,253,.20);border:1px solid rgba(107,138,253,.55);'
      + 'border-radius:4px;display:none;box-sizing:border-box;transition:all .05s linear';
    document.body.appendChild(hlEl);
    return hlEl;
  }
  function hideHighlight() {
    if (hlEl) hlEl.style.display = 'none';
  }

  /* ---------------- 事件 ---------------- */

  function turnAtPoint(x, y) {
    const turns = document.querySelectorAll(TURN_SEL);
    for (const t of turns) {
      const r = t.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return t;
      }
    }
    return null;
  }

  function blockAtPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.body) {
      const txt = (el.innerText || '').trim();
      if (txt.length > 60 && txt.length < 20000) return el;
      el = el.parentElement;
    }
    return null;
  }

  document.addEventListener('click', (e) => {
    if (!e.altKey) return;
    const turn = pickTurn(e.target) || turnAtPoint(e.clientX, e.clientY);
    if (!turn) {
      const block = blockAtPoint(e.clientX, e.clientY);
      if (!block) { toast('这里没有可朗读的内容'); return; }
      e.preventDefault();
      e.stopPropagation();
      play(block.innerText || '', '这段内容');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const scope = scopeOfTurn(turn);
    const blocks = collectBlocks(scope);
    const text = blocks.length ? textFromBlocks(blocks) : textOfTurn(turn);
    let offset = offsetOfLineAtPoint(e.clientX, e.clientY, blocks);
    if (offset === null || offset === undefined) offset = offsetOfBlockAtPoint(e.clientX, e.clientY, blocks);
    if (offset === null || offset === undefined) offset = 0;
    playTextFrom(text, offset, '这条消息');
  }, true);

  // 鼠标指到哪一行，哪一行就亮
  let hlTick = null;
  document.addEventListener('mousemove', (e) => {
    if (hlTick) return;
    hlTick = requestAnimationFrame(() => {
      hlTick = null;
      try {
        const target = e.target;
        if (!target || (root && root.contains(target))) { hideHighlight(); return; }
        const turn = pickTurn(target);
        if (!turn) { hideHighlight(); return; }
        const line = lineRectAt(e.clientX, e.clientY);
        if (!line || !line.rect) { hideHighlight(); return; }
        const box = ensureHighlight();
        box.style.left = (line.rect.left - 2) + 'px';
        box.style.top = (line.rect.top - 1) + 'px';
        box.style.width = (line.rect.width + 4) + 'px';
        box.style.height = (line.rect.height + 2) + 'px';
        box.style.display = 'block';
      } catch (err) { /* 忽略 */ }
    });
  }, { passive: true });

  document.addEventListener('mouseleave', hideHighlight);
  document.addEventListener('scroll', hideHighlight, true);
  window.addEventListener('blur', hideHighlight);

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'x') {
      e.preventDefault();
      stop();
    } else if (k === 'p') {
      e.preventDefault();
      togglePanel();
    }
  });

  function ensureAttached() {
    if (!root || !document.body) return;
    if (!root.isConnected) document.body.appendChild(root);
    if (hlEl && !hlEl.isConnected) document.body.appendChild(hlEl);
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
    probeNote('v1.5.0 已注入，初始化中…');
    try {
      injectStyle();
      build();
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
    console.log('[dsh-reader] v1.10.0 已注入:', location.href,
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
