#!/usr/bin/env node
// Launches and drives an isolated qwen-asr instance. Needs Chrome, lsof, and the repo's own `ws`. Run it without arguments to list the commands.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNS = path.join(import.meta.dirname, '.runs');
const FAKE_KEY = 'fake-key-for-verification';
const run = process.env.VERIFY_RUN || 'default';
const dir = path.join(RUNS, run), scratch = path.join(dir, 'scratch'), evidence = path.join(dir, 'evidence');
const stateFile = path.join(scratch, 'state.json'), tone = path.join(scratch, 'tone.wav');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error('FAIL ' + m); process.exit(1); };
const state = () => { if (!fs.existsSync(stateFile)) die(`run "${run}" is not launched`); return JSON.parse(fs.readFileSync(stateFile)); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
// 16 kHz, 16-bit, mono sine wave. The fake upstream ignores what the audio says.
function toneWav(seconds) {
  const n = seconds * 16000, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
  return b;
}
async function until(fn, ms, what) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
  throw new Error(`timed out after ${ms} ms: ${what} (last: ${JSON.stringify(last)})`);
}

async function cdp() {
  const s = state();
  const tab = (await (await fetch(`http://127.0.0.1:${s.cdp}/json`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map(), events = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (!m.id) return events.push(m);
    const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.j(new Error(m.error.message)) : w.r(m.result);
  };
  const call = (method, params = {}) => new Promise((r, j) => { waiting.set(++id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (sel) => {
    const p = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'nearest'});const b=e.getBoundingClientRect();const x=b.x+b.width/2,y=b.y+b.height/2;const h=document.elementFromPoint(x,y);return{x,y,hit:!!h&&(e.contains(h)||h.contains(e)),off:!!e.disabled}})()`);
    if (!p) throw new Error('no element ' + sel);
    if (p.off) throw new Error('disabled ' + sel);
    if (!p.hit) throw new Error('covered ' + sel);
    for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  return { call, evaluate, click, events, close: () => ws.close() };
}
const VIEW = `({url:location.href,title:document.title,status:$('statusText').textContent,statusClass:$('status').className,hint:$('hintText').textContent,timer:$('timer').textContent,meta:$('meta').textContent,toast:$('toast').textContent,micShowsRecording:$('micBtn').classList.contains('recording'),micDisabled:$('micBtn').disabled,rows:[...document.querySelectorAll('.seg')].map(e=>({interim:e.classList.contains('interim'),text:e.querySelector('p').textContent,lang:e.querySelector('.lang-tag')?.textContent,translation:e.querySelector('.tr .txt')?.textContent,translationClass:e.querySelector('.tr')?.className})),prefs:localStorage.getItem('qwen-asr-prefs')})`;

const cmds = {
  async launch() {
    if (fs.existsSync(stateFile)) die(`run "${run}" already exists. Stop it, or set VERIFY_RUN to another name.`);
    if (!fs.existsSync(path.join(ROOT, 'node_modules/ws'))) die('node_modules/ws is missing. Run npm install in the repo.');
    fs.mkdirSync(scratch, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(tone, toneWav(26));
    const [app, up, dbg] = [await freePort(), await freePort(), await freePort()];
    const start = (name, cmd, args, env = {}) => {
      const out = fs.openSync(path.join(evidence, name + '.log'), 'a');
      const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out, out] });
      p.unref(); return p.pid;
    };
    const s = { app, up, cdp: dbg, startedAt: Date.now(), pids: {} };
    const save = () => fs.writeFileSync(stateFile, JSON.stringify(s));
    s.pids.upstream = start('upstream', process.execPath, [path.join(import.meta.dirname, 'fake-upstream.mjs'), String(up)]); save();
    s.pids.server = start('server', process.execPath, ['server.js'], {
      PORT: String(app), DASHSCOPE_API_KEY: FAKE_KEY, QWEN_MODEL: 'qwen3-asr-flash-realtime', QWEN_MT_MODEL: 'qwen-mt-flash',
      QWEN_WS_URL: `ws://127.0.0.1:${up}/ws`, QWEN_MT_URL: `http://127.0.0.1:${up}/mt`,
    }); save();
    const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    s.pids.chrome = start('chrome', chrome, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${path.join(scratch, 'profile')}`,
      '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1200,900', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`, 'about:blank']); save();
    await until(async () => (await fetch(`http://127.0.0.1:${up}/log`)).ok, 5000, 'fake upstream');
    await until(async () => (await fetch(`http://127.0.0.1:${app}/`)).ok, 5000, 'server.js');
    await until(async () => (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).some((t) => t.type === 'page'), 20000, 'Chrome');
    await cmds.open();
    console.log(`READY run=${run} http://localhost:${app} evidence=${evidence}`);
  },
  async open() {
    const b = await cdp();
    await b.call('Page.navigate', { url: `http://localhost:${state().app}/` });
    await until(() => b.evaluate(`document.readyState==='complete' && typeof PREF_FIELDS!=='undefined' && !!$('micBtn').onclick`), 5000, 'page script');
    b.close();
  },
  async doctor() {
    const s = state(); let bad = 0;
    const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
    for (const [n, pid] of Object.entries(s.pids)) check(alive(pid), `${n} pid ${pid} is running`);
    let owner = ''; try { owner = execFileSync('lsof', ['-nP', `-iTCP:${s.app}`, '-sTCP:LISTEN', '-t']).toString().trim(); } catch {}
    check(owner === String(s.pids.server), `port ${s.app} belongs to our server`);
    check(fs.statSync(path.join(ROOT, 'server.js')).mtimeMs < s.startedAt, 'server.js is unchanged since launch');
    try {
      const body = Buffer.from(await (await fetch(`http://127.0.0.1:${s.app}/`)).arrayBuffer());
      check(sha(body) === sha(fs.readFileSync(path.join(ROOT, 'public/index.html'))), 'served page equals public/index.html');
      const log = await (await fetch(`http://127.0.0.1:${s.up}/log`)).json();
      check([...log.sessions, ...log.mt].every((x) => x.auth === 'Bearer ' + FAKE_KEY), 'upstream saw only the fake key');
      const b = await cdp();
      check(await b.evaluate(`location.origin`) === `http://localhost:${s.app}`, 'Chrome shows our app');
      b.close();
    } catch (e) { check(false, e.message); }
    if (bad) process.exit(1);
  },
  async click(sel) { const b = await cdp(); await b.click(sel); b.close(); },
  async select(sel, value) {
    const b = await cdp();
    const v = await b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()`);
    b.close(); if (v !== value) die(`no option ${value}`);
  },
  async type(sel, text) {
    const b = await cdp(); await b.click(sel); await b.call('Input.insertText', { text });
    await b.evaluate(`document.activeElement.blur()`); b.close();
  },
  async press(key) {
    const b = await cdp(), k = key === 'Space' ? { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' } : { key, code: key };
    await b.call('Input.dispatchKeyEvent', { type: 'keyDown', ...k }); await b.call('Input.dispatchKeyEvent', { type: 'keyUp', ...k }); b.close();
  },
  async pickfile(file) {
    const b = await cdp(); await b.call('Page.enable'); await b.call('DOM.enable');
    await b.call('Page.setInterceptFileChooserDialog', { enabled: true }); await b.click('#micBtn');
    const ev = await until(() => b.events.find((e) => e.method === 'Page.fileChooserOpened'), 3000, 'file chooser');
    await b.call('DOM.setFileInputFiles', { files: [path.resolve(file)], backendNodeId: ev.params.backendNodeId });
    await b.call('Page.setInterceptFileChooserDialog', { enabled: false }); b.close();
  },
  async wait(expr, ms = '8000') { const b = await cdp(); try { await until(() => b.evaluate(expr), Number(ms), expr); console.log('ok ' + expr); } finally { b.close(); } },
  async eval(expr) { const b = await cdp(); console.log(JSON.stringify(await b.evaluate(expr), null, 2)); b.close(); },
  async view() { const b = await cdp(); console.log(JSON.stringify(await b.evaluate(VIEW), null, 2)); b.close(); },
  async snap(name) {
    const s = state(), b = await cdp();
    const view = await b.evaluate(VIEW), { data } = await b.call('Page.captureScreenshot'); b.close();
    const upstream = await (await fetch(`http://127.0.0.1:${s.up}/log`)).json();
    fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(data, 'base64'));
    fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ at: new Date().toISOString(), view, upstream }, null, 2));
    console.log(path.join(evidence, name + '.{png,json}'));
  },
  async upstream(verb, ...kv) {
    const r = await fetch(`http://127.0.0.1:${state().up}/${verb === 'set' ? 'set?' + kv.join('&') : verb}`);
    console.log(await r.text()); if (!r.ok) process.exit(1);
  },
  async http(method, p, body) {
    const r = await fetch(`http://127.0.0.1:${state().app}${p}`, { method, body });
    console.log(r.status + '\n' + (await r.text()).slice(0, 4000));
  },
  async stop() {
    if (!fs.existsSync(stateFile)) return console.log(`run "${run}" is not launched`);
    const { pids } = state();
    for (const pid of Object.values(pids)) if (alive(pid)) process.kill(pid, 'SIGTERM');
    await until(() => Object.values(pids).every((p) => !alive(p)), 5000, 'processes to exit').catch(() => { for (const p of Object.values(pids)) if (alive(p)) process.kill(p, 'SIGKILL'); });
    await sleep(300); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(`STOPPED run=${run}. Evidence kept in ${evidence}`);
  },
};
const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) die('commands: ' + Object.keys(cmds).join(' '));
cmds[cmd](...args).catch((e) => die(e.message));
