# 实时语音识别 · Qwen3-ASR-Flash-Realtime

## 运行
```bash
npm install
npm start
```
浏览器打开 http://localhost:3000 ，点麦克风（或按空格）开始/停止。

API Key 写在 `.env` 的 `DASHSCOPE_API_KEY` 里，只在服务端使用，不会发到浏览器。

## 结构
- `server.js`：静态页面 + WebSocket 代理（浏览器 → 本服务 → 千问实时接口，服务端加 Authorization 头）
- `public/index.html`：界面与识别逻辑
- `public/pcm-worklet.js`：麦克风音频转 16kHz / 16bit / 单声道 PCM，每 100ms 一包

## 说明
- 麦克风需要 `localhost` 或 HTTPS 才能使用。
- 关闭"自动断句"后，停止时才提交整段音频，单次建议不超过 60 秒。

## 实时翻译
- 每识别完一句，就调用 `qwen-mt-flash` 翻译，译文显示在原文下方。
- 模式：双向互译（中⇄日、中⇄英、日⇄英，自动判断这句是哪种语言）、单向、全部译成某种语言。
- 语言、VAD、翻译模式、专业词汇会保存在浏览器里，下次打开自动恢复。
- 混合语音（如中英夹杂）：语言选"自动 / 混合语音"，翻译时按这句话里占比多的语言判断方向。
- 可在 `.env` 里用 `QWEN_MT_MODEL`（qwen-mt-plus / qwen-mt-flash / qwen-mt-lite）和 `QWEN_MT_URL` 修改翻译模型和接口地址。
