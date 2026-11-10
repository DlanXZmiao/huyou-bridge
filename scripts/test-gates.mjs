#!/usr/bin/env node
// test-gates.mjs — 闸门与相似度的离线单测（不发网络请求）。

import assert from 'node:assert/strict';
import { checkGate, similarity, longestCommonSubstring } from '../src/gates.js';

const cfg = {
  hardBlockTopics: ['自伤', '自杀', '抑郁', '贫困', '家暴', '性取向'],
  bannedPhrases: ['抱抱', '加油', '心疼你', '我懂你', '一切都会好'],
  noLinks: true,
  noAt: true,
  maxOverlapWithFeed: 8,
  similarityThreshold: 0.8
};
const quota = { minChars: 6, maxChars: 60 };

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('gates:');

t('正常评论通过', () => {
  const r = checkGate({
    feed: { content: '女生一般希望理想型长多高' },
    text: '这个问题得看当事人自己怎么想',
    cfg, quota
  });
  assert.equal(r.ok, true, r.reasons.join('；'));
});

t('帖子命中敏感话题被拒', () => {
  const r = checkGate({ feed: { content: '最近有点抑郁，不想说话' }, text: '多出去走走就好了', cfg, quota });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('抑郁')));
});

t('评论命中敏感话题被拒', () => {
  const r = checkGate({ feed: { content: '今天好累' }, text: '我之前也有点抑郁来着', cfg, quota });
  assert.equal(r.ok, false);
});

t('模板话术被拒', () => {
  const r = checkGate({ feed: { content: '今天面试挂了' }, text: '抱抱你，一切都会好起来的', cfg, quota });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('抱抱')));
});

t('太短被拒', () => {
  const r = checkGate({ feed: { content: '今天好累' }, text: '哈哈', cfg, quota });
  assert.equal(r.ok, false);
});

t('太长被拒', () => {
  const r = checkGate({ feed: { content: '今天好累' }, text: '啊'.repeat(80), cfg, quota });
  assert.equal(r.ok, false);
});

t('复述原文被拒', () => {
  const r = checkGate({
    feed: { content: '这周电影社放映恐怖电影血观音' },
    text: '这周电影社放映恐怖电影血观音吗',
    cfg, quota
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('复述')));
});

t('含链接被拒', () => {
  const r = checkGate({ feed: { content: '今天好累' }, text: '看这个 https://example.com 挺好', cfg, quota });
  assert.equal(r.ok, false);
});

t('含 @ 被拒', () => {
  const r = checkGate({ feed: { content: '今天好累' }, text: '问一下 @某某 怎么看', cfg, quota });
  assert.equal(r.ok, false);
});

t('与历史评论太像被拒', () => {
  const r = checkGate({
    feed: { content: '今天好累' },
    text: '这个问题得看当事人自己怎么想',
    cfg, quota,
    history: ['这个问题得看当事人自己怎么想啊']
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('相似')));
});

t('最长公共子串', () => {
  assert.equal(longestCommonSubstring('这周电影社放映', '电影社放映恐怖'), 5);
  assert.equal(longestCommonSubstring('abc', 'xyz'), 0);
});

t('相似度：同一句接近 1，不同句接近 0', () => {
  assert.ok(similarity('今天天气不错', '今天天气不错') > 0.99);
  assert.ok(similarity('今天天气不错', '这周电影社放映') < 0.2);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
