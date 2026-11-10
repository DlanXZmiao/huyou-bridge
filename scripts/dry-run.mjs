#!/usr/bin/env node
// dry-run.mjs — 不发送任何东西，只用来看"信息流长什么样、闸门会怎么判"。
//
// 用法：
//   node scripts/dry-run.mjs                 # 拉 5 条推荐流并打印
//   node scripts/dry-run.mjs --limit 10
//   node scripts/dry-run.mjs --feed <id> --text "这句评论"
//   node scripts/dry-run.mjs --send-test     # 走完整管道但 dryRun=true（仍然不发）

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadQuota } from '../src/config.js';
import { fetchRecommendFeeds } from '../src/feed.js';
import { checkGate } from '../src/gates.js';
import { loadSession } from '../src/api.js';
import { loadState, stateFile, recentTexts } from '../src/state.js';
import { submitComment } from '../src/comment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : def;
};
const limit = Number(arg('--limit', 5));
const feedId = arg('--feed');
const text = arg('--text');

const cfg = loadConfig(ROOT);
const quota = loadQuota(ROOT);

if (feedId && text) {
  const state = loadState(stateFile(ROOT));
  const session = loadSession(ROOT);
  const r = await submitComment({
    feedId, text,
    feed: { content: arg('--feed-content', '') },
    session, state, cfg, quota,
    dryRun: true
  });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

console.log(`拉取推荐流（limit=${limit}）…`);
const feeds = await fetchRecommendFeeds({ limit, cfg });
console.log(`拿到 ${feeds.length} 条\n`);

const state = loadState(stateFile(ROOT));
const history = recentTexts(state, 20);

for (const f of feeds) {
  const when = f.at ? new Date(f.at).toLocaleString('zh-CN') : '?';
  console.log(`── ${f.feedId}  ${f.anonymous ? '(匿名)' : f.userName}  ${f.circle}  ${when}`);
  console.log(`   ${f.content.replace(/\n/g, ' ').slice(0, 90)}`);
  console.log(`   评论 ${f.commentCount} · 曝光 ${f.exposureCount}`);
  if (f.hotComment) console.log(`   热评: ${f.hotComment.slice(0, 50)}`);

  if (text) {
    const g = checkGate({ feed: f, text, cfg: cfg.gates, quota, history });
    console.log(`   闸门: ${g.ok ? '✅ 通过' : '⛔ ' + g.reasons.join('；')}`);
  }
  console.log('');
}

if (!argv.includes('--send-test')) {
  console.log('（纯只读，没有发送任何东西）');
}
