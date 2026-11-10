#!/usr/bin/env node
// capture-publish.mjs — 抓一次"带图发帖"，拿到 dynamic_pic 的真实形状。
//
// 用法：双击 发帖抓包.bat，或 node scripts/capture-publish.mjs
//
// 流程：起隔离浏览器（用 login 留下的 profile，通常已登录）→ 打开 /publish
//      → 你正常发一条带图动态 → 脚本录下请求 → 按 Enter 结束并落盘。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const PROFILE = path.join(STATE, 'chrome-profile');
const CAPTURE_DIR = path.join(STATE, 'capture');
const DOC = path.join(ROOT, 'docs', 'PUBLISH_CAPTURE.md');

const START = 'https://w.sohu.com/publish';
const log = (...a) => console.log('[capture]', ...a);

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  for (const p of list) if (fs.existsSync(p)) return p;
  throw new Error('没找到 Chrome/Edge');
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { process.kill(-pid); } catch { try { process.kill(pid); } catch {} } }
}

function prepareProfile() {
  for (const name of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(PROFILE, name), { force: true }); } catch {}
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        return;
      }
      for (const fn of this.handlers.get(m.method) ?? []) fn(m.params ?? {}, m.sessionId);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('WS 超时')), 10000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('WS 失败')); }, { once: true });
    });
    return new CDP(ws);
  }
  on(m, fn) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(fn); }
  send(method, params = {}, sessionId) {
    const id = this.id++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(dir, ms = 25000) {
  const file = path.join(dir, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const p = Number(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0]);
      if (Number.isInteger(p) && p > 0) return p;
    } catch {}
    await sleep(200);
  }
  throw new Error('等不到 DevToolsActivePort');
}

const inflight = new Map();
const captured = [];

const isInteresting = (u) => /sns\.sohu\.com/.test(u) && /feeds\/(text|dynamic)|upload/i.test(u);

function attach(cdp, sid) {
  cdp.on('Network.requestWillBeSent', (p, s) => {
    if (s !== sid) return;
    const { request, requestId } = p;
    if (!isInteresting(request.url)) return;
    inflight.set(requestId, {
      url: request.url,
      method: request.method,
      headers: request.headers,
      postData: request.postData ?? null,
      at: Date.now()
    });
  });
  cdp.on('Network.responseReceived', (p, s) => {
    if (s !== sid) return;
    const rec = inflight.get(p.requestId);
    if (rec) { rec.status = p.response.status; rec.mimeType = p.response.mimeType; }
  });
  cdp.on('Network.loadingFinished', async (p, s) => {
    if (s !== sid) return;
    const rec = inflight.get(p.requestId);
    if (!rec) return;
    inflight.delete(p.requestId);
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, s);
      rec.responseBody = String(body.body ?? '').slice(0, 20000);
    } catch {}
    captured.push(rec);
    log(`抓到 ${rec.method} ${rec.status ?? '?'} ${rec.url.split('?')[0]}`);
    if (/feeds\/(dynamic|text)/.test(rec.url) && rec.method === 'POST') {
      log('★ 这就是发布请求');
    }
  });
}

function redactHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = /cookie|token|auth|sign|ticket/i.test(k) ? '<redacted>' : String(v).slice(0, 300);
  return out;
}

function writeArtifacts() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const raw = path.join(CAPTURE_DIR, `publish-${stamp}.json`);
  fs.writeFileSync(raw, JSON.stringify(captured, null, 2), 'utf8');

  const md = ['# 带图发帖抓包', '', `生成时间：${new Date().toLocaleString('zh-CN')}　共 ${captured.length} 条`, ''];
  for (const c of captured) {
    md.push(`## ${c.method} ${c.status ?? '?'}`, '', '```', c.url, '```', '');
    md.push('请求头：', '```json', JSON.stringify(redactHeaders(c.headers), null, 2), '```', '');
    md.push('请求体：', '```', String(c.postData ?? '(无)').slice(0, 4000), '```', '');
    md.push('响应：', '```', String(c.responseBody ?? '').slice(0, 2000), '```', '');
  }
  fs.writeFileSync(DOC, md.join('\n'), 'utf8');
  return { raw };
}

async function main() {
  fs.mkdirSync(STATE, { recursive: true });
  const browser = findBrowser();
  log('浏览器:', browser);
  prepareProfile();

  const proc = spawn(browser, [
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--lang=zh-CN',
    START
  ], { stdio: 'ignore' });
  proc.on('exit', (c) => log('浏览器退出 code=', c));

  await sleep(1500);
  if (proc.exitCode !== null) throw new Error('浏览器启动后立即退出（profile 可能被占用）');

  const port = await waitPort(PROFILE);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page') ?? null;
  if (!page) throw new Error('没有页面');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cdp.send('Network.enable', { maxPostDataSize: 200000 }, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  attach(cdp, sessionId);

  log('');
  log('================================================');
  log(' 浏览器已打开发布页。请：');
  log(' 1) 选一个圈子（比如汕大树洞）');
  log(' 2) 写几个字，加一张图');
  log(' 3) 点发布');
  log(' 4) 回到这个窗口按 Enter（发布完可以顺手删掉那条测试）');
  log('================================================');
  log('');

  let enter = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', () => { enter = true; });

  const deadline = Date.now() + 15 * 60 * 1000;
  while (!enter && Date.now() < deadline) {
    await sleep(500);
    if (captured.some((c) => /feeds\/dynamic/.test(c.url))) log('（已抓到带图发布，按 Enter 结束）');
  }

  const { raw } = writeArtifacts();
  log(`抓包已保存：${path.relative(ROOT, raw)}`);
  log(`文档：${path.relative(ROOT, DOC)}`);
  if (!captured.length) log('⚠️ 一条都没抓到：确认你点的是"发布"、且网络请求发往 sns.sohu.com');

  try { rl.close(); } catch {}
  killTree(proc.pid);
  log('浏览器已关闭');
}

main().catch((e) => {
  console.error('[capture] 失败:', e?.message ?? e);
  process.exit(1);
});
