// gates.js — 发送前的硬闸门（纯函数，不读文件、不发请求）
//
// 这些规则**不依赖模型判断**：命中就拒绝，policy.md 写得再宽也绕不过去。

/** 常用中文停用词/语气词，避免把"的了吗"这种当成复述。 */
const MIN_OVERLAP = 5;

/** 取两个字符串的最长公共子串长度（只用于短文本，O(n*m) 可接受）。 */
export function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const s1 = String(a);
  const s2 = String(b);
  let best = 0;
  let prev = new Array(s2.length + 1).fill(0);
  for (let i = 1; i <= s1.length; i++) {
    const cur = new Array(s2.length + 1).fill(0);
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 字符二元组 Jaccard 相似度，用来防止反复说同一句话。 */
export function similarity(a, b) {
  const grams = (s) => {
    const t = String(s ?? '').replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    if (!set.size && t) set.add(t);
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 检查一条候选评论是否允许发送。
 *
 * @param {object} p
 * @param {object} p.feed        帖子（至少含 content）
 * @param {string} p.text        拟发送的评论
 * @param {object} p.cfg         config（gates 段）
 * @param {object} p.quota       settings/quota.json（长度上下限）
 * @param {string[]} [p.history] 最近发过的评论文本
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function checkGate({ feed, text, cfg, quota, history = [] }) {
  const reasons = [];
  const content = String(feed?.content ?? '');
  const body = String(text ?? '').trim();

  if (!body) reasons.push('空评论');

  const minChars = Number(quota?.minChars ?? 6);
  const maxChars = Number(quota?.maxChars ?? 60);
  if (body.length < minChars) reasons.push(`太短（${body.length} < ${minChars}）`);
  if (body.length > maxChars) reasons.push(`太长（${body.length} > ${maxChars}）`);

  // 硬话题：命中就直接拒绝，不产生候选
  for (const word of cfg?.hardBlockTopics ?? []) {
    if (!word) continue;
    if (content.includes(word)) reasons.push(`帖子命中敏感话题「${word}」`);
    if (body.includes(word)) reasons.push(`评论命中敏感话题「${word}」`);
  }

  // 模板话术
  for (const phrase of cfg?.bannedPhrases ?? []) {
    if (phrase && body.includes(phrase)) reasons.push(`命中模板话术「${phrase}」`);
  }

  // 复述：与原文有长公共子串，说明在重复对方的话
  const overlap = longestCommonSubstring(body, content);
  const maxOverlap = Number(cfg?.maxOverlapWithFeed ?? MIN_OVERLAP);
  if (overlap >= maxOverlap) reasons.push(`复述原文（公共子串 ${overlap} 字）`);

  // 链接 / @ / 联系方式
  if (cfg?.noLinks !== false && /https?:\/\/|www\.|\.com|\.cn/i.test(body)) reasons.push('含链接');
  if (cfg?.noAt !== false && /@\S+/.test(body)) reasons.push('含 @');
  if (/\d{5,}/.test(body)) reasons.push('含疑似联系方式/长数字');

  // 与历史评论太像
  const threshold = Number(cfg?.similarityThreshold ?? 0.8);
  for (const old of history) {
    const sim = similarity(body, old);
    if (sim >= threshold) {
      reasons.push(`与历史评论过于相似（${sim.toFixed(2)}）`);
      break;
    }
  }

  return { ok: reasons.length === 0, reasons };
}
