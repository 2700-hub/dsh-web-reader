# dsh web 朗读

给 DeepSeek Harness Web 界面加朗读面板的 userscript。

## 功能

- Alt + 点击消息，从所点的那一行开始朗读
- 连续播放；可拖动进度条跳句
- 标题栏弹出语速 / 音量调节
- 切换系统中文语音，切换后自动试听

## 安装

1. 安装 ScriptCat 或 Tampermonkey
2. 点击安装：[dsh-web-reader.user.js](https://raw.githubusercontent.com/2700-hub/dsh-web-reader/main/dsh-web-reader.user.js)

## 使用

| 操作 | 说明 |
|---|---|
| `Alt` + 点击正文 | 从该行开始朗读 |
| `Alt` + `X` | 停止 |
| `Alt` + `P` | 显示/隐藏面板 |
| 拖动进度条 | 跳到对应句子 |

## 兼容性

Edge / Chrome，页面为 `http://127.0.0.1:*` 或 `http://localhost:*` 上的 dsh web。

## 许可证

MIT