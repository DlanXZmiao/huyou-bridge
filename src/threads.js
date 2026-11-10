// threads.js — 楼中楼：别人回复了我的评论，我要不要接一句。
//
// 数据依据（实测）：
//   回复对象里带 replyCommentId（回到哪条）与 replyUserId（回给谁）。
//   所以「回我的」判据是：replyUserId === 我的 uid，且 replyCommentId === 我的评论 id。
//
// 扫描策略（重要）：
//   网页版没有通知中心（/message 等路由 404，bundle 里也没有 notice 接口），
//   所以只能轮询。但**不要**对每条评论都调 replylist：
//   先用一次 comment/list 拿到我方评论的 replyCount，只有数字变了才去拉 replylist。
//   这样一轮的请求数 ≈ 涉及的帖子数，而不是评论条数。

import { getCommentList, getReplyList, postComment } from './api.js';
import { decideReply } from './decide.js';
import { checkGate } from './gates.js';
import { canReplyNow, recordReply } from './state.js';

const DAY = 86400000;

/** 最近 N 天内、我方发的最后 limit 条评论。 */
function recentSent(state, now, { days = 3, limit = 10 } = {}) {
  return (state.sent ?? [])
    .filter((s) => s.commentId && now - Number(s.at ?? 0) <= days * DAY)
    .slice(-limit);
}

function groupByFeed(list) {
  const map = new Map();
  for (const s of list) {
    const k = String(s.feedId);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return map;
}

/**
 * 扫一遍我方评论下的新回复（增量：先比 replyCount，再拉明细）。
 *
 * @returns {Promise<{entries:Array, replied:number}>}
 */
export async function pollThreads({
  state, session, llm, persona, policy, cfg, quota, dryRun = true, myUserId, now = Date.now()
} = {}) {
  const entries = [];
  let replied = 0;
  const me = String(myUserId ?? '');
  if (!me) return { entries: [{ step: 'threads', reason: '拿不到自己的 uid' }], replied: 0 };

  state.threads ??= {};
  const maxScan = Number(cfg.comment?.maxThreadScan ?? 10);
  const mine = recentSent(state, now, { limit: maxScan });
  if (!mine.length) return { entries: [{ step: 'threads', reason: '近 3 天没有我方评论' }], replied: 0 };

  const minGap = Number(cfg.comment?.minGapMs ?? 90000);
  const maxRounds = Number(quota.threadMaxRounds ?? 2);
  const replyWindowMs = Number(quota.threadWindowHours ?? 24) * 3600000;
  const replyMaxPerDay = Number(quota.threadMaxPerDay ?? 5);
  const replyMaxPerHour = Number(quota.threadMaxPerHour ?? 2);
  const byFeed = groupByFeed(mine);

  for (const [feedId, sentList] of byFeed) {
    // 一个帖子只拉一次评论列表
    let comments = [];
    try {
      const r = await getCommentList(feedId, { count: 60, session });
      if (r.status === 100000) comments = r.data?.list ?? [];
      else entries.push({ step: 'thread-list-error', feedId, status: r.status, desc: r.desc });
    } catch (e) {
      entries.push({ step: 'thread-list-error', feedId, error: e.message });
    }
    if (!comments.length) continue;

    const byId = new Map(comments.map((c) => [String(c.commentId), c]));

    for (const sent of sentList) {
      const key = String(sent.commentId);
      const th = state.threads[key] ??= {
        feedId: String(feedId),
        myCommentId: key,
        createdAt: Number(sent.at ?? now),
        handled: {},
        myRounds: 0,
        maxRounds,
        stopped: false,
        lastReplyCount: null
      };
      if (th.stopped) continue;
      if (th.myRounds >= th.maxRounds) { th.stopped = true; continue; }
      if (now - Number(th.createdAt) > 3 * DAY) { th.stopped = true; continue; }

      const node = byId.get(key);
      if (!node) {
        // 评论可能被删了/翻页了：连续 3 次找不到才停
        th.missing = Number(th.missing ?? 0) + 1;
        if (th.missing >= 3) th.stopped = true;
        continue;
      }
      th.missing = 0;

      const replyCount = Number(node.replyCount ?? 0);
      // 已经看过这么多条回复 → 没有新的，直接跳过（不拉 replylist）
      if (th.lastReplyCount !== null && replyCount === th.lastReplyCount) continue;

      let r;
      try {
        r = await getReplyList(feedId, key, { count: 30, session });
      } catch (e) {
        entries.push({ step: 'thread-error', feedId, commentId: key, error: e.message });
        continue;
      }
      if (r.status !== 100000) {
        entries.push({ step: 'thread-error', feedId, commentId: key, status: r.status, desc: r.desc });
        continue;
      }
      th.lastReplyCount = replyCount;

      for (const rep of r.data?.list ?? []) {
        const rid = String(rep.commentId ?? '');
        if (!rid) continue;
        if (th.handled[rid]) continue;

        // 不是回我的 / 自己回自己 / 太旧 —— 记下不再处理
        if (String(rep.userId) === me) { th.handled[rid] = 'self'; continue; }
        if (String(rep.replyUserId) !== me) { th.handled[rid] = 'not-me'; continue; }
        if (now - Number(rep.timeId ?? 0) > replyWindowMs) { th.handled[rid] = 'stale'; continue; }

        let decision;
        try {
          decision = await decideReply({
            llm, persona, policy,
            feedContent: sent.feedContent ?? '',
            myComment: sent.text,
            theirReply: String(rep.content ?? ''),
            quota
          });
        } catch (e) {
          entries.push({ step: 'reply-decide-error', commentId: rid, error: e.message });
          continue;
        }

        entries.push({
          step: 'reply-decide', commentId: rid, from: rep.userName,
          action: decision.action, confidence: decision.confidence,
          text: decision.text, reason: decision.reason
        });

        if (decision.action !== 'comment') { th.handled[rid] = 'skip'; continue; }

        const gate = checkGate({
          feed: { content: String(rep.content ?? '') },
          text: decision.text,
          cfg: cfg.gates,
          quota,
          history: (state.sent ?? []).map((s) => s.text)
        });
        if (!gate.ok) {
          th.handled[rid] = 'gate';
          entries.push({ step: 'reply-gate', commentId: rid, reasons: gate.reasons });
          continue;
        }

        if (now - Number(state.lastSentAt ?? 0) < minGap) {
          entries.push({ step: 'reply-wait', commentId: rid, reason: '距上一条太近' });
          continue;
        }

        if (dryRun) {
          th.handled[rid] = 'dry';
          entries.push({ step: 'reply-dry', commentId: rid, text: decision.text });
          continue;
        }

        const quotaCheck = canReplyNow(state, { maxPerDay: replyMaxPerDay, maxPerHour: replyMaxPerHour, now });
        if (!quotaCheck.ok) {
          entries.push({ step: 'reply-quota', commentId: rid, reason: quotaCheck.reason });
          break;
        }

        const res = await postComment(feedId, decision.text, { session, replyToCommentId: rid });
        if (res.status === 100000) {
          const newId = String(res.data?.commentId ?? '');
          th.handled[rid] = newId || 'sent';
          th.myRounds += 1;
          state.lastSentAt = Date.now();
          recordReply(state);
          replied += 1;
          entries.push({ step: 'reply-sent', commentId: rid, newCommentId: newId, text: decision.text });
        } else {
          entries.push({ step: 'reply-fail', commentId: rid, status: res.status, desc: res.desc });
          // 411000 = 访问过于频繁，本轮立刻停，避免越撞越狠
          if (res.status === 411000) return { entries, replied };
        }
      }
    }
  }

  return { entries, replied };
}
