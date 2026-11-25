// ==UserScript==
// @name         dsh web 朗读
// @namespace    local.dsh.reader
// @version      1.19.0
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
  const LOCAL_VERSION = '1.19.0';
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
  // 构建标记：确认装的是哪一版（版本号没变时靠它区分）
  window.__dshBuild = SCRIPT_VERSION + '+local-fallback';

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
  const LS_LOCAL = 'dsh-reader.local';
  const LS_AUTO = 'dsh-reader.auto';
  // 本地语音服务（tools/tts-server 启动后监听这个地址）
  const LOCAL_TTS = 'http://127.0.0.1:5050';
  const CHUNK_CHARS = 300;
  const BLOCK_TAGS = /^(P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|TD|TH|PRE|DIV|SECTION|ARTICLE)$/;

  const state = {
    sentences: [],
    chunks: [],
    index: 0,
    queued: 0,
    progress: 0,
    local: localStorage.getItem(LS_LOCAL) === '1',
    // 自动朗读：只在回合结束时读明确的回答容器（见 scanAuto）
    auto: localStorage.getItem(LS_AUTO) === '1',
    autoSeen: new Set(),
    autoBaseline: 0,
    autoHref: '',
    autoInit: false,
    autoTimer: 0,
    autoListEl: null,
    autoSession: '',
    resume: null,
    autoWaitLogged: new Set(),
    lastSpeakAt: 0,
    localReady: false,
    localAudio: null,
    localToken: 0,
    localTimer: 0,
    localUrls: new Map(),
    localTimings: new Map(),
    timingMaps: new Map(),
    rate: Number(localStorage.getItem(LS_RATE) || 1) || 1,
    voiceName: localStorage.getItem(LS_VOICE) || '',
    volume: Number(localStorage.getItem(LS_VOL) ?? 1),
    playing: false,
    playKind: '',
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

  // 测试钩子：纯函数在 Node 里用 vm 加载本文件时可见（浏览器里只是多挂一个对象，无副作用）
  window.__dshTest = {
    splitSentences,
    buildChunksFrom,
    textFromBlocks,
    compareVersions,
    estimateFor,
    uniqueTurnIds,
    pickNewTurns,
    shouldAutoRead,
  };

  /* ---------------- 文本处理 ---------------- */

  function splitSentences(raw) {
    let text = String(raw || '')
      .replace(/\r/g, '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text) return [];

    // 朗读单位按标点切（念起来自然）；"按行"只用于点击定位
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

  function buildChunksFrom(start, maxChars) {
    const limit = maxChars || CHUNK_CHARS;
    const chunks = [];
    let buf = '';
    let from = start;
    for (let i = start; i < state.sentences.length; i += 1) {
      const s = state.sentences[i];
      if (buf && buf.length + s.length > limit) {
        chunks.push({ text: buf, from, to: i });
        buf = s;
        from = i;
      } else {
        // 上一句没有句末标点时用换行隔开，避免两句黏在一起听不清
        buf += (buf && !/[。！？!?；;…]$/.test(buf) ? '\n' : '') + s;
      }
    }
    if (buf) chunks.push({ text: buf, from, to: state.sentences.length });
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

  /* ---------------- 自动朗读：判定逻辑（纯函数，单测覆盖） ---------------- */

  // 把 data-chat-turn 的值去重、排序、丢掉非法值
  function uniqueTurnIds(values) {
    const seen = new Set();
    const out = [];
    for (const v of values || []) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out.sort((a, b) => a - b);
  }

  // 基线之后、还没读过的回合
  function pickNewTurns(ids, seen, baseline) {
    const done = new Set(seen || []);
    const base = baseline || 0;
    return uniqueTurnIds(ids).filter((n) => n > base && !done.has(n));
  }

  // 值不值得自动读：至少两个字，且含字母/数字/汉字（纯标点、纯空白不读）
  function shouldAutoRead(text) {
    const t = String(text || '').replace(/\s+/g, '');
    return t.length >= 2 && /[\p{L}\p{N}]/u.test(t);
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

  /* ---------------- 自动朗读：只认 dsh 的 data 属性，不猜类名 ---------------- */

  // 一轮 = 同一个 data-chat-turn 下的若干行；回答行自己有 data-turn-process-answer
  // （过程被折起时）或 data-chat-flow-kind="assistant"。
  function autoRows(turn) {
    return Array.prototype.slice.call(document.querySelectorAll('[data-chat-turn="' + turn + '"]'));
  }

  function answerElOf(turn) {
    const rows = autoRows(turn);
    for (const r of rows) if (r.hasAttribute('data-turn-process-answer')) return r;
    for (const r of rows) if (r.getAttribute('data-chat-flow-kind') === 'assistant') return r;
    return null; // 找不到明确回答容器就不读——宁可漏读，也不猜
  }

  // dsh 只在一轮结束时渲染 [data-turn-tail]，且只有结束时才带 data-actions-reveal
  // （生成中那个分支不带）。两个一起查，避免"尾标先挂、正文还在补"。
  function turnClosed(turn) {
    return !!document.querySelector('[data-turn-tail="' + turn + '"][data-actions-reveal]');
  }

  function textOfEl(el) {
    const blocks = collectBlocks(el);
    return blocks.length ? textFromBlocks(blocks) : (el.innerText || '').trim();
  }

  function enqueueAuto(turn, text, el) {
    if (state.playing) {
      // 新回复总是抢占：自动模式就是"追最新"。
      // 想安静听完一条手动朗读，先把自动朗读关掉。
      autoLog('preempt', { turn, kind: state.playKind });
      stop();
    }
    // 高亮和自动滚动都挂在 scopeEl 上：手动朗读会设，自动朗读也必须设，否则没有高亮
    state.scopeEl = el || null;
    state.hlCache = null;
    autoLog('play', { turn, textLen: text.length });
    play(text, '自动朗读', 'auto');
  }

  // 决策日志：控制台 __dshAutoLog 看最近 50 条，用来回答"它为什么没读"
  window.__dshAutoLog = [];
  function autoLog(event, data) {
    const entry = Object.assign({ at: new Date().toISOString().slice(11, 19), event }, data || {});
    window.__dshAutoLog.push(entry);
    if (window.__dshAutoLog.length > 50) window.__dshAutoLog.shift();
  }

  // 状态说在播、引擎却说没在播 → 认为已经结束，把卡住的队列放出来。
  // 2 秒保护期，避免 speak 刚调用、speaking 还没置位的窗口误判。
  function autoWatchdog() {
    if (!state.auto || !state.playing || state.paused || state.local) return;
    if (Date.now() - (state.lastSpeakAt || 0) < 4000) return;
    if (synth.speaking || synth.pending) return;
    autoLog('stuck-finish');
    finish();
  }

  // F5：切走前记住"读到哪"，回到同一会话时提供续读
  function saveResume() {
    if (!state.playing) return;
    const scope = state.scopeEl;
    const turnEl = scope && scope.closest ? scope.closest('[data-chat-turn]') : null;
    const turnId = turnEl ? Number(turnEl.getAttribute('data-chat-turn')) : 0;
    if (!turnId || !state.sentences.length) return;
    state.resume = {
      session: state.autoSession || '',
      turn: turnId,
      index: Math.max(0, Math.min(state.sentences.length - 1, Math.floor(state.progress || 0))),
      sentences: state.sentences.slice(),
    };
  }

  function updateResumeUI() {
    if (!root) return;
    const btn = root.querySelector('.dshr-resume');
    if (!btn) return;
    const r = state.resume;
    if (r && r.session && r.session === state.autoSession) {
      btn.style.display = '';
      btn.textContent = '继续上次朗读（第 ' + (r.index + 1) + ' 句）';
    } else {
      btn.style.display = 'none';
    }
  }

  function resumeLast() {
    const r = state.resume;
    if (!r) { toast('没有可续读的内容'); return; }
    const el = answerElOf(r.turn);
    if (!el) {
      toast('找不到上次的内容，可能已被清理');
      state.resume = null;
      updateResumeUI();
      return;
    }
    state.scopeEl = el;
    state.hlCache = null;
    state.sentences = r.sentences.slice();
    const idx = Math.max(0, Math.min(r.index, r.sentences.length - 1));
    if (state.local && state.localReady) {
      stop();
      state.chunks = localBuildChunks(idx);
      state.queued = 0;
      localPlay(0);
    } else {
      startFrom(idx);
    }
    state.resume = null;
    updateResumeUI();
    toast('从第 ' + (idx + 1) + ' 句继续');
  }

  // 切会话：一律停掉朗读——内容已经不在当前会话里了，继续读只会对着空白念。
  // 以前对手动朗读放行，结果暂停状态跨会话存活、高亮卡在已删除节点上（B1）。
  function resetForNewSession() {
    const wasActive = state.playing || synth.speaking || synth.pending;
    if (wasActive) {
      autoLog('session-reset', { kind: state.playKind });
      stop();
      toast('会话已切换，朗读已停止');
    }
    state.scopeEl = null;
    clearPlayHighlight();
    markAutoBaseline();
    updateResumeUI();
  }

  // 唯一的换会话入口：先用【旧】会话号保存续读位置，再切到新会话。
  // 顺序反了的话，续读会被记到新会话名下，切回来就对不上了。
  function onSessionChange(newId) {
    saveResume();
    state.autoSession = newId;
    resetForNewSession();
  }

  function scanAuto() {
    if (!state.auto) return;
    autoWatchdog();
    const rows = document.querySelectorAll('[data-chat-turn]');
    const ids = Array.prototype.map.call(rows, (r) => r.getAttribute('data-chat-turn'));
    const list = uniqueTurnIds(ids);
    const sessionEl = document.querySelector('[data-conversation-session]');
    const sessionId = sessionEl ? (sessionEl.getAttribute('data-conversation-session') || '') : '';
    // 首次扫描：页面上已有的回合都算基线，只读之后的新回复
    if (!state.autoInit) {
      if (!list.length) return;
      state.autoInit = true;
      state.autoSession = sessionId;
      markAutoBaseline();
      return;
    }
    // 换会话：dsh 把 sessionId 写在 [data-conversation-session] 上，直接比它
    if (sessionId && state.autoSession && sessionId !== state.autoSession) {
      autoLog('new-session', { to: sessionId.slice(0, 8) });
      onSessionChange(sessionId);
      return;
    }
    if (sessionId && !state.autoSession) state.autoSession = sessionId;
    // 兜底：URL 变了，或回合号整体回退
    if (location.href !== state.autoHref || (list.length && list[list.length - 1] < state.autoBaseline)) {
      resetForNewSession();
      return;
    }
    const fresh = pickNewTurns(list, state.autoSeen, state.autoBaseline);
    for (const turn of fresh) {
      if (!turnClosed(turn)) {
        // 每个回合只记一次 wait，别把日志刷满
        if (!state.autoWaitLogged.has(turn)) {
          state.autoWaitLogged.add(turn);
          autoLog('wait', { turn, playing: state.playing });
        }
        continue; // 还在生成，下次扫描再看
      }
      state.autoWaitLogged.delete(turn);
      const el = answerElOf(turn);
      if (!el) {
        autoLog('no-answer', { turn });
        continue; // 回答容器还没渲染出来，下次再看
      }
      const text = textOfEl(el);
      autoLog('ready', { turn, textLen: text.length, playing: state.playing });
      if (!shouldAutoRead(text)) { state.autoSeen.add(turn); autoLog('skip-empty', { turn }); continue; }
      state.autoSeen.add(turn); // 只读一次
      enqueueAuto(turn, text, el);
    }
  }

  function markAutoBaseline() {
    const rows = document.querySelectorAll('[data-chat-turn]');
    const ids = uniqueTurnIds(Array.prototype.map.call(rows, (r) => r.getAttribute('data-chat-turn')));
    state.autoBaseline = ids.length ? ids[ids.length - 1] : 0;
    state.autoHref = location.href;
    state.autoSeen.clear();
  }

  // 会话监听：每 800ms 比对一次 session id。独立于自动朗读——
  // "切会话要停朗读"（B1）和"记住读到哪"（F5）在自动关着时也要成立。
  let sessionWatchTimer = 0;
  function startSessionWatch() {
    if (sessionWatchTimer) return;
    sessionWatchTimer = setInterval(() => {
      const sEl = document.querySelector('[data-conversation-session]');
      const id = sEl ? (sEl.getAttribute('data-conversation-session') || '') : '';
      if (!id) return;
      if (!state.autoSession) { state.autoSession = id; return; }
      if (id !== state.autoSession) {
        onSessionChange(id);
      }
    }, 800);
  }

  let autoObserver = null;
  function startAutoWatch() {    if (autoObserver) return;
    const tick = () => {
      clearTimeout(state.autoTimer);
      state.autoTimer = setTimeout(scanAuto, 250);
    };
    autoObserver = new MutationObserver(tick);
    autoObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-chat-turn', 'data-turn-process-answer', 'data-turn-tail'],
    });
    setInterval(scanAuto, 1500); // 兜底：MutationObserver 漏掉时也能补上
  }

  // 控制台自检：__dshAutoProbe() 看当前 DOM 能不能被正确识别。
  // 先跑它确认契约，再信自动朗读。
  window.__dshAutoProbe = function () {
    const ids = uniqueTurnIds(Array.prototype.map.call(
      document.querySelectorAll('[data-chat-turn]'),
      (r) => r.getAttribute('data-chat-turn'),
    ));
    return ids.map((id) => {
      const answer = answerElOf(id);
      return {
        turn: id,
        closed: turnClosed(id),
        answer: answer
          ? (answer.hasAttribute('data-turn-process-answer')
            ? 'data-turn-process-answer'
            : 'flow-kind=' + answer.getAttribute('data-chat-flow-kind'))
          : null,
        kinds: autoRows(id).map((r) => r.getAttribute('data-chat-flow-kind')),
        seen: state.autoSeen.has(id),
      };
    });
  };
  window.__dshAutoScan = scanAuto;

  // INV1 的探针：任何时刻 synth 和 local 至多一个为 true
  window.__dshSources = function () {
    return {
      synth: !!(synth.speaking || synth.pending),
      local: !!state.localAudio,
      playing: state.playing,
      kind: state.playKind,
    };
  };

  // B1/B2 的探针（只读）：高亮还连不连着、两个引擎在不在响、读到第几句
  window.__dshHlProbe = function () {
    const sEl = document.querySelector('[data-conversation-session]');
    const boxes = Array.from(document.querySelectorAll('.dshr-play-hl'));
    const scope = state.scopeEl;
    return {
      session: sEl ? (sEl.getAttribute('data-conversation-session') || '') : '',
      playing: state.playing,
      paused: state.paused,
      synth: !!(synth.speaking || synth.pending),
      local: !!state.localAudio,
      scopeConnected: !!(scope && scope.isConnected),
      boxes: boxes.length,
      boxDisplay: boxes.length ? (boxes[0].style.display || '') : '',
      index: state.index,
      sentences: state.sentences.length,
      hlTrace: window.__dshHlTrace,
      startCount: state.startCount || 0,
      boundaryCount: state.boundaryCount || 0,
      sinceUserScroll: Date.now() - (state.lastUserScroll || 0),
      scrollTrace: window.__dshScrollTrace.slice(-5),
    };
  };

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

  function lineRectAt(x, y, doc, strict) {
    const el = deepElementFromPoint(x, y, doc);
    if (!el) return null;
    const block = blockOf(el);
    if (!block) return null;
    const d = docOf(block);
    const walker = d.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    const candidates = [];
    while ((node = walker.nextNode())) {
      const len = (node.textContent || '').length;
      if (!len) continue;
      const r = d.createRange();
      r.setStart(node, 0);
      r.setEnd(node, len);
      const rects = Array.prototype.slice.call(r.getClientRects());
      for (let i = 0; i < rects.length; i += 1) {
        const rect = rects[i];
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (y >= rect.top - 2 && y <= rect.bottom + 2 && x >= rect.left - 60 && x <= rect.right + 60) {
          return { node, rect, block };
        }
        candidates.push({ node, rect, block });
      }
    }
    // 悬停时只认命中：不要"最近的一行"，否则鼠标没在文字上也会亮
    if (strict) return null;
    // 点在行与行之间的缝里时，取垂直距离最近的一行（否则会退回从头读）
    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      const cy = (c.rect.top + c.rect.bottom) / 2;
      const farX = x < c.rect.left - 80 || x > c.rect.right + 80;
      const score = Math.abs(cy - y) + (farX ? 40 : 0) + (cy < y ? 0.5 : 0); // 缝隙里优先取下一行
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return bestScore <= 60 ? best : null;
  }

  window.__dshLineAt = (x, y) => {
    const hit = lineRectAt(x, y, document);
    return hit ? { top: hit.rect.top, bottom: hit.rect.bottom, left: hit.rect.left, right: hit.rect.right, block: hit.block.tagName } : null;
  };

  // 鼠标位置对应的文本插入点（比按行矩形猜更准，行距缝隙里也能落到位）
  function caretAt(x, y, doc) {
    const d = doc || document;
    try {
      if (typeof d.caretPositionFromPoint === 'function') {
        const p = d.caretPositionFromPoint(x, y);
        if (p && p.offsetNode) return { node: p.offsetNode, offset: p.offset };
      }
      if (typeof d.caretRangeFromPoint === 'function') {
        const r = d.caretRangeFromPoint(x, y);
        if (r && r.startContainer) return { node: r.startContainer, offset: r.startOffset };
      }
    } catch (err) { /* 忽略 */ }
    return null;
  }

  // 点击位置 → 全文偏移：只问浏览器光标落在哪，不再按行扫描
  // （按行定位对"知道大概读到哪"没有帮助，还多一次点击时的计算）
  function offsetOfLineAtPoint(x, y, blocks, doc) {
    const caret = caretAt(x, y, doc || document);
    if (!caret || !caret.node) return null;
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block.el === caret.node || block.el.contains(caret.node)) {
        try {
          const cr = docOf(block.el).createRange();
          cr.selectNodeContents(block.el);
          cr.setEnd(caret.node, Math.min(caret.offset, (caret.node.textContent || '').length));
          return block.start + cr.toString().length;
        } catch (err) {
          return block.start;
        }
      }
    }
    return null;
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
  // B2 探针：最近几次滚动决策，回答"为什么视野没跟"
  window.__dshScrollTrace = [];
  function scrollTrace(entry) {
    window.__dshScrollTrace.push(Object.assign({ at: Date.now() }, entry));
    if (window.__dshScrollTrace.length > 30) window.__dshScrollTrace.shift();
  }

  function revealRect(rect, node) {
    if (!rect) { scrollTrace({ skip: 'no-rect' }); return; }
    if (state.paused) { scrollTrace({ skip: 'paused' }); return; }
    const now = Date.now();
    // 用户刚手动滚过，先别抢控制权
    if (now - (state.lastUserScroll || 0) < 2000) {
      scrollTrace({ skip: 'user-scroll', age: now - (state.lastUserScroll || 0) });
      return;
    }
    // 我们自己刚滚过，等它稳定，避免和滚动事件互相拉扯
    if (now - (state.autoScrollAt || 0) < 500) { scrollTrace({ skip: 'just-scrolled' }); return; }
    const vh = window.innerHeight;
    const target = vh * 0.45;
    const delta = rect.top - target;
    if (Math.abs(delta) < 8) { scrollTrace({ skip: 'in-place', delta: Math.round(delta) }); return; }
    if (now - (state.lastScrollAt || 0) < 250) { scrollTrace({ skip: 'throttled' }); return; }
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
    const sName = scroller ? String(scroller.className || scroller.tagName).slice(0, 28) : 'window';
    const before = scroller ? scroller.scrollTop : win.scrollY;
    scrollTrace({ scroll: Math.round(delta), top: Math.round(rect.top), scroller: sName, before: Math.round(before) });
    try {
      if (scroller) scroller.scrollBy({ top: delta, behavior: 'smooth' });
      else win.scrollBy({ top: delta, behavior: 'smooth' });
      // 平滑滚动可能被页面的 scroll anchoring 吃掉：450ms 后没动就瞬时补一次
      setTimeout(() => {
        try {
          const after = scroller ? scroller.scrollTop : win.scrollY;
          if (Math.abs(after - before) < 4) {
            scrollTrace({ retry: 'instant', scroller: sName });
            if (scroller) scroller.scrollTop = before + delta;
            else win.scrollTo(0, win.scrollY + delta);
          }
        } catch (err) { /* 忽略 */ }
      }, 450);
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
  // B2 探针：记录最近一次高亮尝试的结果，回答"为什么没画出来"
  window.__dshHlTrace = { reason: 'init' };
  function hlTrace(reason, extra) {
    window.__dshHlTrace = Object.assign({ reason, at: Date.now() }, extra || {});
  }

  function highlightChar(scopeEl, chunkText, charIndex, opts) {
    if (!scopeEl || !chunkText) { hlTrace('no-input'); return; }
    const cache = ensureCache(scopeEl);
    if (!cache) { hlTrace('no-cache'); return; }
    try {
      let ci = Math.max(0, Math.min(charIndex, chunkText.length - 1));
      let guard = 0;
      while (ci < chunkText.length - 1 && /\s/.test(chunkText[ci]) && guard < 30) { ci += 1; guard += 1; }
      // 取 14 个字的窗口做定位：单个字在全文里会重名，窗口才够唯一
      const WIN = 14;
      const winStart = Math.max(0, Math.min(ci, chunkText.length - WIN));
      const context = chunkText.slice(winStart, winStart + WIN).replace(/\s+/g, '');
      if (context.length < 2) { hlTrace('context-too-short'); return; }
      const targetOffset = chunkText.slice(winStart, ci).replace(/\s+/g, '').length;
      const from = Math.max(0, (state.hlSearchPos || 0) - 80);
      let idx = cache.norm.indexOf(context, from);
      // 找不到时只往回看一小段，绝不回到全文开头——
      // 否则重复词会让高亮在几个代码块之间来回跳（B6）
      if (idx < 0) idx = cache.norm.indexOf(context, Math.max(0, from - 120));
      if (idx < 0) { hlTrace('not-found', { win: context, normLen: cache.norm.length }); return; }
      state.hlSearchPos = idx + context.length;
      state.hlChunk = { text: chunkText, index: charIndex };

      const pos = Math.min(cache.map.length - 1, idx + Math.min(targetOffset, context.length - 1));
      const startRaw = cache.map[pos];
      const endRaw = cache.map[pos] + 1;
      const a = locatePos(cache, startRaw);
      const b = locatePos(cache, endRaw);
      if (!a || !b) { hlTrace('locate-fail'); return; }
      const doc = docOf(scopeEl);
      // 代码块整块高亮：逐字定位在重复词上会乱跳，而且代码超过 400 字会被
      // 截断成「…」，那个字符在 DOM 里不存在，逐字永远找不到位置。
      const preEl = a.node.parentElement && a.node.parentElement.closest
        ? a.node.parentElement.closest('pre') : null;
      if (preEl) {
        const pr = preEl.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          clearPlayHighlight();
          const pd = ensurePlayHl(0, doc);
          pd.style.left = (pr.left - 2) + 'px';
          pd.style.top = (pr.top - 1) + 'px';
          pd.style.width = (pr.width + 4) + 'px';
          pd.style.height = (pr.height + 2) + 'px';
          pd.style.display = 'block';
          hlTrace('ok-block', { top: Math.round(pr.top), h: Math.round(pr.height) });
          if (!opts || !opts.noScroll) revealRect(pr, preEl);
          return;
        }
      }
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const rects = Array.prototype.slice.call(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) { hlTrace('no-rects'); return; }
      clearPlayHighlight();
      const r = rects[0];
      const d = ensurePlayHl(0, doc);
      d.style.left = (r.left - 2) + 'px';
      d.style.top = (r.top - 1) + 'px';
      d.style.width = (r.width + 4) + 'px';
      d.style.height = (r.height + 2) + 'px';
      d.style.display = 'block';
      hlTrace('ok', { ci, idx, left: Math.round(r.left), top: Math.round(r.top) });
      if (!opts || !opts.noScroll) revealRect(r, a.node);
    } catch (err) {
      hlTrace('exception', { msg: String(err && err.message || err) });
    }
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

    // 只在本机音色里挑：在线音色（Yunxi/Xiaoxiao 这类 Natural）每次开口都要走网络，
    // 表现就是"点了朗读要卡好几秒"。本机音色没有这个问题。
    const local = voices.filter((v) => v.localService !== false);
    const pool = local.length ? local : voices;
    for (const key of PREFERRED) {
      const hit = pool.find((v) => v.name.toLowerCase().includes(key.toLowerCase()));
      if (hit) return hit;
    }
    return pool[0];
  }

  window.__dshPickVoice = pickVoice; // 调试用：在 Console 里看实际会选哪个音色

  // 语音引擎冷启动是"点了朗读要等一下"的一部分：提前念一个静音串把它叫醒。
  // 浏览器若要求用户手势才能发声，这里会静默失败，不影响正常朗读。
  function warmUpEngine() {
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.rate = 2;
      const v = pickVoice();
      if (v) u.voice = v;
      state.lastSpeakAt = Date.now();
      synth.speak(u);
    } catch (err) { /* 忽略 */ }
  }

  /* ---------------- 播放控制 ---------------- */

  // 只提前排 2 段：改语速时后面最多 2 段还按旧速度念，绝不回头重读
  // 提前排 2 段（当前 + 前方 1 段）：既不断句，改语速时等一两段就生效
  const LOOKAHEAD = 2;

  function stop() {
    // 没在播就别 cancel：cancel() 会把语音引擎打回未初始化状态，
    // 下一次开口要多等几百毫秒——这正是"点了朗读要等一下"的主要来源。
    const wasActive = state.playing || synth.speaking || synth.pending;
    localStop();
    state.gen += 1;
    state.playing = false;
    state.paused = false;
    state.chunks = [];
    state.index = 0;
    state.progress = 0;
    state.queued = 0;
    state.current = null;
    state.hlCache = null;
    state.hlChunk = null;
    state.hlSearchPos = 0;
    clearPlayHighlight();
    if (wasActive) {
      synth.cancel();
      autoLog('stop', {});
    }
    render('就绪 · Alt+点击任意消息朗读');
  }

  function finish() {
    localStop();
    state.playing = false;
    state.paused = false;
    state.current = null;
    state.index = state.chunks.length;
    state.progress = state.sentences.length;
    state.hlChunk = null;
    state.hlSearchPos = 0;
    clearPlayHighlight();
    clearInterval(state.localTimer);
    render('朗读完成');
    autoLog('finish');
  }

  /* ---------------- 本地语音（tools/tts-server） ---------------- */

  function localStop() {
    state.localToken += 1;
    clearInterval(state.localTimer);
    const a = state.localAudio;
    state.localAudio = null;
    if (a) {
      try { a.pause(); a.src = ''; } catch (err) { /* 忽略 */ }
    }
    state.localUrls.forEach((u) => {
      if (typeof u === 'string') { try { URL.revokeObjectURL(u); } catch (err) { /* 忽略 */ } }
    });
    state.localUrls.clear();
    state.localTimings.clear();
    state.timingMaps.clear();
    setLoading(false);
  }

  // 本地服务不可用时，不要静默停：关掉本地开关，从当前段开始用系统语音接着读。
  // 这样本地服务只是"增强"，坏了也不影响主功能。
  function localFallback(reason) {
    clearInterval(state.localTimer);
    localStop();
    state.local = false;
    state.localReady = false;
    try { localStorage.setItem(LS_LOCAL, '0'); } catch (err) { /* 忽略 */ }
    const cb = document.querySelector('.dshr-local-cb');
    if (cb) cb.checked = false;
    toast(reason || '本地语音不可用，已切回系统语音');
    const cur = state.chunks[state.index];
    state.gen += 1;
    startFrom(cur ? cur.from : 0);
  }

  // 预取：把接下来几段的音频先取下来（blob），播的时候就不用等网络
  function localPrefetch(from) {
    const token = state.localToken;
    for (let k = from; k < Math.min(from + 2, state.chunks.length); k += 1) {
      if (state.localUrls.has(k)) continue;
      const chunk = state.chunks[k];
      if (!chunk) continue;
      const p = fetch(LOCAL_TTS + '/tts?text=' + encodeURIComponent(chunk.text) + '&priority=low')
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        })
        .then((b) => {
          const u = URL.createObjectURL(b);
          // 预取回来时如果已经换了一批（停止/重排），直接释放，别留在 map 里
          if (token !== state.localToken) {
            try { URL.revokeObjectURL(u); } catch (err) { /* 忽略 */ }
            return null;
          }
          state.localUrls.set(k, u);
          return u;
        })
        .catch(() => {
          // 预取失败不算错：播放时会再实时取一次。不要 rethrow，否则是未处理的 rejection。
          state.localUrls.delete(k);
          return null;
        });
      state.localUrls.set(k, p); // 先占位，避免同一段重复请求
    }
  }

  // 用服务端返回的逐词时间戳定位字符；没有就回退到按比例估算
  function charIndexAt(c, chunk, ms) {
    const list = state.localTimings.get(c);
    if (!list || !list.length) return null;
    let map = state.timingMaps.get(c);
    if (!map) {
      map = [];
      let cursor = 0;
      for (const item of list) {
        const idx = chunk.text.indexOf(item.w, cursor);
        if (idx < 0) continue;
        map.push({ t: item.t, i: idx });
        cursor = idx + item.w.length;
      }
      state.timingMaps.set(c, map);
    }
    if (!map.length) return null;
    let cur = 0;
    for (const m of map) {
      if (ms >= m.t) cur = m.i;
      else break;
    }
    return cur;
  }

  function localAudioFor(c, token) {
    const chunk = state.chunks[c];
    if (!chunk) { finish(); return; }
    const cachedBlob = state.localUrls.get(c);
    const useBlob = typeof cachedBlob === 'string';
    state.loadingCached = useBlob;
    state.loadingCachedResolved = useBlob;
    // 并行查询缓存状态（不阻塞播放），只用于决定是否把这次耗时计入学习样本
    if (!useBlob) {
      fetch(LOCAL_TTS + '/stat?text=' + encodeURIComponent(chunk.text))
        .then((r) => r.json())
        .then((j) => { state.loadingCached = !!j.cached; state.loadingCachedResolved = true; })
        .catch(() => { state.loadingCachedResolved = true; });
    }
    const src = useBlob
      ? cachedBlob
      : (LOCAL_TTS + '/tts?text=' + encodeURIComponent(chunk.text) + '&priority=high');
    const audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(1, Number.isFinite(state.volume) ? state.volume : 1));
    audio.playbackRate = state.rate || 1;
    state.localAudio = audio;
    const paint = () => {
      if (token !== state.localToken) return;
      if (audio.paused) return;
      const dur = audio.duration;
      if (!dur || !isFinite(dur)) return;
      const frac = Math.min(1, audio.currentTime / dur);
      const span = (chunk.to != null ? chunk.to : chunk.from + 1) - chunk.from;
      state.progress = chunk.from + frac * span;
      if (state.scopeEl) {
        const exact = charIndexAt(c, chunk, audio.currentTime * 1000);
        const ci = exact != null ? exact : Math.floor(frac * chunk.text.length);
        highlightChar(state.scopeEl, chunk.text, Math.min(chunk.text.length - 1, ci));
      }
      render();
    };
    audio.ontimeupdate = paint;
    // timeupdate 只有 4Hz，高亮会一跳一跳；补一个 80ms 的定时器让它跟得紧一些
    clearInterval(state.localTimer);
    state.localTimer = setInterval(paint, 80);
    audio.onended = () => {
      if (token !== state.localToken) return;
      clearInterval(state.localTimer);
      if (c + 1 < state.chunks.length) localPlay(c + 1);
      else finish();
    };
    audio.onerror = () => {
      if (token !== state.localToken) return;
      localFallback('本地语音播放失败，已切回系统语音');
    };
    // 时间戳可能比音频晚一点写入服务端缓存，空结果时重试几次
    const loadTimings = (attempt) => {
      fetch(LOCAL_TTS + '/timings?text=' + encodeURIComponent(chunk.text))
        .then((r) => r.json())
        .then((list) => {
          if (token !== state.localToken) return;
          if (Array.isArray(list) && list.length) { state.localTimings.set(c, list); return; }
          if (attempt < 4) setTimeout(() => loadTimings(attempt + 1), 500);
        })
        .catch(() => { /* 没有时间戳就用估算 */ });
    };
    loadTimings(0);
    audio.addEventListener('playing', () => {
      if (token !== state.localToken) return;
      noteLatency();
      setLoading(false);
      if (!state.localTimings.has(c)) loadTimings(2);
    });
    audio.play().catch(() => {
      if (token !== state.localToken) return;
      localFallback('本地语音播放被拦截，已切回系统语音');
    });
    // 下一段延后预取：先让当前段出声，避免抢走连接
    setTimeout(() => { if (token === state.localToken) localPrefetch(c + 1); }, 600);
  }

  // 本地模式：首段只放第一句，让声音尽快出来；后面再按 150 字合并
  function localBuildChunks(idx) {
    const first = state.sentences[idx];
    if (!first) return [];
    // 首段压到 12–14 字：合成和缓冲都更快，先出声再继续
    const LIMIT = 14;
    let head = first;
    if (first.length > LIMIT) {
      let cut = -1;
      for (let i = 4; i < LIMIT; i += 1) {
        if (/[，,、：:；;]/.test(first[i])) { cut = i; break; }
      }
      if (cut < 0) cut = LIMIT - 1;
      head = first.slice(0, cut + 1);
    }
    const chunks = [{ text: head, from: idx, to: idx + 1 }];
    const tail = first.slice(head.length);
    if (tail) chunks.push({ text: tail, from: idx, to: idx + 1 });
    return chunks.concat(buildChunksFrom(idx + 1, 150));
  }

  // 一段一个音频：当前段播的时候，后两段已经在本地备好
  function localPlay(c) {
    // INV1：开始本地音频前，先确保系统语音不在响（两个引擎互斥）
    if (synth.speaking || synth.pending) {
      state.gen += 1;
      synth.cancel();
    }
    const token = ++state.localToken;
    localStop();
    state.localToken = token;
    const chunk = state.chunks[c];
    if (!chunk) { finish(); return; }
    state.playing = true;
    state.paused = false;
    state.index = c;
    state.progress = chunk.from;
    state.current = chunk.text;
    state.hlSearchPos = 0;
    render();
    setLoading(true, chunk.text.length);
    localAudioFor(c, token);
  }

  function localPing() {
    return fetch(LOCAL_TTS + '/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        state.localReady = !!(j && j.ok);
        if (state.localReady && state.local) render('本地语音已就绪 · ' + (j.voice || ''));
        return state.localReady;
      })
      .catch(() => { state.localReady = false; return false; });
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
      state.startCount = (state.startCount || 0) + 1;
      state.index = i;
      state.progress = chunk.from;
      state.current = chunk.text;
      state.boundary = null;
      if (state.scopeEl) {
        // 不要在这里重置 hlSearchPos：每段都从全文开头找，重复词就会跳回前一段。
        // 位置只在"新开一次朗读 / 跳转 / 重读"时归零（stop、seekTo、replayCurrent）。
        queueCharHighlight(state.scopeEl, chunk.text, 0);
      }
      render();
    };

    // 记录"念到第几个字"，同时把高亮挪到当前字
    u.onboundary = (ev) => {
      if (gen !== state.gen) return;
      state.boundaryCount = (state.boundaryCount || 0) + 1;
      if (typeof ev.charIndex !== 'number') return;
      state.boundary = { i, charIndex: ev.charIndex };
      // 段内也推进进度条，否则一段几百字走完条都不动
      const span = (chunk.to != null ? chunk.to : chunk.from + 1) - chunk.from;
      const frac = chunk.text.length ? Math.min(1, Math.max(0, ev.charIndex / chunk.text.length)) : 0;
      state.progress = chunk.from + frac * span;
      render();
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
    // INV1：开始系统语音前，先确保本地音频不在响（两个引擎互斥）
    localStop();
    // 只有真的在播时才需要先取消；空闲时 cancel() 反而会让引擎重新初始化，拖慢开口
    const wasActive = state.playing || synth.speaking || synth.pending;
    if (wasActive) synth.cancel();
    state.gen += 1;
    const gen = state.gen;
    state.chunks = localBuildChunks(idx);
    state.index = 0;
    state.progress = idx;
    state.queued = 0;
    state.playing = true;
    state.paused = false;
    state.warned = false;
    state.current = null;
    render();
    // cancel 之后紧跟 speak 可能重放旧队列，这时才需要等一小会儿
    const delay = wasActive ? 80 : 0;
    if (delay) setTimeout(() => { if (gen === state.gen) fillQueue(gen); }, delay);
    else fillQueue(gen);
  }

  // 从某个字符偏移处对应的句子开始读
  function playTextFrom(text, offset, label) {
    if (state.playKind === 'manual') autoLog('manual-play', { textLen: String(text || '').length });
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
    if (state.local) {
      if (!state.localReady) {
        toast('本地语音服务未启动');
        state.local = false;
        localStorage.setItem(LS_LOCAL, '0');
        startFrom(idx);
        return;
      }
      state.chunks = localBuildChunks(idx);
      state.queued = 0;
      localPlay(0);
      return;
    }
    startFrom(idx);
  }

  function play(text, label, kind) {
    state.playKind = kind || 'manual';
    playTextFrom(text, 0, label);
  }

  // 从头重读这条消息（F2）。本地/系统两条路径都走，跟 seekTo 同一套分支。
  function replayCurrent() {
    if (!state.sentences.length) { toast('先读一条消息'); return; }
    state.hlSearchPos = 0; // 从头重读，位置归零
    if (state.local && state.localReady) {
      stop();
      state.chunks = localBuildChunks(0);
      state.queued = 0;
      localPlay(0);
      toast('从头重读这条');
      return;
    }
    startFrom(0);
    toast('从头重读这条');
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

  // B5：暂停时用户滚动，高亮要贴着文字走。
  // 只靠 scroll 事件不够稳（滚动可能发生在内部容器上），
  // 暂停期间用 120ms 定时器重算位置，代价很小；恢复/停止后自动停。
  let pausedHlTimer = 0;
  function startPausedHlLoop() {
    if (pausedHlTimer) return;
    pausedHlTimer = setInterval(() => {
      if (!state.paused || !state.hlChunk || !state.scopeEl) {
        clearInterval(pausedHlTimer);
        pausedHlTimer = 0;
        return;
      }
      highlightChar(state.scopeEl, state.hlChunk.text, state.hlChunk.index, { noScroll: true });
    }, 120);
  }

  function togglePause() {
    // 本地语音模式：直接控制 Audio 元素
    if (state.local && state.localAudio) {
      if (state.paused) {
        state.paused = false;
        state.localAudio.play().catch(() => {});
      } else {
        state.paused = true;
        state.localAudio.pause();
        startPausedHlLoop();
      }
      render();
      return;
    }
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
      startPausedHlLoop();
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
      #dsh-reader .dshr-loading { display: none; gap: 6px; align-items: center; margin-top: 4px; color: #a9c0ff; font-size: 11px; }
      #dsh-reader .dshr-ring-track { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 2.5; }
      #dsh-reader .dshr-ring { fill: none; stroke: #6b8afd; stroke-width: 2.5; stroke-linecap: round;
        stroke-dasharray: 50.27; stroke-dashoffset: 50.27; transform: rotate(-90deg); transform-origin: 10px 10px; transition: stroke-dashoffset .1s linear; }
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
      #dsh-reader .dshr-local { display: flex; align-items: center; gap: 6px; color: #c9d1e0; font-size: 11px; }
      #dsh-reader .dshr-local input { accent-color: #6b8afd; }
      #dsh-reader .dshr-start-server { flex: 1; cursor: pointer; font: inherit; color: #a9c0ff;
        border: 1px solid rgba(107,138,253,.6); border-radius: 8px; padding: 4px 6px;
        background: rgba(107,138,253,.12); }
      #dsh-reader .dshr-start-server:hover { background: rgba(107,138,253,.24); }
      #dsh-reader .dshr-tools button { flex: 1; font-size: 11px; padding: 4px 4px; }
      #dsh-reader .dshr-resume { flex: 1; cursor: pointer; font: inherit; color: #a9c0ff;
        border: 1px solid rgba(107,138,253,.6); border-radius: 8px; padding: 4px 6px;
        background: rgba(107,138,253,.12); }
      #dsh-reader .dshr-resume:hover { background: rgba(107,138,253,.24); }
      #dsh-reader .dshr-local-help { color: #8fa6d8; font-size: 11px; text-decoration: underline; opacity: .85; }
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
        <button data-act="pause" title="暂停 / 继续">⏸</button>
        <button data-act="replay" title="从头重读这条（Alt+R）">🔁</button>
        <button data-act="stop" title="停止（Alt+X）">⏹</button>
        <button class="dshr-min" title="收起/展开">–</button>
        <button class="dshr-close" title="关闭面板（Alt+P 找回）">×</button>
      </div>
      <div class="dshr-bar" title="拖动或点击，从对应句子开始读"><i></i></div>
      <div class="dshr-row"><button class="dshr-resume" style="display:none">继续上次朗读</button></div>
      <div class="dshr-loading">
        <svg viewBox="0 0 20 20" width="14" height="14"><circle class="dshr-ring-track" cx="10" cy="10" r="8"></circle><circle class="dshr-ring" cx="10" cy="10" r="8"></circle></svg>
        <span class="dshr-loading-text">正在合成…</span>
      </div>
      <div class="dshr-collapsible">
        <div class="dshr-hint">拖动/点击进度条跳句 · Alt+点正文从该句开始</div>
        <div class="dshr-status">就绪 · Alt+点击任意消息朗读</div>
        <div class="dshr-cur"></div>
        <div class="dshr-voicebadge">当前音色：<b class="dshr-voice-name">-</b></div>
        <div class="dshr-row"><label class="dshr-local"><input type="checkbox" class="dshr-local-cb"> 本地语音服务（云健 · 无句间停顿）</label></div>
        <div class="dshr-row"><label class="dshr-auto"><input type="checkbox" class="dshr-auto-cb"> 自动朗读新回复（只读明确标出的回答）</label></div>
        <div class="dshr-row"><button class="dshr-start-server" style="display:none">启动本地服务</button></div>
        <div class="dshr-row"><a class="dshr-local-help" target="_blank" rel="noopener"
          href="https://github.com/2700-hub/dsh-web-reader#本地语音服务可选">本地语音服务怎么用？</a></div>
        <div class="dshr-row"><a class="dshr-update-link" target="_blank" rel="noopener" style="display:none">安装新版</a></div>
        <div class="dshr-row"><select class="dshr-voice"></select></div>
        <div class="dshr-row dshr-tools">
          <button data-act="rate" title="语速">⚡ 语速</button>
          <button data-act="vol" title="音量">🔉 音量</button>
          <button data-act="update" title="检查更新">⟳ 更新</button>
        </div>
        <div class="dshr-kbd">Alt+点击正文从该句读 · Alt+R 重读这条 · Alt+X 停止 · Alt+P 面板</div>
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

    // 安装完成后回到本页时自动刷新：刷新后页面上跑的才是新版本脚本
    let pendingReloadAt = 0;
    function markReloadPending() { pendingReloadAt = Date.now(); }
    const updateLinkEl = root.querySelector('.dshr-update-link');
    if (updateLinkEl) updateLinkEl.addEventListener('click', markReloadPending);
    window.addEventListener('focus', () => {
      if (!pendingReloadAt) return;
      if (Date.now() - pendingReloadAt > 5 * 60 * 1000) { pendingReloadAt = 0; return; }
      pendingReloadAt = 0;
      toast('刷新页面以加载新版本…');
      setTimeout(() => location.reload(), 800);
    });

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
          markReloadPending();
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

    const startServerBtn = root.querySelector('.dshr-start-server');
    function showStartServer(on) {
      if (startServerBtn) startServerBtn.style.display = on ? '' : 'none';
    }
    if (startServerBtn) {
      startServerBtn.addEventListener('click', () => {
        showStartServer(false);
        toast('正在唤起本地服务…');
        try { window.location.href = 'dsh-tts://start'; } catch (err) { /* 忽略 */ }
        setTimeout(() => {
          localPing().then((ok) => {
            if (ok) {
              state.local = true;
              localStorage.setItem(LS_LOCAL, '1');
              const cb = root.querySelector('.dshr-local-cb');
              if (cb) cb.checked = true;
              toast('本地语音已就绪');
              render();
            } else {
              showStartServer(true);
              toast('没启动成功：先运行 tools/tts-server/install-protocol.cmd');
            }
          });
        }, 2500);
      });
    }

    // 本地语音开关
    const localCb = root.querySelector('.dshr-local-cb');
    if (localCb) {
      localCb.checked = !!state.local;
      localCb.addEventListener('change', () => {
        state.local = localCb.checked;
        localStorage.setItem(LS_LOCAL, state.local ? '1' : '0');
        stop();
        if (!state.local) { toast('已切回系统语音'); render(); return; }
        localPing().then((ok) => {
          if (ok) {
            toast('已切换到本地语音（云健）');
          } else {
            state.local = false;
            localStorage.setItem(LS_LOCAL, '0');
            localCb.checked = false;
            showStartServer(true);
            toast('本地语音服务未启动：先点「本地语音服务怎么用？」');
          }
          render();
        });
      });
    }

    // 自动朗读开关：开启时把当前已有回合记为基线，只对之后的新回复生效
    const autoCb = root.querySelector('.dshr-auto-cb');
    if (autoCb) {
      autoCb.checked = !!state.auto;
      autoCb.addEventListener('change', () => {
        state.auto = autoCb.checked;
        localStorage.setItem(LS_AUTO, state.auto ? '1' : '0');
        if (state.auto) {
          state.autoInit = true;
          markAutoBaseline();
          startAutoWatch();
          toast('已开启：新回复生成完自动朗读');
        } else {
          toast('已关闭自动朗读');
        }
      });
    }

    btnPause.addEventListener('click', togglePause);
    const btnReplay = root.querySelector('[data-act="replay"]');
    if (btnReplay) {
      btnReplay.addEventListener('click', () => {
        autoLog('btn-replay', {});
        replayCurrent();
      });
    }
    const btnResume = root.querySelector('.dshr-resume');
    if (btnResume) btnResume.addEventListener('click', resumeLast);
    const btnStop = root.querySelector('[data-act="stop"]');
    if (btnStop) {
      btnStop.addEventListener('click', () => {
        autoLog('btn-stop', {});
        stop();
      });
    }

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
      state.hlSearchPos = 0; // 跳转是新的起点，允许从头找
      if (state.local) {
        if (!state.localReady) { toast('本地语音服务未启动'); return; }
        stop();
        state.chunks = localBuildChunks(i);
        state.queued = 0;
        localPlay(0);
        toast('从第 ' + (i + 1) + ' / ' + state.sentences.length + ' 句开始');
        return;
      }
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
      // 本地模式：直接改音频播放速度（浏览器会保持音调）
      if (state.localAudio) {
        try { state.localAudio.playbackRate = v; } catch (err) { /* 忽略 */ }
        if (state.local) return;
      }
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
      if (state.localAudio) {
        try { state.localAudio.volume = Math.max(0, Math.min(1, v)); } catch (err) { /* 忽略 */ }
        if (state.local) return;
      }
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
      state.lastSpeakAt = Date.now();
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
      if (state.local) {
        toast('本地模式固定云健；换音色请先取消勾选本地语音');
        return;
      }
      previewVoice();
    });

    // 语速 / 音量按钮（现在在设置区）：点开对应的弹出条
    root.querySelectorAll('[data-act="rate"], [data-act="vol"]').forEach((btn) => {
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
    const chunkFrom = state.chunks[state.index] ? state.chunks[state.index].from : (state.playing ? 0 : (state.progress || 0));
    // 朗读中用段内进度（逐字推进）；停下时回落到段落起点。
    // 注意别回落成 total：那会把"停止"显示成"朗读完成"、进度条拉满。
    const done = state.playing ? Math.min(total, Math.max(0, state.progress || 0)) : chunkFrom;
    const shown = total ? Math.min(total, Math.floor(done) + 1) : 0;

    if (msg) statusEl.textContent = msg;
    else if (state.playing) {
      statusEl.textContent = (state.paused ? '已暂停' : '朗读中') + ' · 第 ' + shown + ' / ' + total + ' 句';
    } else if (total && done >= total) {
      statusEl.textContent = '朗读完成';
    }

    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (bar) bar.style.width = pct + '%';
    if (curEl) curEl.textContent = state.current && state.playing ? state.current : '';
    if (btnPause) btnPause.textContent = state.paused ? '▶' : '⏸';
  }

  const LS_LAT = 'dsh-reader.ttslatency';
  const LS_SAMPLES = 'dsh-reader.ttsSamplesCold';
  let latencyMs = Number(localStorage.getItem(LS_LAT) || 1200) || 1200;
  let latencyLen = 100;
  let latencySamples = [];
  try { latencySamples = JSON.parse(localStorage.getItem(LS_SAMPLES) || '[]'); } catch (err) { latencySamples = []; }
  if (!Array.isArray(latencySamples)) latencySamples = [];

  function estimateFor(len) {
    const valid = latencySamples.filter((x) => x && x.ms > 0 && x.len > 0);
    if (valid.length >= 2) {
      const ratios = valid.map((x) => x.ms / x.len).sort((a, b) => a - b);
      const p75 = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.75))];
      return Math.max(1000, Math.min(15000, Math.round(p75 * len + 250)));
    }
    return Math.max(1000, Math.min(15000, Math.round(latencyMs + len * 8)));
  }

  let loadingTimer = 0;
  function setLoading(on, textLen) {
    if (!root) return;
    const el = root.querySelector('.dshr-loading');
    if (!el) return;
    clearInterval(loadingTimer);
    if (!on) {
      const elapsed = Date.now() - (state.loadingT0 || 0);
      const wait = Math.max(0, 400 - elapsed);
      if (wait > 0) { setTimeout(() => { el.style.display = 'none'; }, wait); return; }
      el.style.display = 'none';
      return;
    }
    el.style.display = 'inline-flex';
    const ring = el.querySelector('.dshr-ring');
    const label = el.querySelector('.dshr-loading-text');
    // 用历史耗时估算本次等待，并按字数比例缩放
    const len = Math.max(10, textLen || 100);
    const total = estimateFor(len);
    const t0 = Date.now();
    latencyLen = len;
    state.loadingT0 = t0;
    state.loadingLen = len;
    const paint = () => {
      const elapsed = Date.now() - t0;
      const frac = Math.min(0.95, elapsed / total);
      if (ring) ring.style.strokeDashoffset = String(50.27 * (1 - frac));
      if (!label) return;
      // 只减不增：线性减到 0.1 后停住（"砍一刀"式，永远差一点点）
      const left = Math.max(0.1, (total - elapsed) / 1000);
      window.__dshLoad = { totalMs: Math.round(total), elapsedMs: elapsed, leftMs: Math.round(left * 1000) };
      label.textContent = '预计还需 ' + left.toFixed(1) + ' 秒';
    };
    paint();
    loadingTimer = setInterval(paint, 100);
  }

  window.__dshLatency = () => ({ sampleMs: latencyMs, sampleLen: latencyLen });

  // 实际出声后回填耗时，下次估算更准
  function noteLatency() {
    if (!state.loadingT0) return;
    // 缓存状态还没查清（或已命中缓存）时，不把这次耗时计入学习样本
    if (!state.loadingCachedResolved || state.loadingCached) { state.loadingT0 = 0; return; }
    const sample = Math.max(150, Math.min(15000, Date.now() - state.loadingT0));
    latencyMs = Math.round(latencyMs * 0.7 + sample * 0.3);
    latencySamples.push({ ms: sample, len: Math.max(10, state.loadingLen || 100) });
    if (latencySamples.length > 12) latencySamples = latencySamples.slice(-12);
    try {
      localStorage.setItem(LS_LAT, String(latencyMs));
      localStorage.setItem(LS_SAMPLES, JSON.stringify(latencySamples));
    } catch (err) { /* 忽略 */ }
    state.loadingT0 = 0;
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
    state.playKind = 'manual';
    state.resume = null; // 手动点了新内容，之前的续读作废
    updateResumeUI();
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
      if (offset === null || offset === undefined) offset = offsetOfBlockAtPoint(e.clientX, e.clientY, blocks, d);
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
        // 朗读过程中不做悬停高亮：页面在自动滚动，鼠标位置对应的行一直在变，会闪
        if (state.playing) { hideHighlight(d); return; }
        const line = lineRectAt(e.clientX, e.clientY, d, true);
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
    // 用 e.code：Windows 上 Alt+X 的 e.key 不一定是 'x'（可能是特殊字符）
    const code = e.code || '';
    const k = String(e.key || '').toLowerCase();
    const is = (letter) => code === 'Key' + letter.toUpperCase() || k === letter;
    if (is('x')) {
      e.preventDefault();
      autoLog('key', { code, key: k, action: 'stop' });
      stop();
    } else if (is('r')) {
      e.preventDefault();
      autoLog('key', { code, key: k, action: 'replay' });
      replayCurrent();
    } else if (is('p')) {
      e.preventDefault();
      autoLog('key', { code, key: k, action: 'panel' });
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
      setTimeout(warmUpEngine, 1200);
      if (state.local) localPing();
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
    // 会话监听独立于自动朗读：自动关着也要能发现切会话（B1）并保留续读位置（F5）
    startSessionWatch();
    // 自动朗读：只观察，不猜；基线等聊天列表出现后再定（见 scanAuto）
    if (state.auto) {
      startAutoWatch();
    }
    console.log('[dsh-reader] v' + SCRIPT_VERSION + ' 已注入:', location.href,
      '| turns =', document.querySelectorAll(TURN_SEL).length,
      '| answers =', document.querySelectorAll(ANSWER_SEL).length,
      '| voices =', (synth.getVoices() || []).length);
  }

  // document-start 注入时 body 可能还不存在，等它出现
  // __DSH_NO_BOOT 只给 Node 测试用：不碰 DOM，只加载纯函数
  if (!window.__DSH_NO_BOOT) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
      setTimeout(boot, 300);
    } else {
      boot();
    }
  }
})();
