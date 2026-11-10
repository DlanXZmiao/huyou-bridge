// feed.js — 信息流读取
//
// 推荐流没有可用的公开 JSON 接口，但 w.sohu.com 是 Nuxt SSR：
// 首屏 20 条数据直接内嵌在 <script id="__NUXT_DATA__"> 里，匿名可读。
// 这里解析那份 devalue 扁平表（下标引用）还原成对象。

import { loadConfig } from './config.js';
import { getCommentList, getFeed } from './api.js';

/** devalue 序列化：数组下标引用 + 标记数组（["ShallowReactive",1] 等）。 */
export function parseNuxtPayload(flat) {
  const seen = new Map();
  const resolve = (v) => {
    if (typeof v !== 'number') return v;
    if (seen.has(v)) return seen.get(v);
    const node = flat[v];
    if (node === undefined) return undefined;
    if (Array.isArray(node)) {
      const tag = node[0];
      if (typeof tag === 'string') {
        if (tag === 'EmptyRef' || tag === 'Set') return null;
        if (tag === 'Reactive' || tag === 'ShallowReactive' || tag === 'Ref' || tag === 'ShallowRef') {
          return resolve(node[1]);
        }
        if (tag === 'Date') return { __date: node[1] };
        return resolve(node[1]);
      }
      const arr = [];
      seen.set(v, arr);
      for (const item of node) arr.push(resolve(item));
      return arr;
    }
    if (node && typeof node === 'object') {
      const obj = {};
      seen.set(v, obj);
      for (const [k, val] of Object.entries(node)) obj[k] = resolve(val);
      return obj;
    }
    return node;
  };
  return resolve(0);
}

/** 从解析后的树里收集所有"帖子"对象（有 feedId 且 content 是字符串）。 */
export function collectFeeds(node, out = new Map(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectFeeds(item, out, depth + 1);
    return out;
  }
  if (node.feedId != null && typeof node.content === 'string' && !node.commentId) {
    const id = String(node.feedId);
    if (!out.has(id)) out.set(id, node);
  }
  for (const v of Object.values(node)) collectFeeds(v, out, depth + 1);
  return out;
}

const firstImage = (raw) => {
  const pics = raw?.picFeed?.pics ?? raw?.imageList ?? raw?.pics ?? [];
  const one = Array.isArray(pics) ? pics[0] : null;
  return one ? { small: one.tp ?? one.smallUrl ?? null, big: one.bp ?? one.bigUrl ?? null, w: one.tw, h: one.th } : null;
};

/** 统一成内部结构，别把 SSR 的原始字段泄漏到上层。 */
export function normalizeFeed(raw) {
  // SSR 里 `at` 是 @ 提及数组（[]），真正的时间戳在 `score`（毫秒）。
  const ts = typeof raw.at === 'number' ? raw.at : (typeof raw.score === 'number' ? raw.score : 0);
  return {
    feedId: String(raw.feedId),
    content: String(raw.content ?? '').trim(),
    userName: raw.userName ?? '',
    userId: raw.userId != null ? String(raw.userId) : '',
    anonymous: raw.anonymous === true,
    circle: raw.circle?.circleName ?? '',
    circleId: raw.circle?.circleId != null ? String(raw.circle.circleId) : '',
    commentCount: Number(raw.commentCount ?? 0),
    exposureCount: Number(raw.exposureCount ?? 0),
    // 只有像毫秒时间戳的数值才当时间用（> 2000-01-01）
    at: ts > 946684800000 ? ts : 0,
    image: firstImage(raw),
    hotComment: raw.hotComment?.content ?? ''
  };
}

/**
 * 拉推荐流。
 * @param {{limit?:number, cfg?:object}} opts
 * @returns {Promise<Array<ReturnType<typeof normalizeFeed>>>}
 */
export async function fetchRecommendFeeds({ limit = 20, cfg = null } = {}) {
  const conf = cfg ?? loadConfig();
  const res = await fetch(`${conf.huyou.webBase}/`, {
    // 注意：不要带 accept: text/html —— 移动端 UA 配合这个头会被切到“打开小程序”的
    // 引导页（4 KB，没有数据）。桌面 UA + 不带 accept 最稳（200 KB，含 __NUXT_DATA__）。
    headers: { 'user-agent': conf.huyou.userAgent },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`首页 HTTP ${res.status}`);
  const html = await res.text();
  const m = /<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('首页没有 __NUXT_DATA__，页面结构可能变了');
  const tree = parseNuxtPayload(JSON.parse(m[1]));
  const feeds = [...collectFeeds(tree).values()].map(normalizeFeed);
  return feeds.filter((f) => f.feedId && f.content).slice(0, limit);
}

export async function fetchFeedDetail(feedId, { session } = {}) {
  const r = await getFeed(feedId, { session });
  if (r.status !== 100000) throw new Error(`读取帖子失败: ${r.status} ${r.desc ?? ''}`);
  return r.data?.feed ?? r.data;
}

export async function fetchComments(feedId, { count = 20, session } = {}) {
  const r = await getCommentList(feedId, { count, session });
  if (r.status !== 100000) throw new Error(`读取评论失败: ${r.status} ${r.desc ?? ''}`);
  return r.data?.list ?? [];
}

/**
 * 拉某个圈子的信息流。
 *
 * 走的不是 API 而是**圈子页的 SSR**：`https://w.sohu.com/circle/<circleId>`。
 * 原因：`/v8/circle/feed/list` 实测对多个圈子都返回 0 条（多半要求是成员），
 * 而圈子页对匿名访问也直接内嵌完整帖子列表（实测汕大树洞一次拿到 24 条）。
 */
export async function fetchCircleFeeds(circleId, { count = 20, cfg = null } = {}) {
  const conf = cfg ?? loadConfig();
  const id = String(circleId);
  const res = await fetch(`${conf.huyou.webBase}/circle/${id}`, {
    headers: { 'user-agent': conf.huyou.userAgent },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`圈子页 HTTP ${res.status}`);
  const html = await res.text();
  const m = /<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('圈子页没有 __NUXT_DATA__，页面结构可能变了');
  const tree = parseNuxtPayload(JSON.parse(m[1]));
  const feeds = [...collectFeeds(tree).values()]
    .map(normalizeFeed)
    .filter((f) => f.feedId && f.content && f.circleId === id);
  const uniq = new Map(feeds.map((f) => [f.feedId, f]));
  return [...uniq.values()].slice(0, count);
}

/**
 * 按 settings/quota.json 里的圈子配置筛选。
 * - allowCircles 里放圈子名（子串匹配）
 * - circleIds 里放圈子 id
 * 两者都为空 = 不过滤。
 */
export function filterByCircles(feeds, quota = {}) {
  const names = (quota.allowCircles ?? []).filter(Boolean);
  const ids = (quota.circleIds ?? []).map(String);
  if (!names.length && !ids.length) return feeds;
  return feeds.filter((f) => {
    if (ids.includes(String(f.circleId ?? ''))) return true;
    return names.some((n) => String(f.circle ?? '').includes(n));
  });
}
