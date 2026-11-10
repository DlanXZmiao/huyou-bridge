#!/usr/bin/env node
// login.mjs — P0：起一个隔离的 Chrome/Edge，你短信登录，脚本同时抓接口。
//
// 做的事：
//   1. 找本机浏览器（Chrome / Edge），用独立 user-data-dir 启动（不碰日常浏览器）；
//   2. 打开 w.sohu.com，等你自己输手机号 + 验证码；
//   3. 全程监听 Network 域，把 *.sns.sohu.com 的请求/响应存下来；
//   4. 登录成功后导出 cookie + localStorage 到 state/session.json（收紧 ACL）；
//   5. 抓到的评论请求落 state/capture/，并生成脱敏的 fixtures 样本 + 文档骨架。
//
// 用法：
//   node src/login.mjs            # 正常登录（有窗口）
//   node src/login.mjs --smoke    # 无头自检：起浏览器→打开页面→读标题→退出
//   node src/login.mjs --keep     # 结束后不关浏览器（默认关）
//
// 说明：零依赖，CDP 走 Node 24 自带的全局 WebSocket。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const PROFILE = path.join(STATE, 'chrome-profile');
const CAPTURE_DIR = path.join(STATE, 'capture');
const SESSION_FILE = path.join(STATE, 'session.json');
const FIXTURE_FILE = path.join(ROOT, 'fixtures', 'comment-api.sample.json');
const DOC_FILE = path.join(ROOT, 'docs', 'COMMENT_API.md');

const START_URL = 'https://w.sohu.com/';
const MAX_BODY = 200_000;

const args = new Set(process.argv.slice(2));
const SMOKE = args.has('--smoke');
const KEEP_OPEN = args.has('--keep');

const log = (...a) => console.log('[login]', ...a);

// ── 浏览器发现 ────────────────────────────────────────────────────────────────
function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('没找到 Chrome 或 Edge，请手动在 src/login.mjs 里指定路径');
}

// ── 极简 CDP 客户端 ───────────────────────────────────────────────────────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.handlers.get(msg.method) ?? []) {
          try { fn(msg.params ?? {}, msg.sessionId); } catch (e) { log('handler error:', e.message); }
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket 打开超时')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WebSocket 连接失败')); }, { once: true });
    });
    return new CDP(ws);
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30_000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 杀掉整个进程树（Chrome 会派生多个子进程，只 kill 主进程会留孤儿）。 */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid); } catch { try { process.kill(pid); } catch {} }
  }
}

/**
 * 清掉上一次残留的端口文件与单例锁。
 * 不清的话：上回无头自检留下的 DevToolsActivePort 会被当成这次的端口，
 * 于是 fetch 一个没人监听的端口 —— 报错是 `fetch failed`，很难看出原因。
 */
function prepareProfile() {
  for (const name of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(PROFILE, name), { force: true }); } catch {}
  }
}

async function waitForDevToolsPort(dir, timeoutMs = 25_000) {
  const file = path.join(dir, 'DevToolsActivePort');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      const port = Number(text.split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* 还没写出来 */ }
    await sleep(200);
  }
  throw new Error('等不到 DevToolsActivePort（浏览器可能没起来）');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// ── 抓包状态 ──────────────────────────────────────────────────────────────────
const inflight = new Map();   // requestId -> { url, method, postData, ts }
const captures = [];          // 已完成的请求

function isInteresting(url) {
  if (!/sns\.sohu\.com/.test(url)) return false;
  return /comment|reply|feed|publish|login|user/i.test(url);
}

function attachNetwork(cdp, sessionId) {
  cdp.on('Network.requestWillBeSent', (p, sid) => {
    if (sid !== sessionId) return;
    const { request, requestId } = p;
    if (!isInteresting(request.url)) return;
    inflight.set(requestId, {
      url: request.url,
      method: request.method,
      headers: request.headers,
      postData: request.postData ?? null,
      ts: Date.now()
    });
  });

  cdp.on('Network.responseReceived', (p, sid) => {
    if (sid !== sessionId) return;
    const rec = inflight.get(p.requestId);
    if (!rec) return;
    rec.status = p.response.status;
    rec.mimeType = p.response.mimeType;
  });

  cdp.on('Network.loadingFinished', async (p, sid) => {
    if (sid !== sessionId) return;
    const rec = inflight.get(p.requestId);
    if (!rec) return;
    inflight.delete(p.requestId);
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, sessionId);
      rec.responseBody = String(body.body ?? '').slice(0, MAX_BODY);
      rec.base64Encoded = Boolean(body.base64Encoded);
    } catch { /* 响应已被回收，忽略 */ }

    if (isCommentSubmit(rec)) log('★ 抓到评论提交');
    if (rec.method === 'POST' || /comment|reply/i.test(rec.url)) captures.push(rec);
    log(`捕获 ${rec.method} ${rec.status ?? '?'} ${rec.url.slice(0, 120)}`);
  });
}

// ── 登录态判断 ────────────────────────────────────────────────────────────────
/**
 * 从 CDP 读全部 cookie 判断是否登录。
 *
 * 为什么不用页面里的 document.cookie / localStorage：狐友的登录 token 在 cookie 里
 * （`hyuid` / `pchytk`），其中一部分是 httpOnly，页面 JS 读不到。之前用
 * “login 接口响应里出现 token”当信号，会被扫码接口的 ticket 误判成已登录。
 */
async function probeCookies(cdp) {
  try {
    const r = await cdp.send('Storage.getCookies', {});
    const list = (r.cookies ?? []).filter((c) => /(^|\.)sohu\.com$/i.test(String(c.domain ?? '')));
    const has = (name) => list.some(
      (c) => String(c.name).toLowerCase() === name && String(c.value ?? '').length > 0
    );
    return { list, loggedIn: has('hyuid') || has('pchytk') };
  } catch {
    return { list: [], loggedIn: false };
  }
}

/** 真正的“发表评论”提交：POST，且不是 list/show/detail 这类读取接口。 */
function isCommentSubmit(c) {
  if (c.method !== 'POST') return false;
  if (!/comment|reply|publish/i.test(c.url)) return false;
  return !/\/(list|show|detail|count)\b/i.test(c.url);
}

const PROBE_JS = `(() => {
  const ls = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = String(localStorage.getItem(k) ?? '').slice(0, 300); } } catch (e) {}
  return JSON.stringify({ url: location.href, ua: navigator.userAgent, ls, cookie: document.cookie });
})()`;

async function probeLogin(cdp, sessionId) {
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression: PROBE_JS, returnByValue: true, awaitPromise: false
    }, sessionId);
    const raw = r?.result?.value;
    if (!raw) return null;
    const info = JSON.parse(raw);
    const lsBlob = JSON.stringify(info.ls);
    const tokenLike = /"[\w.-]*(token|ticket|auth|sess|sign)[\w.-]*"\s*:\s*"[^"]{12,}"/i.test(lsBlob);
    const cookieLike = /(?:^|;\s*)([\w-]*(?:token|ticket|sess|uid)[\w-]*)=([^;]{12,})/i.test(info.cookie);
    return { info, loggedIn: tokenLike || cookieLike };
  } catch {
    return null;
  }
}

// ── 落盘 ──────────────────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [STATE, PROFILE, CAPTURE_DIR, path.join(ROOT, 'fixtures'), path.join(ROOT, 'docs')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// 不做 ACL 收紧：Windows 上 `/inheritance:r` 配合 `/T` 会把“去掉继承”同样应用到
// **文件**，结果是文件本身没有当前用户的 ACE —— 连脚本自己都读不回来（踩过两次，
// 第一次锁死目录，第二次锁死 capture 文件）。用户目录默认只对本人+SYSTEM+管理员
// 开放，已经够用，不再手动动它。

function writeSession(info, cookies) {
  const doc = {
    createdAt: new Date().toISOString(),
    source: 'login.mjs',
    url: info.url,
    userAgent: info.ua,
    localStorage: info.ls,
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite
    }))
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

function redact(value) {
  const s = String(value ?? '');
  if (s.length > 40) return s.slice(0, 12) + '…<redacted>';
  return s;
}

function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /cookie|token|auth|sign|ticket/i.test(k) ? redact(v) : String(v).slice(0, 300);
  }
  return out;
}

function redactBody(body) {
  if (!body) return '(无)';
  const s = String(body);
  try {
    const obj = JSON.parse(s);
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          out[k] = /token|auth|sign|ticket|cookie|passport|ppinf/i.test(k) ? '<redacted>' : walk(val);
        }
        return out;
      }
      return v;
    };
    return JSON.stringify(walk(obj), null, 2);
  } catch {
    return s.replace(/(^|&)([\w-]*(?:token|auth|sign|ticket|ppinf)[\w-]*)=([^&]*)/gi, '$1$2=<redacted>');
  }
}

function writeCaptureArtifacts() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawFile = path.join(CAPTURE_DIR, `capture-${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify(captures, null, 2), 'utf8');

  const submits = captures.filter(isCommentSubmit);
  const reads = captures.filter((c) => !isCommentSubmit(c) && /comment|reply|feed/i.test(c.url));

  const brief = (c) => ({
    method: c.method,
    status: c.status,
    url: c.url,
    headers: redactHeaders(c.headers),
    postData: redactBody(c.postData),
    responsePreview: String(c.responseBody ?? '').slice(0, 800)
  });

  const sample = {
    capturedAt: stamp,
    note: 'header 与 postData 中的凭据已脱敏；完整原始包在 state/capture/ 下',
    totalCaptured: captures.length,
    commentSubmits: submits.map(brief),
    commentReads: reads.map(brief)
  };
  fs.writeFileSync(FIXTURE_FILE, JSON.stringify(sample, null, 2), 'utf8');

  const md = [
    '# 狐友评论接口（P0 抓包）',
    '',
    `> 生成时间：${new Date().toLocaleString('zh-CN')}　采集 ${captures.length} 条　评论提交 ${submits.length} 条`,
    '',
    '## 说明',
    '',
    '本文由 `src/login.mjs` 在登录/发评论过程中自动生成。**凭据已脱敏**，完整原始包在 `state/capture/`（不入库）。',
    ''
  ];

  const section = (title, list, emptyText) => {
    md.push(`## ${title}`, '');
    if (list.length === 0) { md.push(emptyText, ''); return; }
    for (const c of list) {
      md.push(`### ${c.method} ${c.status ?? '?'}`, '', '```');
      md.push(c.url);
      md.push('```', '', '请求头（脱敏）：', '', '```json');
      md.push(JSON.stringify(redactHeaders(c.headers), null, 2));
      md.push('```', '', '请求体（脱敏）：', '', '```');
      md.push(redactBody(c.postData));
      md.push('```', '', '响应预览：', '', '```');
      md.push(String(c.responseBody ?? '').slice(0, 1200));
      md.push('```', '');
    }
  };

  section('发表评论（提交）', submits,
    '_没有抓到评论提交。请登录后真的发一条评论再重跑。_');
  section('评论/帖子读取（参考）', reads.slice(0, 6), '_无。_');

  fs.writeFileSync(DOC_FILE, md.join('\n'), 'utf8');
  return { rawFile, count: captures.length, submits: submits.length };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  ensureDirs();
  const browser = findBrowser();
  log('浏览器:', browser);
  log('独立 profile:', PROFILE);

  const chromeArgs = [
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--lang=zh-CN',
    START_URL
  ];
  if (SMOKE) chromeArgs.unshift('--headless=new');

  prepareProfile();
  const proc = spawn(browser, chromeArgs, { detached: false, stdio: 'ignore' });
  proc.on('exit', (code) => {
    if (!SMOKE) log('浏览器已退出，code=', code);
  });

  await sleep(1500);
  if (proc.exitCode !== null) {
    throw new Error(`浏览器启动后立即退出（code=${proc.exitCode}）：profile 可能被另一个 Chrome 占用，先关掉所有 Chrome 再试`);
  }

  const port = await waitForDevToolsPort(PROFILE);
  log('DevTools 端口:', port);
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);

  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  let page = targets.find((t) => t.type === 'page' && /w\.sohu\.com/.test(t.url))
    || targets.find((t) => t.type === 'page');
  if (!page) {
    await cdp.send('Target.createTarget', { url: START_URL });
    await sleep(1500);
    const again = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    page = again.find((t) => t.type === 'page');
  }
  if (!page) throw new Error('没有可用的页面目标');

  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: page.targetId ?? page.id, flatten: true
  });
  await cdp.send('Network.enable', { maxPostDataSize: MAX_BODY }, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  attachNetwork(cdp, sessionId);

  if (SMOKE) {
    await sleep(4000);
    const t = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
    log('页面标题:', t?.result?.value);
    log('自检通过：CDP 可用，网络监听已挂上');
    killTree(proc.pid);
    return;
  }

  log('');
  log('==============================================');
  log('  浏览器已打开。请在这个窗口里：');
  log('  1) 用手机号 + 短信验证码登录');
  log('  2) 登录后随便找一条帖子，发一条测试评论');
  log('  3) 回到这里按 Enter（或等我自动检测到）');
  log('==============================================');
  log('');

  let loggedIn = false;
  let exported = false;
  let finished = false;

  const finish = async (reason) => {
    if (finished) return;
    finished = true;
    // 1) 先落抓包：这时目录权限一定还在（收紧权限放到最后一步）
    try {
      const art = writeCaptureArtifacts();
      log(`抓包完成：共 ${art.count} 条，评论提交 ${art.submits} 条`);
      log('  →', path.relative(ROOT, art.rawFile));
      log('  →', path.relative(ROOT, FIXTURE_FILE));
      log('  →', path.relative(ROOT, DOC_FILE));
    } catch (e) {
      log('写抓包产物失败:', e.message);
    }

    // 2) 再落登录态（cookie 为准，页面关掉也能读）
    try {
      const probe = await probeLogin(cdp, sessionId);
      const ck = await probeCookies(cdp);
      if (ck.loggedIn) {
        const doc = writeSession(probe?.info ?? { url: START_URL, ua: '', ls: {} }, ck.list);
        exported = true;
        log(`已导出登录态：cookie ${doc.cookies.length} 条，localStorage ${Object.keys(doc.localStorage).length} 项`);
        log('  →', SESSION_FILE);
      } else {
        log('没有检测到登录 cookie（hyuid / pchytk），登录态未导出');
      }
    } catch (e) {
      log('导出登录态失败:', e.message);
    }
    if (!exported) log('⚠️ 没有登录态，P1 无法进行；请重新运行并完成登录');

    if (!KEEP_OPEN) {
      killTree(proc.pid);
      log('浏览器已关闭（profile 保留，下次仍免登录）');
    }
  };

  let enterPressed = false;
  let rl = null;
  try {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', () => { enterPressed = true; });
    rl.on('close', () => { /* 无 TTY 时靠自动检测 */ });
  } catch {
    // 没有控制台（例如被 Start-Process 拉起）时只能靠自动检测
  }

  const deadline = Date.now() + 15 * 60 * 1000;
  while (!finished && Date.now() < deadline) {
    await sleep(3000);
    if (enterPressed) { log('收到 Enter，开始导出…'); await finish('enter'); break; }
    if (!loggedIn) {
      const ck = await probeCookies(cdp);
      if (ck.loggedIn) {
        loggedIn = true;
        log('检测到已登录。请发一条测试评论（最多等 10 分钟；抓到后 5 秒自动收尾，或按 Enter 立即导出）');
        const waitUntil = Date.now() + 600_000;
        while (Date.now() < waitUntil && !enterPressed && !finished) {
          await sleep(1000);
          if (captures.some(isCommentSubmit)) {
            log('已抓到评论提交，5 秒后导出…');
            await sleep(5000);
            break;
          }
        }
        if (!finished) await finish('auto');
        break;
      }
    }
  }
  if (!finished) {
    log('等待超时（15 分钟），直接导出当前抓到的东西');
    await finish('timeout');
  }
  try { rl.close(); } catch {}
}

main().catch((e) => {
  console.error('[login] 失败:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
