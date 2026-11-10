#!/usr/bin/env node
// test-feed.mjs — 用 fixtures/nuxt-feed.json 做离线回归（不发请求）。
//
// 页面改版时这个测试会先挂，提醒更新解析器。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNuxtPayload, collectFeeds, normalizeFeed } from '../src/feed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const fixture = path.join(ROOT, 'fixtures', 'nuxt-feed.json');

if (!fs.existsSync(fixture)) {
  console.error('缺少 fixtures/nuxt-feed.json');
  process.exit(2);
}

const flat = JSON.parse(fs.readFileSync(fixture, 'utf8'));
const tree = parseNuxtPayload(flat);
const feeds = [...collectFeeds(tree).values()].map(normalizeFeed);

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('feed parser:');

t('能解析出至少 10 条帖子', () => {
  assert.ok(feeds.length >= 10, `只解析出 ${feeds.length} 条`);
});

t('每条都有 feedId 和正文', () => {
  for (const f of feeds) {
    assert.ok(/^\d+$/.test(f.feedId), `feedId 异常: ${f.feedId}`);
    assert.ok(f.content.length > 0, `正文为空: ${f.feedId}`);
  }
});

t('时间戳是合理的毫秒值', () => {
  const withTime = feeds.filter((f) => f.at > 0);
  assert.ok(withTime.length >= 5, '带时间的帖子太少，字段可能改名了');
  for (const f of withTime) {
    assert.ok(f.at > 1_600_000_000_000 && f.at < Date.now() + 86_400_000, `时间异常: ${f.at}`);
  }
});

t('圈子与评论数字段可用', () => {
  assert.ok(feeds.some((f) => f.circle), '没有一条带圈子');
  assert.ok(feeds.some((f) => f.commentCount > 0), '评论数都是 0');
});

t('匿名标记存在', () => {
  assert.ok(feeds.some((f) => f.anonymous === true), '没有匿名帖子');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
