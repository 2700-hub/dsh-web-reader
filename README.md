# dsh web 朗读

给 DeepSeek Harness Web 界面加朗读面板的 userscript。

## 功能

- Alt + 点击任意可读内容，从所点的那一行开始朗读
- 连续播放；可拖动进度条跳句
- **朗读时逐字高亮，并自动滚动跟随当前朗读位置**
- 标题栏弹出语速 / 音量调节
- 切换系统中文语音，切换后自动试听
- 通用模式：dsh web 聊天消息、ThoughtDAG 画布、其他本机页面都能读

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

1. 改完代码按语义化版本递增 `@version`，并同步 `window.__dshProbe`
2. 在 `CHANGELOG.md` 顶部新增一节（写清「改了什么」和「为什么」）
3. 提交、打 tag、发 Release

调试接口（页面 Console）：

```js
window.__dshProbe      // 注入版本
window.__dshState      // 内部状态
window.__dshHighlight  // 手动触发逐字高亮
```

## 许可证

MIT