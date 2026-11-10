// comment.js — 发评论的完整管道：闸门 → 配额 → 提交 → 回读 → 记账
//
// 设计原则：模型只负责"写什么"，这里负责"能不能发、发没发成"。

import { postComment } from './api.js';
import { checkGate } from './gates.js';
import { canSendNow, alreadyCommented, recordSent, recordFailure, recentTexts } from './state.js';

/**
 * @param {object} p
 * @param {string} p.feedId
 * @param {string} p.text
 * @param {object} p.feed        帖子对象（喂给闸门判断）
 * @param {object} p.session     登录态（loadSession 的结果）
 * @param {object} p.state       运行时状态（会被就地更新）
 * @param {object} p.cfg         config
 * @param {object} p.quota       settings/quota.json
 * @param {boolean} [p.dryRun]   只走流程不真发
 * @returns {Promise<{ok:boolean, dryRun?:boolean, skipped?:boolean, reason?:string, reasons?:string[], commentId?:string, verified?:boolean, status?:number, desc?:string}>}
 */
export async function submitComment({ feedId, text, feed, session, state, cfg, quota, dryRun = false }) {
  if (alreadyCommented(state, feedId)) {
    return { ok: false, skipped: true, reason: '该帖已经评论过' };
  }

  const gate = checkGate({
    feed: feed ?? { content: '' },
    text,
    cfg: cfg.gates,
    quota,
    history: recentTexts(state, 20)
  });
  if (!gate.ok) {
    return { ok: false, skipped: true, reasons: gate.reasons, reason: gate.reasons.join('；') };
  }

  const can = canSendNow(state, { quota, minGapMs: cfg.comment?.minGapMs ?? 90000 });
  if (!can.ok) {
    return { ok: false, skipped: true, reason: can.reason };
  }

  if (dryRun) {
    return { ok: true, dryRun: true };
  }

  const r = await postComment(feedId, text, { session });
  if (r.status !== 100000) {
    recordFailure(state, { threshold: cfg.circuitBreaker?.consecutiveFailures ?? 3, cooldownMs: cfg.circuitBreaker?.cooldownMs ?? 3600000 });
    return { ok: false, status: r.status, desc: r.desc, reason: `提交失败: ${r.status} ${r.desc ?? ''}` };
  }

  const commentId = r.data?.commentId ? String(r.data.commentId) : undefined;
  const verified = await verifyPosted(session, feedId, { commentId, text });
  recordSent(state, { feedId, commentId, text, feedContent: feed?.content });
  return { ok: true, commentId, verified, status: r.status, desc: r.desc };
}

/** 回读评论列表确认真的落地了（不信接口的成功响应，信列表）。 */
async function verifyPosted(session, feedId, { commentId, text }) {
  try {
    const { getCommentList } = await import('./api.js');
    const r = await getCommentList(feedId, { count: 30, session });
    if (r.status !== 100000) return false;
    const list = r.data?.list ?? [];
    const found = list.some((c) => (commentId && String(c.commentId) === commentId) || c.content === text);
    return found;
  } catch {
    return false;
  }
}
