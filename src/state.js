// state.js — 运行时状态（已发记录、配额计数、失败计数），原子写。

import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  sent: [],          // [{ feedId, commentId, text, at }]
  decisions: {},     // feedId -> { at, action }：同一帖在 TTL 内不重复判定
  threads: {},       // 我方评论 commentId -> 楼中楼状态
  posts: [],         // 我自己发的动态 [{ feedId, text, at }]
  quota: { day: '', dayCount: 0, hour: '', hourCount: 0 },
  lastSentAt: 0,
  failures: 0,
  blockedUntil: 0,
  usage: { day: '', promptTokens: 0, completionTokens: 0, calls: 0 }
});

export function stateFile(root) {
  return path.join(root, 'state', 'activity.json');
}

export function loadState(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const doc = JSON.parse(text);
    return { ...EMPTY(), ...doc, quota: { ...EMPTY().quota, ...(doc.quota ?? {}) } };
  } catch {
    return EMPTY();
  }
}

/** 先写临时文件再 rename：中途崩溃不会留下半个 JSON。 */
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hourKey = (d) => `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}`;

function rollQuota(state, now) {
  const d = new Date(now);
  const dk = dayKey(d);
  const hk = hourKey(d);
  if (state.quota.day !== dk) {
    state.quota.day = dk;
    state.quota.dayCount = 0;
  }
  if (state.quota.hour !== hk) {
    state.quota.hour = hk;
    state.quota.hourCount = 0;
  }
}

/**
 * 现在能不能发。返回 { ok, reason?, waitMs? }
 * 三道限制：每日、每小时、最小间隔；外加熔断。
 */
export function canSendNow(state, { quota, minGapMs = 90000, now = Date.now() } = {}) {
  if (state.blockedUntil && now < state.blockedUntil) {
    return { ok: false, reason: `熔断中，${Math.ceil((state.blockedUntil - now) / 1000)}s 后解除` };
  }
  rollQuota(state, now);
  const maxDay = Number(quota?.maxPerDay ?? 10);
  const maxHour = Number(quota?.maxPerHour ?? 3);
  if (state.quota.dayCount >= maxDay) return { ok: false, reason: `今日已达上限 ${maxDay} 条` };
  if (state.quota.hourCount >= maxHour) return { ok: false, reason: `本小时已达上限 ${maxHour} 条` };
  const waitMs = (state.lastSentAt || 0) + minGapMs - now;
  if (waitMs > 0) return { ok: false, reason: `距上一条不足 ${Math.round(minGapMs / 1000)}s`, waitMs };
  return { ok: true };
}

export function alreadyCommented(state, feedId) {
  return state.sent.some((s) => String(s.feedId) === String(feedId));
}

export function recordSent(state, { feedId, commentId, text, feedContent }, now = Date.now()) {
  rollQuota(state, now);
  state.sent.push({
    feedId: String(feedId),
    commentId: commentId ?? null,
    text,
    at: now,
    feedContent: feedContent ? String(feedContent).slice(0, 300) : ''
  });
  if (state.sent.length > 500) state.sent = state.sent.slice(-500);
  state.quota.dayCount += 1;
  state.quota.hourCount += 1;
  state.lastSentAt = now;
  state.failures = 0;
  return state;
}

export function recordFailure(state, { threshold = 3, cooldownMs = 3600000, now = Date.now() } = {}) {
  state.failures = (state.failures ?? 0) + 1;
  if (state.failures >= threshold) {
    state.blockedUntil = now + cooldownMs;
    state.failures = 0;
  }
  return state;
}

/** 回复（楼中楼）的独立配额：不占评论的额度。 */
export function canReplyNow(state, { maxPerDay = 5, maxPerHour = 2, now = Date.now() } = {}) {
  state.replyQuota ??= { day: '', dayCount: 0, hour: '', hourCount: 0 };
  const dk = dayKey(new Date(now));
  const hk = hourKey(new Date(now));
  if (state.replyQuota.day !== dk) { state.replyQuota.day = dk; state.replyQuota.dayCount = 0; }
  if (state.replyQuota.hour !== hk) { state.replyQuota.hour = hk; state.replyQuota.hourCount = 0; }
  if (state.replyQuota.dayCount >= maxPerDay) return { ok: false, reason: `今日回复已达上限 ${maxPerDay} 条` };
  if (state.replyQuota.hourCount >= maxPerHour) return { ok: false, reason: `本小时回复已达上限 ${maxPerHour} 条` };
  return { ok: true };
}

export function recordReply(state, now = Date.now()) {
  state.replyQuota ??= { day: '', dayCount: 0, hour: '', hourCount: 0 };
  const dk = dayKey(new Date(now));
  const hk = hourKey(new Date(now));
  if (state.replyQuota.day !== dk) { state.replyQuota.day = dk; state.replyQuota.dayCount = 0; }
  if (state.replyQuota.hour !== hk) { state.replyQuota.hour = hk; state.replyQuota.hourCount = 0; }
  state.replyQuota.dayCount += 1;
  state.replyQuota.hourCount += 1;
  return state;
}

/** 记录一条自己发的动态。 */
export function recordPost(state, { feedId, text, at = Date.now() }) {
  state.posts ??= [];
  state.posts.push({ feedId: String(feedId ?? ''), text, at });
  if (state.posts.length > 200) state.posts = state.posts.slice(-200);
  return state;
}

/** 今天是否已经发过动态。 */
export function postedToday(state, now = Date.now()) {
  const day = dayKey(new Date(now));
  return (state.posts ?? []).some((p) => dayKey(new Date(p.at)) === day);
}

export function recentTexts(state, limit = 20) {
  return state.sent.slice(-limit).map((s) => s.text);
}

/**
 * 这条帖子最近是否已经判定过。
 *
 * 为什么需要：轮询每 N 分钟跑一轮，但推荐流几小时才变一次。
 * 没有这层缓存的话，同一批帖子会被反复送进模型 —— token 花得跟轮询频率成正比，
 * 而得到的信息量几乎为零。有了它，成本只跟"出现多少新帖"有关。
 */
export function shouldSkipDecision(state, feedId, { ttlMs = 6 * 3600000, now = Date.now() } = {}) {
  const rec = state.decisions?.[feedId];
  if (!rec) return false;
  return now - Number(rec.at ?? 0) < ttlMs;
}

export function recordDecision(state, feedId, action, now = Date.now()) {
  if (!state.decisions) state.decisions = {};
  state.decisions[feedId] = { at: now, action };
  const keys = Object.keys(state.decisions);
  if (keys.length > 800) {
    // 按时间排序丢掉最旧的一半，避免状态文件无限膨胀
    const sorted = keys.sort((a, b) => (state.decisions[a].at ?? 0) - (state.decisions[b].at ?? 0));
    for (const k of sorted.slice(0, Math.floor(sorted.length / 2))) delete state.decisions[k];
  }
  return state;
}

/** 记录一次模型调用的 token 用量（按天累计，跨天自动清零）。 */
export function recordUsage(state, usage, now = Date.now()) {
  if (!usage || typeof usage !== 'object') return state;
  if (!state.usage) state.usage = { day: '', promptTokens: 0, completionTokens: 0, calls: 0 };
  const day = dayKey(new Date(now));
  if (state.usage.day !== day) {
    state.usage = { day, promptTokens: 0, completionTokens: 0, calls: 0 };
  }
  state.usage.promptTokens += Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0;
  state.usage.completionTokens += Number(usage.completion_tokens ?? usage.completionTokens ?? 0) || 0;
  state.usage.calls += 1;
  return state;
}

/** 读用量时也做一次跨天清零，避免页面显示昨天的数。 */
export function usageView(state, now = Date.now()) {
  const day = dayKey(new Date(now));
  const u = state.usage ?? { day, promptTokens: 0, completionTokens: 0, calls: 0 };
  if (u.day !== day) return { day, promptTokens: 0, completionTokens: 0, calls: 0, totalTokens: 0 };
  const promptTokens = u.promptTokens || 0;
  const completionTokens = u.completionTokens || 0;
  return {
    day,
    promptTokens,
    completionTokens,
    calls: u.calls || 0,
    totalTokens: promptTokens + completionTokens
  };
}
