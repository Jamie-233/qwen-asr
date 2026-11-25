// Qwen3-ASR-Flash-Realtime 本地代理服务
// 浏览器的 WebSocket 无法设置 Authorization 请求头，且 API Key 不应暴露在前端，
// 所以由这个服务持有 Key，在浏览器和千问实时接口之间转发消息。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// ---- 读取 .env（无需额外依赖） ----
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const API_KEY = process.env.DASHSCOPE_API_KEY;
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.QWEN_MODEL || 'qwen3-asr-flash-realtime';
const BASE_URL = process.env.QWEN_WS_URL || 'wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/realtime';

if (!API_KEY) {
  console.error('缺少 DASHSCOPE_API_KEY，请在 .env 中配置');
  process.exit(1);
}

const MT_MODEL = process.env.QWEN_MT_MODEL || 'qwen-mt-flash';
const MT_URL = process.env.QWEN_MT_URL || 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions';

// ---- 流式翻译：POST /api/translate { text, target, source? } ----
// 返回 NDJSON，每行 {"t": "目前为止的完整译文"}，结束时 {"done": true}
async function handleTranslate(req, res) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const ac = new AbortController();
  res.on('close', () => ac.abort()); // 浏览器取消（文字又变了）时，同时取消上游请求
  let input;
  try {
    let body = '';
    for await (const chunk of req.setEncoding('utf8')) body += chunk;
    input = JSON.parse(body);
  } catch (e) {
    return json(400, { error: '请求体无效：' + e.message }); // 浏览器中途断开时也会走到这里
  }
  try {
    const { text, target, source = 'auto', terms } = input ?? {};
    if (!text || !target) return json(400, { error: '缺少 text 或 target' });
    const translation_options = { source_lang: source, target_lang: target };
    if (Array.isArray(terms) && terms.length) translation_options.terms = terms;
    const r = await fetch(MT_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MT_MODEL,
        messages: [{ role: 'user', content: text }],
        translation_options,
        stream: true,
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      return json(r.status, { error: data.error?.message || data.message || `HTTP ${r.status}` });
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
    let acc = '', buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m || m[1] === '[DONE]') continue;
        let piece;
        try { piece = JSON.parse(m[1]).choices?.[0]?.delta?.content; } catch { continue; }
        if (!piece) continue;
        // 兼容两种返回：增量片段 / 每次返回到目前为止的全文
        acc = acc && piece.startsWith(acc) ? piece : acc + piece;
        res.write(JSON.stringify({ t: acc }) + '\n');
      }
    }
    res.end(JSON.stringify({ t: acc, done: true }) + '\n');
  } catch (e) {
    if (ac.signal.aborted) return;
    console.error('[translate]', e.message);
    if (!res.headersSent) json(500, { error: e.message });
    else res.end(JSON.stringify({ error: e.message }) + '\n');
  }
}

// ---- 静态文件 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (req.method === 'POST' && urlPath === '/api/translate') return handleTranslate(req, res);
  const file = path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(path.join(__dirname, 'public'))) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket 转发 ----
const wss = new WebSocketServer({ server, path: '/ws' });

// 浏览器可通过 /ws?model=xxx 选择模型（白名单）
const ALLOWED_MODELS = new Set([
  'qwen3-asr-flash-realtime',
  'qwen3.5-livetranslate-flash-realtime',
]);

wss.on('connection', (client, req) => {
  const asked = new URL(req.url, 'http://x').searchParams.get('model');
  const model = ALLOWED_MODELS.has(asked) ? asked : MODEL;
  console.log('[client] 连接，模型', model);
  const upstream = new WebSocket(`${BASE_URL}?model=${model}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
  });
  const pending = [];

  upstream.on('open', () => {
    console.log('[upstream] 已连接');
    client.send(JSON.stringify({ type: 'proxy.connected' }));
    while (pending.length) upstream.send(pending.shift());
  });
  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data.toString());
  });
  upstream.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      const msg = `上游握手失败 HTTP ${res.statusCode} ${body}`;
      console.error('[upstream]', msg);
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify({ type: 'error', error: { message: msg } }));
      client.close();
    });
  });
  upstream.on('error', (e) => {
    console.error('[upstream] error', e.message);
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify({ type: 'error', error: { message: e.message } }));
  });
  upstream.on('close', (code, reason) => {
    console.log('[upstream] 关闭', code, reason.toString());
    if (client.readyState === WebSocket.OPEN) client.close();
  });

  client.on('message', (data) => {
    const text = data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push(text);
  });
  client.on('error', (e) => console.error('[client] error', e.message)); // ws 随后会触发 close
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  });
});

server.listen(PORT, () => console.log(`✅ 打开 http://localhost:${PORT}`));
