// cleanup.js — 清理运行时上下文（只删本地记录，不碰狐友服务器上的任何东西）。
//
// 清理范围：
//   sent       我方评论记录（同时是"防重复评论"和"历史相似度"的依据）
//   threads    楼中楼线程状态（我方评论 commentId -> 状态）
//   posts      我发过的动态记录
//   decisions  帖子判定缓存（feedId -> { at, action }）
//
// 保留最近 N 小时（默认 48）以内的所有记录。

import { loadState, saveState, stateFile } from './state.js';

function count(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).length : 0;
}

/**
 * @param {object} p
 * @param {string} p.root
 * @param {number} [p.hours=48]   保留多少小时以内的记录
 * @param {number} [p.now]
 * @param {boolean} [p.dryRun]    只统计不落盘
 * @param {object} [p.state]      传入已有的 state（调度器用，避免读两份互相覆盖）
 */
export function cleanupContext({ root, hours = 48, now = Date.now(), dryRun = false, state = null } = {}) {
  const keepHours = Math.min(24 * 30, Math.max(1, Number(hours) || 48));
  const cutoff = now - keepHours * 3600000;
  const file = stateFile(root);
  const source = state ?? loadState(file);
  // dry-run 时在副本上算，绝不改动传入的 state
  const target = dryRun ? structuredClone(source) : source;

  const before = {
    sent: (target.sent ?? []).length,
    threads: count(target.threads),
    posts: (target.posts ?? []).length,
    decisions: count(target.decisions)
  };

  target.sent = (target.sent ?? []).filter((s) => Number(s.at ?? 0) >= cutoff);
  target.posts = (target.posts ?? []).filter((p) => Number(p.at ?? 0) >= cutoff);

  const threads = {};
  for (const [k, th] of Object.entries(target.threads ?? {})) {
    if (Number(th?.createdAt ?? 0) >= cutoff) threads[k] = th;
  }
  target.threads = threads;

  const decisions = {};
  for (const [k, d] of Object.entries(target.decisions ?? {})) {
    if (Number(d?.at ?? 0) >= cutoff) decisions[k] = d;
  }
  target.decisions = decisions;

  const after = {
    sent: target.sent.length,
    threads: count(target.threads),
    posts: target.posts.length,
    decisions: count(target.decisions)
  };

  // 没传 state（命令行/设置页直接调用）才自己落盘；调度器会负责保存
  if (!dryRun && !state) saveState(file, target);

  return {
    ok: true,
    dryRun,
    keepHours,
    cutoff: new Date(cutoff).toISOString(),
    before,
    after,
    removed: {
      sent: before.sent - after.sent,
      threads: before.threads - after.threads,
      posts: before.posts - after.posts,
      decisions: before.decisions - after.decisions
    }
  };
}
