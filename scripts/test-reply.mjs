#!/usr/bin/env node
// test-reply.mjs — 验证「回复某条评论」的接口，可自动清理。
//
// 用法：
//   node scripts/test-reply.mjs --feed <feedId> --parent <commentId> --text "测试" [--delete]
//
// 流程：发回复 → 回读评论列表确认出现在 parent 的 replies 里 → 可选删除。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, postComment, getCommentList, removeComment } from '../src/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const FEED = arg('--feed');
const PARENT = arg('--parent');
const TEXT = arg('--text', '测试回复，稍后删除');
const DO_DELETE = argv.includes('--delete');

if (!FEED || !PARENT) {
  console.error('用法: node scripts/test-reply.mjs --feed <feedId> --parent <commentId> --text "…" [--delete]');
  process.exit(2);
}

const session = loadSession(ROOT);

// 先确认父评论存在
const before = await getCommentList(FEED, { count: 50, session });
const parent = (before.data?.list ?? []).find((c) => String(c.commentId) === String(PARENT));
if (!parent) {
  console.error('没找到父评论', PARENT);
  process.exit(1);
}
console.log(`父评论：${parent.userName}「${String(parent.content).slice(0, 30)}」`);
console.log(`已有回复 ${parent.replies?.list?.length ?? 0} 条`);

const r = await postComment(FEED, TEXT, { session, replyToCommentId: PARENT });
console.log('提交结果:', r.httpStatus, r.status, r.desc ?? '');
if (r.status !== 100000) {
  console.log('响应:', String(r.text).slice(0, 300));
  process.exit(1);
}
const newId = r.data?.commentId;
console.log('新回复 commentId:', newId);

// 回读确认
const after = await getCommentList(FEED, { count: 50, session });
const parent2 = (after.data?.list ?? []).find((c) => String(c.commentId) === String(PARENT));
const replies = parent2?.replies?.list ?? [];
const found = replies.some((x) => String(x.commentId) === String(newId) || x.content === TEXT);
console.log(`回读：父评论下现有 ${replies.length} 条回复，${found ? '✅ 找到我们发的' : '⚠️ 没找到'}`);

if (DO_DELETE && newId) {
  const d = await removeComment(newId, { session });
  console.log('删除结果:', d.httpStatus, d.status, d.desc ?? '');
}
