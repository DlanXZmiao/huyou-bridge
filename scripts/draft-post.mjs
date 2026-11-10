#!/usr/bin/env node
// draft-post.mjs — 生成一条动态草稿（只打印，不发布）。
//
// 用法：
//   node scripts/draft-post.mjs                 # 用配置里的圈子
//   node scripts/draft-post.mjs --limit 12      # 多看几条帖子来总结
//   node scripts/draft-post.mjs --no-image      # 不挑图

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadQuota } from '../src/config.js';
import { fetchRecommendFeeds, fetchCircleFeeds, filterByCircles } from '../src/feed.js';
import { loadPersona } from '../src/decide.js';
import { createLLM } from '../src/llm.js';
import { composePost, loadStyle, pickSticker } from '../src/post.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const limitArg = argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(argv[limitArg + 1]) : 12;
const noImage = argv.includes('--no-image');

const cfg = loadConfig(ROOT);
const quota = loadQuota(ROOT);
const { persona } = loadPersona(ROOT);
const style = loadStyle(ROOT);
const llm = createLLM(cfg);

const sources = [...await fetchRecommendFeeds({ limit: 20, cfg })];
for (const id of (quota.circleIds ?? [])) {
  try { sources.push(...await fetchCircleFeeds(id, { count: 10, cfg })); } catch { /* 忽略 */ }
}
const seen = new Map(sources.map((f) => [f.feedId, f]));
const feeds = filterByCircles([...seen.values()], quota).slice(0, limit);

if (!feeds.length) {
  console.error('没有可用帖子做素材（圈子过滤后为空）');
  process.exit(1);
}

console.log(`素材 ${feeds.length} 条，来自：${[...new Set(feeds.map((f) => f.circle))].join('、')}`);
console.log('');

const draft = await composePost({
  llm, persona, style, feeds,
  stickerDir: path.join(ROOT, '表情包')
});

console.log('──────── 动态草稿 ────────');
console.log(draft.text);
console.log('──────────────────────────');
console.log(draft.image
  ? `配图：${path.relative(ROOT, draft.image)}`
  : '配图：表情包/ 里还没有图片（放几张进去即可）');
console.log(`字数：文言 ${draft.classical.length} / 白话 ${draft.vernacular.length}`);
