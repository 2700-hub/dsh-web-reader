# dsh web 朗读

给 DeepSeek Harness Web 界面加朗读面板的 userscript。

## 功能

- Alt + 点击任意可读内容，从所点的那一行开始朗读
- 连续播放；可拖动进度条跳句
- **朗读时逐字高亮，并自动滚动跟随当前朗读位置**
- 标题栏弹出语速 / 音量调节
- 切换系统中文语音，切换后自动试听
- 通用模式：dsh web 聊天消息、ThoughtDAG 画布（同源 iframe）、其他本机页面都能读
- 跨 iframe 朗读时仍然只有一个面板（顶层面板代理，不在画布里重复注入）
- 可选「本地语音服务」：句与句之间无停顿（云健音色，见下文）
- 可选「自动朗读新回复」：只读明确标出的回答；正在自动读上一条时，新回复直接抢占

## 本地语音服务（可选）

浏览器自带的朗读，每读完一句都要重新联网合成，句间会有 0.5–2 秒空白。
想要更顺，可以跑一个本机小服务：脚本逐句预取，播完一句下一句已经就绪。

### 第一次安装（推荐路径）

1. 到 [Releases](https://github.com/2700-hub/dsh-web-reader/releases) 下载最新版的
   `dsh-tts-server.zip`，解压到任意目录（**路径别带中文或空格**更稳）
2. 确认装了 [Node.js](https://nodejs.org/)（18 或更新）
3. 双击解压目录里的 `start.cmd`
   - 首次会自动安装依赖，几十秒
   - 看到「本地语音服务已启动」就绪
4. 刷新 dsh 页面，在朗读面板里勾选 **「本地语音服务（云健 · 无句间停顿）」**

> 想少点手动：双击 `install-protocol.cmd` 一次，之后用面板里的「启动本地服务」按钮。
> 想更省事：双击 `install-autostart.cmd`，设为开机自启。

### 不想每次手动启动：两种办法

**办法一：面板按钮**

先运行一次：

```
tools/tts-server/install-protocol.cmd
```

注册 `dsh-tts://` 协议后，服务没开时面板里会出现 **「启动本地服务」** 按钮，
点一下就启动（浏览器首次可能弹窗问「是否允许打开此应用」，点允许）。

**办法二：开机自启**

双击一次：

```
tools/tts-server/install-autostart.cmd
```

注册计划任务（`DSH-TTS-Server`），以后登录 Windows 就在后台静默启动，不弹窗口。
取消用 `uninstall-autostart.cmd`。

> 浏览器不允许网页直接启动本地程序；上面两种都是借 Windows 来启动。

效果：

- 首句仍需约 1 秒（网络往返），不会比原来更慢
- 后续句子几乎无缝衔接
- 重复朗读同一段：命中缓存，秒开
- 仍然调用微软在线合成，断网无法生成新语音

## 安装

1. 安装 ScriptCat 或 Tampermonkey
2. 点击安装：[dsh-web-reader.user.js](https://raw.githubusercontent.com/2700-hub/dsh-web-reader/main/dsh-web-reader.user.js)

## 使用

| 操作 | 说明 |
|---|---|
| `Alt` + 点击正文 | 从该行开始朗读 |
| `Alt` + 选中文字后点击 | 只读选中的内容 |
| `Alt` + `X` | 停止 |
| `Alt` + `P` | 显示/隐藏面板 |
| 拖动进度条 | 跳到对应句子 |

## 兼容性

Edge / Chrome。当前版本适用于 `http://127.0.0.1:*` 与 `http://localhost:*` 上的
dsh web（含 ThoughtDAG 画布）及其他本机页面；普通网站的正文朗读在后续版本支持。

## 文档

- [更新记录 CHANGELOG.md](CHANGELOG.md)：每个版本的改动、修复与**当时的原因**
- [架构说明 docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：模块划分、不能破坏的约束、已知限制

## 开发

每次改动都按这三步走，**文档和代码放进同一个提交**：

1. `node scripts/release.mjs 1.12.0 "一句话摘要"`
   —— 自动递增版本号（`@version` + `LOCAL_VERSION`）并往 CHANGELOG 插入一节模板
2. 补全 CHANGELOG 里的「变更 / 修复 / 技术说明」
3. 提交并推 tag —— GitHub Actions 会自动建 Release 并附上脚本

```powershell
node scripts/release.mjs 1.12.0 "支持普通网站正文朗读"
git add .
git commit -m "feat: 支持普通网站正文朗读 (v1.12.0)"
git tag -a v1.12.0 -m "v1.12.0"
git push --follow-tags origin main
```

> 推 `v*` 标签后，[.github/workflows/release.yml](.github/workflows/release.yml)
> 会自动创建 Release、附上 `dsh-web-reader.user.js`。说明文字按提交自动生成，
> 发布后可去 Release 页面点 Edit 润色。

> 只改代码不写文档，未来的自己和 AI 都得重新考古。

调试接口（页面 Console）：

```js
window.__dshProbe      // 注入版本
window.__dshState      // 内部状态
window.__dshHighlight  // 手动触发逐字高亮
```

## 许可证

MIT