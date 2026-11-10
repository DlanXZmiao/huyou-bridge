#!/usr/bin/env node
// console.js — 本地设置页（只监听 127.0.0.1，带一次性 token）
//
// 用法：node src/console.js
//      启动后终端会打印 http://127.0.0.1:3400/?token=xxxx
//
// 页面能改：人设 / 策略 / 配额 / 模式，改完写回 settings/ 并立即生效；
// 还能"试写一条"（只生成不发送）和一键 STOP。

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadQuota, loadPostSettings, loadCleanupSettings, killSwitchOn, ROOT as CFG_ROOT } from './config.js';
import { loadState, saveState, stateFile, alreadyCommented, usageView, recordUsage, recordPost } from './state.js';
import { fetchRecommendFeeds, fetchComments, fetchCircleFeeds, filterByCircles } from './feed.js';
import { loadPersona, decide } from './decide.js';
import { createLLM } from './llm.js';
import { loadSession, getReplyList } from './api.js';
import { checkGate } from './gates.js';
import { composePost, loadStyle, publishDraft } from './post.js';
import { cleanupContext } from './cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SETTINGS = path.join(ROOT, 'settings');
const HISTORY = path.join(SETTINGS, '.history');
const PAGE = path.join(ROOT, 'public', 'settings.html');
const TOKEN = crypto.randomBytes(16).toString('hex');
const PORT = Number(loadConfig(ROOT).server?.port ?? 3400);
const HOST = '127.0.0.1';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const atomicWrite = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
};

function snapshot() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(HISTORY, ts);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['persona.md', 'policy.md', 'quota.json']) {
    try { fs.copyFileSync(path.join(SETTINGS, f), path.join(dir, f)); } catch { /* 首次保存可能还没有 */ }
  }
  keepHistory(10);
  return dir;
}

function keepHistory(keep) {
  try {
    const dirs = fs.readdirSync(HISTORY).sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      fs.rmSync(path.join(HISTORY, d), { recursive: true, force: true });
    }
  } catch { /* 目录不存在就跳过 */ }
}

function loadStateView(cfg, state) {
  const now = Date.now();
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayCount = state.quota.day === day ? state.quota.dayCount : 0;
  const webBase = (cfg.huyou?.webBase ?? 'https://w.sohu.com').replace(/\/+$/, '');
  return {
    dayCount,
    lastSentAt: state.lastSentAt || 0,
    blockedUntil: state.blockedUntil || 0,
    failures: state.failures || 0,
    recent: state.sent.slice(-12).reverse().map((s) => ({
      ...s,
      postUrl: `${webBase}/?feedDetail=${s.feedId}`
    })),
    stopOn: killSwitchOn(cfg, ROOT)
  };
}

function statePayload() {
  const cfg = loadConfig(ROOT);
  const quota = loadQuota(ROOT);
  const persona = read(path.join(SETTINGS, 'persona.md'));
  const policy = read(path.join(SETTINGS, 'policy.md'));
  const state = loadState(stateFile(ROOT));
  const view = loadStateView(cfg, state);
  let model = 'unknown';
  try { model = createLLM(cfg).describe(); } catch { model = '未配置 key'; }
  return {
    quota,
    persona,
    policy,
    gates: {
      hardBlockTopics: cfg.gates?.hardBlockTopics ?? [],
      bannedPhrases: cfg.gates?.bannedPhrases ?? []
    },
    status: view,
    usage: usageView(state),
    context: {
      sent: (state.sent ?? []).length,
      threads: Object.keys(state.threads ?? {}).length,
      posts: (state.posts ?? []).length,
      decisions: Object.keys(state.decisions ?? {}).length,
      oldestSentAt: (state.sent ?? [])[0]?.at ?? null
    },
    post: loadPostSettings(ROOT),
    cleanup: loadCleanupSettings(ROOT),
    posts: (state.posts ?? []).slice(-5).reverse(),
    model,
    pollIntervalMs: cfg.huyou?.pollIntervalMs ?? 600000
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

const num = (v, min, max, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

async function tryOne() {
  const cfg = loadConfig(ROOT);
  const quota = loadQuota(ROOT);
  const session = loadSession(ROOT);
  const state = loadState(stateFile(ROOT));
  const llm = createLLM(cfg, { onUsage: (u) => recordUsage(state, u) });
  const { persona, policy } = loadPersona(ROOT);
  const feeds = await fetchRecommendFeeds({ limit: 20, cfg });
  const pool = filterByCircles(feeds, quota).filter((f) => !alreadyCommented(state, f.feedId)).slice(0, 10);
  if (!pool.length) return { ok: false, error: '没有符合条件的帖子（圈子过滤后为空？）' };
  const results = [];
  for (const feed of pool.slice(0, 3)) {
    let comments = [];
    try { comments = await fetchComments(feed.feedId, { count: 8, session }); } catch { /* 忽略 */ }
    const d = await decide({ llm, persona, policy, feed, comments, quota });
    const gate = d.action === 'comment'
      ? checkGate({ feed, text: d.text, cfg: cfg.gates, quota, history: state.sent.slice(-20).map((s) => s.text) })
      : { ok: false, reasons: ['模型选择不评论'] };
    results.push({ feedId: feed.feedId, content: feed.content.slice(0, 120), circle: feed.circle, decision: d, gate });
    if (d.action === 'comment' && gate.ok) break;
  }
  saveState(stateFile(ROOT), state);
  return { ok: true, results, usage: usageView(state) };
}

async function threadsView() {
  const cfg = loadConfig(ROOT);
  const webBase = (cfg.huyou?.webBase ?? 'https://w.sohu.com').replace(/\/+$/, '');
  const state = loadState(stateFile(ROOT));
  const now = Date.now();
  const recent = (state.sent ?? [])
    .filter((s) => s.commentId && now - Number(s.at ?? 0) < 3 * 86400000)
    .slice(-6)
    .reverse();

  let session = null;
  try { session = loadSession(ROOT); } catch { /* 未登录就只显示本地状态 */ }
  const myId = session ? String(session.cookies.hyuid ?? '') : '';

  const out = [];
  for (const s of recent) {
    const key = String(s.commentId);
    const th = state.threads?.[key] ?? {};
    let replies = [];
    if (session) {
      try {
        const r = await getReplyList(s.feedId, key, { count: 20, session });
        if (r.status === 100000) {
          replies = (r.data?.list ?? []).map((x) => ({
            commentId: String(x.commentId ?? ''),
            userName: x.userName ?? '',
            content: String(x.content ?? '').slice(0, 120),
            at: Number(x.timeId ?? 0),
            isMine: Boolean(myId) && String(x.userId) === myId,
            forMe: Boolean(myId) && String(x.replyUserId) === myId,
            handled: th.handled?.[String(x.commentId ?? '')] ?? null
          }));
        }
      } catch { /* 单个线程失败不影响其他 */ }
    }
    out.push({
      feedId: String(s.feedId),
      myCommentId: key,
      myText: s.text,
      at: s.at,
      myRounds: th.myRounds ?? 0,
      maxRounds: th.maxRounds ?? 2,
      stopped: Boolean(th.stopped),
      postUrl: `${webBase}/?feedDetail=${s.feedId}`,
      replies
    });
  }
  return out;
}

async function gatherPostFeeds(cfg, quota, limit = 14) {
  const sources = [...await fetchRecommendFeeds({ limit: 20, cfg })];
  for (const id of (quota.circleIds ?? [])) {
    try { sources.push(...await fetchCircleFeeds(id, { count: 10, cfg })); } catch { /* 忽略 */ }
  }
  const seen = new Map(sources.map((f) => [f.feedId, f]));
  return [...seen.values()].slice(0, limit);
}

async function makeDraft() {
  const cfg = loadConfig(ROOT);
  const quota = loadQuota(ROOT);
  const feeds = await gatherPostFeeds(cfg, quota, 14);
  if (!feeds.length) throw new Error('没有可用素材');
  const { persona } = loadPersona(ROOT);
  const style = loadStyle(ROOT);
  const llm = createLLM(cfg);
  const draft = await composePost({ llm, persona, style, feeds, stickerDir: path.join(ROOT, '表情包') });
  return { draft, feeds };
}

async function publishNow() {
  const post = loadPostSettings(ROOT);
  if (!post.circleId) throw new Error('请先填写发帖目标圈子 ID');
  if (fs.existsSync(path.join(ROOT, 'state', 'STOP'))) throw new Error('STOP 文件存在，已停止');
  const { draft } = await makeDraft();
  const session = loadSession(ROOT);
  const r = await publishDraft({ draft, session, circleId: post.circleId, anonymous: post.anonymous, withImage: post.withImage !== false });
  if (r.status === 100000) {
    const state = loadState(stateFile(ROOT));
    recordPost(state, { feedId: r.feedId, text: draft.text });
    saveState(stateFile(ROOT), state);
  }
  return { ...r, draft };
}

/** 已发评论分页：最新在前，每页默认 5 条。 */
function sentView(state, { page = 1, size = 5, webBase = 'https://w.sohu.com' } = {}) {
  const all = [...(state.sent ?? [])].reverse();
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  const items = all.slice((p - 1) * size, p * size).map((s) => ({
    feedId: String(s.feedId ?? ''),
    commentId: s.commentId ?? null,
    text: s.text ?? '',
    at: s.at ?? null,
    postUrl: `${webBase.replace(/\/+$/, '')}/?feedDetail=${s.feedId}`
  }));
  return { total, page: p, pages, size, items };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ?? req.headers['x-token'];

  if (url.pathname === '/') {
    if (token !== TOKEN) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('需要 token：请用终端里打印的带 ?token= 的地址打开。');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(PAGE, 'utf8'));
  }

  if (url.pathname.startsWith('/api/')) {
    if (token !== TOKEN) return json(res, 401, { ok: false, error: 'token 无效' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, { ok: true, ...statePayload() });
      }

      if (req.method === 'GET' && url.pathname === '/api/threads') {
        return json(res, 200, { ok: true, threads: await threadsView() });
      }

      if (req.method === 'POST' && url.pathname === '/api/save-post') {
        const p = await readBody(req);
        const time = String(p.dailyTime ?? '').trim();
        const timeOk = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
        if (p.mode === 'daily' && !timeOk) throw new Error('定时时间格式必须是 HH:MM（例如 20:30）');
        const postCfg = {
          enabled: p.enabled === true,
          mode: p.mode === 'daily' ? 'daily' : 'manual',
          dailyTime: timeOk ? time : '20:30',
          circleId: String(p.circleId ?? '').trim(),
          anonymous: p.anonymous !== false,
          withImage: p.withImage !== false
        };
        atomicWrite(path.join(SETTINGS, 'post.json'), `${JSON.stringify(postCfg, null, 2)}\n`);
        return json(res, 200, { ok: true, post: postCfg });
      }

      if (req.method === 'GET' && url.pathname === '/api/sent') {
        const cfg = loadConfig(ROOT);
        const state = loadState(stateFile(ROOT));
        const page = Number(url.searchParams.get('page') ?? 1);
        const size = num(url.searchParams.get('size') ?? 5, 1, 20, 5);
        return json(res, 200, { ok: true, ...sentView(state, { page, size, webBase: cfg.huyou?.webBase }) });
      }

      if (req.method === 'POST' && url.pathname === '/api/cleanup') {
        const body = await readBody(req);
        const hours = num(body.hours, 1, 720, 48);
        const r = cleanupContext({ root: ROOT, hours, dryRun: body.dryRun === true });
        return json(res, 200, r);
      }

      if (req.method === 'POST' && url.pathname === '/api/post/draft') {
        const { draft } = await makeDraft();
        return json(res, 200, { ok: true, draft: { ...draft, image: draft.image ? path.basename(draft.image) : null } });
      }

      if (req.method === 'POST' && url.pathname === '/api/post/publish') {
        const r = await publishNow();
        return json(res, 200, {
          ok: r.status === 100000,
          status: r.status,
          desc: r.desc,
          feedId: r.feedId,
          draft: { ...r.draft, image: r.draft.image ? path.basename(r.draft.image) : null }
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/save') {
        const body = await readBody(req);
        const q = body.quota ?? {};
        const quota = {
          mode: ['off', 'dry-run', 'auto'].includes(q.mode) ? q.mode : 'off',
          dryRun: q.dryRun !== false,
          maxPerDay: num(q.maxPerDay, 1, 20, 10),
          maxPerHour: num(q.maxPerHour, 1, 10, 3),
          minGapMs: num(q.minGapMs, 30000, 600000, 90000),
          minChars: num(q.minChars, 2, 50, 6),
          maxChars: num(q.maxChars, 10, 140, 60),
          pollIntervalMs: num(q.pollIntervalMs, 60000, 21600000, 600000),
          threadsScanIntervalMs: num(q.threadsScanIntervalMs, 60000, 21600000, 600000),
          threadMaxRounds: num(q.threadMaxRounds, 1, 10, 2),
          threadWindowHours: num(q.threadWindowHours, 1, 168, 24),
          threadMaxPerDay: num(q.threadMaxPerDay, 0, 50, 5),
          threadMaxPerHour: num(q.threadMaxPerHour, 0, 20, 2),
          replyThreads: q.replyThreads !== false,
          allowCircles: String(q.circles ?? '')
            .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s)),
          circleIds: String(q.circles ?? '')
            .split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
        };
        if (quota.minChars > quota.maxChars) throw new Error('最少字数不能大于最多字数');
        snapshot();
        atomicWrite(path.join(SETTINGS, 'quota.json'), `${JSON.stringify(quota, null, 2)}\n`);
        if (typeof body.persona === 'string') atomicWrite(path.join(SETTINGS, 'persona.md'), body.persona);
        if (typeof body.policy === 'string') atomicWrite(path.join(SETTINGS, 'policy.md'), body.policy);

        if (body.post && typeof body.post === 'object') {
          const p = body.post;
          const time = String(p.dailyTime ?? '').trim();
          const timeOk = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
          if (p.mode === 'daily' && !timeOk) throw new Error('定时时间格式必须是 HH:MM（例如 20:30）');
          const postCfg = {
            enabled: p.enabled === true,
            mode: p.mode === 'daily' ? 'daily' : 'manual',
            dailyTime: timeOk ? time : '20:30',
            circleId: String(p.circleId ?? '').trim(),
            anonymous: p.anonymous !== false,
            withImage: p.withImage !== false
          };
          atomicWrite(path.join(SETTINGS, 'post.json'), `${JSON.stringify(postCfg, null, 2)}\n`);
        }

        if (body.cleanup && typeof body.cleanup === 'object') {
          const c = body.cleanup;
          const time = String(c.dailyTime ?? '').trim();
          const timeOk = /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
          if (c.enabled === true && !timeOk) throw new Error('自动清理的时间格式必须是 HH:MM');
          const cfgClean = {
            enabled: c.enabled === true,
            hours: num(c.hours, 1, 720, 48),
            dailyTime: timeOk ? time : '03:30'
          };
          atomicWrite(path.join(SETTINGS, 'cleanup.json'), `${JSON.stringify(cfgClean, null, 2)}\n`);
        }

        return json(res, 200, { ok: true, quota });
      }

      if (req.method === 'POST' && url.pathname === '/api/try') {
        const r = await tryOne();
        return json(res, 200, r);
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        atomicWrite(path.join(ROOT, 'state', 'STOP'), `stopped ${new Date().toISOString()}\n`);
        return json(res, 200, { ok: true, stopOn: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/resume') {
        try { fs.rmSync(path.join(ROOT, 'state', 'STOP'), { force: true }); } catch { /* ignore */ }
        return json(res, 200, { ok: true, stopOn: false });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log(`[console] 设置页：${url}`);
  console.log('[console] 只监听本机；token 每次启动都会变。关掉这个窗口页面就打不开了。');

  // 自动打开默认浏览器（加 --no-open 可关闭）
  if (!process.argv.includes('--no-open') && process.platform === 'win32') {
    try {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } catch { /* 打不开就让用户手动复制 */ }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[console] 端口 ${PORT} 被占用：可能已经有一个设置页在运行。`);
    console.error('[console] 关掉旧的窗口，或改 config.json 的 server.port。');
  } else {
    console.error('[console] 启动失败:', e.message);
  }
  process.exit(1);
});
