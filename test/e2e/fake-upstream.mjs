// Stand-in for the two Qwen endpoints that server.js reaches through QWEN_WS_URL and QWEN_MT_URL.
// Event shapes come from what public/index.html and server.js read, not from Qwen's documentation.
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const { WebSocketServer } = createRequire(path.join(root, 'server.js'))('ws');

const DEFAULTS = {
  handshake: 'ok',        // ok | reject (HTTP 401 on the WebSocket upgrade)
  handshakeDelay: 0,      // ms before the upgrade is answered
  finishDelay: 100,       // ms between session.finish and session.finished
  finalEvery: 10,         // audio packets (100 ms each) per sentence when VAD is on
  closeOnUpdate: 0,       // 1 closes the socket right after session.update
  mt: 'ok',               // ok | 429 | 500
  mtFailures: 0,          // with mt=429 or 500: how many requests fail before success (0 = all)
  mtDelay: 60,            // ms between translation chunks
};
let cfg = { ...DEFAULTS }, sessions = [], mt = [], mtFailed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translate(req, res) {
  let body = ''; for await (const c of req) body += c;
  const q = JSON.parse(body), entry = { at: Date.now(), auth: req.headers.authorization, ...q, outcome: 'ok' };
  mt.push(entry);
  if (cfg.mt !== 'ok' && (!cfg.mtFailures || mtFailed < cfg.mtFailures)) {
    mtFailed++; entry.outcome = cfg.mt;
    return res.writeHead(Number(cfg.mt), { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { message: cfg.mt === '429' ? 'rate limit' : 'fake failure' } }));
  }
  res.on('close', () => { if (!res.writableEnded) entry.outcome = 'cancelled'; });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of [`[${q.translation_options.target_lang}] `, q.messages[0].content]) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    await sleep(cfg.mtDelay);
  }
  res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  const json = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o, null, 2));
  if (req.url === '/mt') return translate(req, res);
  if (req.url === '/log') return json({ cfg, sessions, mt });
  if (req.url === '/reset') { cfg = { ...DEFAULTS }; sessions = sessions.filter((s) => s.open); mt = []; mtFailed = 0; return json({ cfg }); }
  if (req.url.startsWith('/set?')) {
    for (const [k, v] of new URL(req.url, 'http://x').searchParams) {
      if (!(k in DEFAULTS)) return res.writeHead(400).end('unknown setting ' + k);
      cfg[k] = typeof DEFAULTS[k] === 'number' ? Number(v) : v;
    }
    mtFailed = 0; return json({ cfg });
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, sock, head) => {
  sock.on('error', () => {});
  const c = { ...cfg };
  if (c.handshakeDelay) await sleep(c.handshakeDelay);
  if (c.handshake === 'reject') return sock.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 13\r\nConnection: close\r\n\r\nInvalidApiKey');
  if (sock.destroyed) return;
  wss.handleUpgrade(req, sock, head, (ws) => session(ws, req));
});

function session(ws, req) {
  const model = new URL(req.url, 'http://x').searchParams.get('model');
  const s = { n: sessions.length + 1, model, auth: req.headers.authorization, open: true, update: null, appends: 0, bytes: 0, sentences: 0, types: [] };
  sessions.push(s);
  const live = model.includes('livetranslate');
  let item = 0, since = 0, vad = true, target = '';
  const emit = (type, o = {}) => ws.readyState === 1 && ws.send(JSON.stringify({ type, ...o }));
  const id = () => `s${s.n}_item${item}`;
  const sentence = () => `session ${s.n} sentence ${s.sentences + 1}`;
  const TR = 'conversation.item.input_audio_transcription.';
  const finish = () => {
    if (!since) return;
    const t = sentence(); since = 0; s.sentences++;
    emit(TR + 'completed', { item_id: id(), transcript: t, language: 'en' });
    if (live) {
      emit('conversation.item.created', { previous_item_id: id(), item: { id: 'tr_' + id() } });
      emit('response.text.text', { item_id: 'tr_' + id(), text: `[${target}]`, stash: ' ...' });
      emit('response.text.done', { item_id: 'tr_' + id(), text: `[${target}] ${t}` });
    }
  };
  emit('session.created');
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (s.types.at(-1) !== m.type) s.types.push(m.type);
    if (m.type === 'session.update') {
      s.update = m.session; vad = !!m.session.turn_detection; target = m.session.translation?.language || '';
      emit('session.updated');
      if (cfg.closeOnUpdate) ws.close();
    } else if (m.type === 'input_audio_buffer.append') {
      s.appends++; s.bytes += Buffer.from(m.audio, 'base64').length;
      if (!since++) { item++; if (vad) emit('input_audio_buffer.speech_started'); }
      if (vad && since % 3 === 0) emit(TR + 'text', { item_id: id(), text: sentence().slice(0, 6 + since), stash: '' });
      if (vad && since >= cfg.finalEvery) { emit('input_audio_buffer.speech_stopped'); finish(); }
    } else if (m.type === 'input_audio_buffer.commit') finish();
    else if (m.type === 'session.finish') {
      const d = cfg.finishDelay; await sleep(d); finish(); emit('session.finished');
    }
  });
  ws.on('close', () => { s.open = false; });
  ws.on('error', () => {});
}
server.listen(Number(process.argv[2]), '127.0.0.1', () => console.log('fake upstream ready'));
