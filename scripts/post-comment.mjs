#!/usr/bin/env node
// post-comment.mjs — 发一条评论（默认 dry-run，加 --send 才真发）。
//
// 用法：
//   node scripts/post-comment.mjs --feed 1495689332906984704 --text "车车"
//   node scripts/post-comment.mjs --feed 1495689332906984704 --text "车车" --send
//
// 只允许发纯文本，长度 2..140。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, postComment, getCommentList, signParams } from '../src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : def;
};
const FEED = arg('--feed');
const TEXT = arg('--text');
const SEND = argv.includes('--send');

if (!FEED || !TEXT) {
  console.error('用法: node scripts/post-comment.mjs --feed <id> --text "内容" [--send]');
  process.exit(2);
}
if (TEXT.length < 2 || TEXT.length > 140) {
  console.error('内容长度必须是 2..140');
  process.exit(2);
}

const session = loadSession(ROOT);
const online = await getCommentList(FEED, { session });
console.log(`会话检查: HTTP ${online.httpStatus}  业务 ${online.status} ${online.desc ?? ''}`);
if (online.status !== 100000) {
  console.error('登录态不可用，请重新运行 login.bat');
  process.exit(1);
}

const preview = signParams({ feed_id: String(FEED), comment_type: 'comment', content: TEXT, tid: 'PREVIEW' });
console.log('将发送:');
console.log(`  POST /v8/comment/text`);
console.log(`  feed_id=${FEED}&comment_type=comment&content=${TEXT}&tid=<now>&…&sig=${preview.sig}`);

if (!SEND) {
  console.log('\n(dry-run，没有真发；加 --send 才发)');
  process.exit(0);
}

const r = await postComment(FEED, TEXT, { session });
console.log(`发送结果: HTTP ${r.httpStatus}  业务 ${r.status} ${r.desc ?? ''}`);
if (r.status !== 100000) {
  console.log('响应:', String(r.text).slice(0, 400));
  process.exit(1);
}
const id = r.data?.commentId;
console.log('commentId:', id ?? '(未返回)');

const after = await getCommentList(FEED, { session });
const hit = (after.data?.list ?? []).find((c) => c.commentId === id || c.content === TEXT);
console.log(hit ? '✅ 回读确认：评论已出现在列表里' : '⚠️ 回读没找到这条（可能分页/延迟）');
