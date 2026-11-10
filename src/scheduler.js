#!/usr/bin/env node
// scheduler.js — 主循环：拉流 → 去重 → 请模型决策 → 闸门 → 发送（默认 dry-run）
//
// 用法：
//   node src/scheduler.js --once                  # 跑一轮，dry-run（不发）
//   node src/scheduler.js --once --send           # 跑一轮，真发（最多 1 条）
//   node src/scheduler.js --loop                  # 每 pollIntervalMs 跑一轮
//   node src/scheduler.js --once --fake           # 不联网的假模型，测管道
//
// 安全：STOP 文件存在即停；每日/每小时/间隔由 state.js 管；模型只能产出文本。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadQuota, loadPostSettings, loadCleanupSettings, killSwitchOn } from './config.js';
import { fetchRecommendFeeds, fetchComments, fetchCircleFeeds, filterByCircles } from './feed.js';
import { loadPersona, decide } from './decide.js';
import { createLLM } from './llm.js';
import { loadSession } from './api.js';
import { loadState, saveState, stateFile, alreadyCommented, recordUsage, shouldSkipDecision, recordDecision, postedToday, recordPost } from './state.js';
import { submitComment } from './comment.js';
import { composePost, loadStyle, publishDraft } from './post.js';
import { cleanupContext } from './cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 定时发帖：当前时间是否落在当天 HH:MM 之后的 90 分钟窗口内。 */
function dueDaily(hhmm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return false;
  const d = new Date(now);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(m[1]), Number(m[2]), 0, 0).getTime();
  return now >= at && now - at < 90 * 60000;
}

/**
 * 跑一轮。
 * @returns {Promise<{entries:Array, sent:number, skipped:number}>}
 */
export async function runOnce({ root = ROOT, cfg, quota, state, session, llm, dryRun, now = Date.now(), limit = 20 } = {}) {
  const conf = cfg ?? loadConfig(root);
  const q = quota ?? loadQuota(root);
  const st = state ?? loadState(stateFile(root));
  const entries = [];
  let sent = 0;
  let skipped = 0;

  if (killSwitchOn(conf, root)) {
    return { entries: [{ step: 'stop', reason: 'STOP 文件存在，停止' }], sent: 0, skipped: 0 };
  }

  // 模式只控制"评论"；发帖、楼中楼、自动清理是独立功能，off 时也要跑
  const mode = q.mode ?? 'off';
  const commentsOn = mode !== 'off';
  if (!commentsOn) entries.push({ step: 'mode', reason: 'mode=off：本轮只跳过评论' });
  const effectiveDryRun = dryRun !== undefined ? dryRun : (mode !== 'auto' || q.dryRun === true);

  const recFeeds = await fetchRecommendFeeds({ limit, cfg: conf });
  const all = [...recFeeds];

  // 配置了圈子 id 时，额外拉这些圈子的信息流（不是成员/没新帖时返回空，属正常）
  const circleIds = (q.circleIds ?? []).map(String);
  for (const cid of circleIds) {
    try {
      const cf = await fetchCircleFeeds(cid, { count: limit, cfg: conf });
      if (cf.length) all.push(...cf);
      else entries.push({ step: 'circle-empty', circleId: cid, note: '圈子流返回 0 条（未加入或无新帖）' });
    } catch (e) {
      entries.push({ step: 'circle-error', circleId: cid, error: e.message });
    }
  }

  const byId = new Map(all.map((f) => [f.feedId, f]));
  const feeds = filterByCircles([...byId.values()], q);
  entries.push({ step: 'source', recommend: recFeeds.length, circles: circleIds.length, afterFilter: feeds.length });

  const ttlMs = Number(conf.huyou?.decideTtlHours ?? 6) * 3600000;
  let cached = 0;
  const fresh = feeds.filter((f) => {
    if (alreadyCommented(st, f.feedId)) return false;
    // 同一帖在 TTL 内只判定一次：轮询再快也不会重复烧 token
    if (shouldSkipDecision(st, f.feedId, { ttlMs, now })) {
      cached += 1;
      return false;
    }
    const maxAgeMs = Number(conf.huyou?.maxAgeHours ?? 72) * 3600000;
    if (maxAgeMs > 0 && f.at && now - f.at > maxAgeMs) return false;
    return true;
  });

  const candidates = fresh.slice(0, Number(conf.huyou?.maxCandidatesPerRound ?? 5));
  entries.push({ step: 'poll', total: feeds.length, fresh: fresh.length, cached, candidates: candidates.length });

  const { persona, policy } = loadPersona(root);
  const model = llm ?? createLLM(conf, { onUsage: (u) => recordUsage(st, u) });
  const maxPerRound = Number(conf.comment?.maxPerRound ?? 1);

  for (const feed of (commentsOn ? candidates : [])) {
    if (sent >= maxPerRound) break;

    let comments = [];
    try {
      comments = await fetchComments(feed.feedId, { count: 10, session });
    } catch (e) {
      entries.push({ step: 'comments-error', feedId: feed.feedId, error: e.message });
    }

    let decision;
    try {
      decision = await decide({ llm: model, persona, policy, feed, comments, quota: q });
    } catch (e) {
      entries.push({ step: 'decide-error', feedId: feed.feedId, error: e.message });
      skipped += 1;
      continue;
    }

    entries.push({
      step: 'decide', feedId: feed.feedId, action: decision.action,
      reason: decision.reason, confidence: decision.confidence, text: decision.text
    });
    recordDecision(st, feed.feedId, decision.action, now);

    if (decision.action !== 'comment') { skipped += 1; continue; }

    const result = await submitComment({
      feedId: feed.feedId, text: decision.text, feed,
      session, state: st, cfg: conf, quota: q, dryRun: effectiveDryRun
    });

    entries.push({ step: 'send', feedId: feed.feedId, ok: result.ok, dryRun: Boolean(result.dryRun), reason: result.reason, commentId: result.commentId });
    if (result.ok) sent += 1;
    else skipped += 1;

    // 真发成功之后立刻落盘，避免崩溃丢计数
    saveState(stateFile(root), st);
  }

  // 定时发帖：只在该时间点之后的 90 分钟内触发一次，且当天没发过
  try {
    const post = loadPostSettings(root);
    if (post.enabled && post.mode === 'daily' && post.circleId && !postedToday(st, now) && dueDaily(post.dailyTime, now)) {
      const draft = await composePost({
        llm: model, persona, style: loadStyle(root), feeds,
        stickerDir: path.join(root, '表情包')
      });
      if (effectiveDryRun) {
        entries.push({ step: 'post-dry', text: draft.text });
      } else {
        const r = await publishDraft({ draft, session, circleId: post.circleId, anonymous: post.anonymous });
        if (r.status === 100000) {
          recordPost(st, { feedId: r.feedId, text: draft.text });
          entries.push({ step: 'post-sent', feedId: r.feedId });
        } else {
          entries.push({ step: 'post-fail', status: r.status, desc: r.desc });
        }
      }
    }
  } catch (e) {
    entries.push({ step: 'post-error', error: e.message });
  }

  // 自动清理：每天固定时间清一次 N 小时前的本地上下文
  try {
    const cl = loadCleanupSettings(root);
    const sameDay = st.lastCleanupAt
      && new Date(st.lastCleanupAt).toDateString() === new Date(now).toDateString();
    if (cl.enabled && !sameDay && dueDaily(cl.dailyTime, now)) {
      const r = cleanupContext({ root, hours: cl.hours, now, dryRun: effectiveDryRun, state: st });
      if (!effectiveDryRun) st.lastCleanupAt = now;
      entries.push({ step: 'cleanup', removed: r.removed, keepHours: r.keepHours });
    }
  } catch (e) {
    entries.push({ step: 'cleanup-error', error: e.message });
  }

  saveState(stateFile(root), st);
  return { entries, sent, skipped };
}
async function main() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once') || !argv.includes('--loop');
  const forceSend = argv.includes('--send');
  const forceDry = argv.includes('--dry-run');
  const fake = argv.includes('--fake');
  const limitArg = argv.indexOf('--limit');

  const cfg = loadConfig(ROOT);
  if (fake) cfg.llm = { ...(cfg.llm ?? {}), provider: 'fake' };
  const limit = limitArg > -1 ? Number(argv[limitArg + 1]) : 20;

  // 不传 --send / --dry-run 时，完全交给 settings/quota.json（每轮重新读，改完即生效）
  const dryRun = forceSend ? false : forceDry ? true : undefined;

  const describe = (q) => {
    const willSend = dryRun === false || (dryRun === undefined && q.mode === 'auto' && q.dryRun !== true);
    return `mode=${q.mode}  ${willSend ? '会真发' : 'dry-run（不发）'}  模型=${fake ? 'fake' : (cfg.llm?.provider ?? 'deepseek')}`;
  };
  console.log(`[scheduler] ${describe(loadQuota(ROOT))}`);

  const run = async () => {
    const q = loadQuota(ROOT);
    const state = loadState(stateFile(ROOT));
    const session = loadSession(ROOT);
    const r = await runOnce({ cfg, quota: q, state, session, dryRun, limit });
    for (const e of r.entries) {
      const { step, ...rest } = e;
      console.log(`  ${step.padEnd(14)} ${JSON.stringify(rest)}`);
    }
    console.log(`[scheduler] 本轮：发送 ${r.sent} 条，跳过 ${r.skipped} 条`);
    return r;
  };

  // 楼中楼单独一个定时器：只读扫描很便宜，可以比评论更频繁
  const scanThreads = async () => {
    const q = loadQuota(ROOT);
    if ((q.mode ?? 'off') === 'off' || q.replyThreads === false) return null;
    const st = loadState(stateFile(ROOT));
    const session = loadSession(ROOT);
    const { persona, policy } = loadPersona(ROOT);
    const llm = createLLM(cfg, { onUsage: (u) => recordUsage(st, u) });
    const effDry = dryRun !== undefined ? dryRun : (q.mode !== 'auto' || q.dryRun === true);
    const { pollThreads } = await import('./threads.js');
    const r = await pollThreads({
      state: st, session, llm, persona, policy, cfg, quota: q,
      dryRun: effDry, myUserId: session.cookies.hyuid
    });
    saveState(stateFile(ROOT), st);
    for (const e of r.entries) {
      const { step, ...rest } = e;
      console.log(`  ${step.padEnd(14)} ${JSON.stringify(rest)}`);
    }
    if (r.replied) console.log(`[scheduler] 楼中楼：本轮回复 ${r.replied} 条`);
    return r;
  };

  if (once) {
    await run();
    await scanThreads();
    return;
  }

  // 两个定时器：主循环（评论 + 定时发帖）与楼中楼扫描
  let nextMain = Date.now();
  let nextThreads = Date.now();
  for (;;) {
    if (killSwitchOn(cfg, ROOT)) {
      console.log('[scheduler] 检测到 STOP 文件，退出');
      return;
    }
    const now = Date.now();
    const mainMs = Math.max(60000, Number(loadQuota(ROOT).pollIntervalMs ?? 600000));
    const threadMs = Math.max(60000, Number(loadQuota(ROOT).threadsScanIntervalMs ?? 600000));

    if (now >= nextThreads) {
      try { await scanThreads(); } catch (e) { console.error('[scheduler] 楼中楼扫描失败:', e.message); }
      nextThreads = Date.now() + threadMs;
    }
    if (now >= nextMain) {
      try { await run(); } catch (e) { console.error('[scheduler] 本轮失败:', e.message); }
      nextMain = Date.now() + mainMs;
      console.log(`[scheduler] 评论/发帖：每 ${Math.round(mainMs / 60000)} 分钟；楼中楼：每 ${Math.round(threadMs / 60000)} 分钟`);
    }

    const wait = Math.min(30000, Math.max(1000, Math.min(nextThreads, nextMain) - Date.now()));
    await sleep(wait);
  }
}

if (process.argv[1] && process.argv[1].endsWith('scheduler.js')) {
  main().catch((e) => {
    console.error('[scheduler] 失败:', e?.message ?? e);
    process.exit(1);
  });
}
