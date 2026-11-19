# 架构说明

这份文档解释脚本内部怎么组织的、哪些约束不能破坏。改代码前先读一遍，
能避免踩到已经踩过的坑。

## 运行模型

```
浏览器页面 (http://127.0.0.1:3080/...)
 └─ userscript（ScriptCat / Tampermonkey 注入）
     ├─ 面板 UI（固定在页面右下角）
     ├─ 文本提取（聊天消息 / 通用容器）
     ├─ 播放调度（speechSynthesis 队列）
     └─ 高亮层（fixed 定位的覆盖框，不改页面 DOM）
```

- `@run-at document-start`：脚本猫在 `document-idle` 时机不稳定，所以提前注入，
  用 `boot()` 轮询等 `document.body` 出现后再建面板。
- `@match *://*/*` + 运行时 `location.hostname` 白名单：
  避免不同管理器对「带端口 URL」的 `@match` 解析差异。
- 页面是 SPA，重渲染可能摘掉面板节点 → `ensureAttached()` 用 `MutationObserver` + 2s 轮询补挂。

## 模块划分

### 1. 文本提取

| 函数 | 作用 |
|---|---|
| `pickTurn(el)` / `turnAtPoint(x,y)` | 找 dsh web 的聊天消息容器 `[data-chat-turn]` |
| `scopeOfTurn(turn)` | 取回答正文 `[data-turn-process-answer]` |
| `genericScopeAt(el)` | 通用模式：向上找「20–3000 字、且含 ≥2 个块级元素」的容器 |
| `collectBlocks(scope)` | 把范围拆成块（`p/li/h1-h6/pre/…`），记录每块在全文的起始偏移 |
| `textFromBlocks(blocks)` | 用 `\n` 连接各块，得到供切句的全文 |
| `deepElementFromPoint(x,y)` | 递归穿透 `shadowRoot` 取命中元素 |

**约束**：提取与定位必须用同一套文本。高亮、行定位都基于 `collectBlocks` 的结果，
不要在别处另算一份。

**坑**：

- 画布类插件把文字放在 shadow root，`innerText` 不穿透 → 事件用 `composedPath()[0]`，
  命中检测用 `deepElementFromPoint`。
- `innerText` 在 `content-visibility` / 离屏 / 缩放场景会返回空 → 回退 `textContent`。

### 2. 切句与分段

- `splitSentences(text)`：按 `。！？!?；;…` 和换行切，超长句再按逗号切；
  不足 6 字且无句末标点的碎片并入上一句（完整短句保留独立，便于按行定位）。
- `buildChunksFrom(start)`：把连续句子合并成 ≤ `CHUNK_CHARS`（300）字的段。
  段是语音任务的单位，段与段之间可能有轻微停顿。

### 3. 播放调度

```
startFrom(sentenceIndex)
  → buildChunksFrom(idx)
  → fillQueue(gen)           // 只预排 LOOKAHEAD(=2) 段
      → queueOne(i, gen)     // 建 SpeechSynthesisUtterance
          ├─ onstart   → 更新进度、定位首个高亮
          ├─ onboundary→ 记录 charIndex + 推进逐字高亮
          └─ onend     → fillQueue(gen) 继续补队列
```

**不变量**：

1. **只有一个语音队列**。任何 `synth.cancel()` 都必须 `state.gen += 1`，
   回调里用 `gen !== state.gen` 丢弃过期事件。
2. **不预排整篇**。`LOOKAHEAD = 2` 是为了让改语速/音量/音色能尽快生效。
   预排太多会导致「改了设置却几十秒没反应」——这个坑踩过。
3. **改语速 / 音量 / 音色**：从 `state.boundary.charIndex - 3` 处重新开口，
   最多重复 3 个字，不从头重读。相关函数：`highlightChar` 附近无，实际在
   `build()` 内的 `resumeAtBoundary()`。
4. **暂停恢复兜底**：Chrome 长时间暂停后 `resume()` 可能静默失效，
   点继续后 1.2 秒检查 `speaking/pending`，都为空则从当前段重开。

### 4. 高亮与滚动

- `buildHlCache(scopeEl)`：把作用域内所有文本节点拼成 `raw`，再生成去空白的 `norm`
  和 `norm → raw` 的下标映射。
- `highlightChar(scopeEl, chunkText, charIndex)`：
  用**14 字窗口**在 `norm` 里定位（单字会命中错误位置），得到目标字符的 Range，
  画一个 fixed 覆盖框（不是给页面加 `<span>`，避免和框架打架）。
- `revealRect(rect, node)`：让当前字保持在视口 45% 高度附近。

**约束**：

- **滚动只由朗读推进（boundary）驱动**。`scroll` 事件里的重定位必须带
  `{ noScroll: true }`，否则「滚动 → 重定位 → 再滚动」形成反馈环，界面会被拽。
- 用户 `wheel` / `touchstart` 后静默 2 秒，并中断正在进行的平滑滚动。
- 暂停时 `revealRect` 直接返回。

### 5. 面板与交互

- `build()` 创建 DOM：标题行（音色/音速/音量/暂停/停止/收起/关闭）+ 进度条 + 展开区。
- 语速、音量为标题栏按钮 → 弹出浮动条（`.dshr-pop`）。
- `render()` 只负责状态显示；播放状态以 `state` 为唯一来源。
- 面板可能被 SPA 摘掉或关闭，`Alt+P` 可找回。

### 6. 调试接口

页面 Console 里可用：

```js
window.__dshProbe      // 注入版本，如 "v1.11.7"
window.__dshState      // 内部状态（sentences / chunks / index / boundary …）
window.__dshHighlight  // 手动触发逐字高亮，便于定位问题
```

## 已知限制

| 限制 | 说明 |
|---|---|
| `onboundary` 不一定触发 | 少数语音引擎不报字符边界，此时逐字高亮会停在段首 |
| 语音列表因环境而异 | Edge 可能返回数百个在线音色；已做本机优先排序 + 「在线」标注 |
| 长文本质量 | `speechSynthesis` 的音质与停顿由系统语音决定，脚本只控制分段 |
| raw CDN 缓存 | 推送后 GitHub raw 有几分钟缓存，更新检查可能延迟 |
| 深嵌套 shadow DOM | `deepElementFromPoint` 最多递归 5 层 |

## 扩展指引

- **支持新页面**：优先改 `genericScopeAt`（选范围）和 `collectBlocks`（拆块），
  播放与高亮层不用动。
- **加新语音来源**：改 `zhVoices()` 的过滤与排序；`pickVoice()` 的 `PREFERRED`
  决定默认音色优先级。
- **调整朗读节奏**：改 `CHUNK_CHARS`（段长）和 `splitSentences` 的合并规则；
  改完务必验证「按行定位是否还准」。
