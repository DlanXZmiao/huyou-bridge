// mcp-huyou.js — 给 DSH 用的狐友 MCP server（stdio）
//
// 由 DSH 的 MCP 客户端 spawn（见 plugins/huyou-agent-tools/cordis.patch.yml）。
// 默认**只读**：读信息流、读评论、给评论草稿做闸门预检。
// 发送需要 config.json 里 `mcp.allowSend: true`，且每次调用显式传 confirm=true。
//
// 注意：stdout 是 MCP 协议通道，任何日志必须走 stderr。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, loadQuota } from './config.js';
import { fetchRecommendFeeds, fetchFeedDetail, fetchComments } from './feed.js';
import { checkGate } from './gates.js';
import { loadSession } from './api.js';
import { loadState, stateFile, alreadyCommented, canSendNow, recentTexts } from './state.js';
import { submitComment } from './comment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const log = (...a) => console.error('[mcp-huyou]', ...a);
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

function readSession() {
  try {
    return { session: loadSession(ROOT), error: null };
  } catch (e) {
    return { session: null, error: e.message };
  }
}

const server = new McpServer({ name: 'huyou', version: '0.1.0' });

server.tool(
  'huyou_status',
  '查看狐友账号状态：登录态是否可用、当前模式与配额、今日已发几条、是否有未处理的失败/熔断。只读。',
  {},
  async () => {
    const cfg = loadConfig(ROOT);
    const quota = loadQuota(ROOT);
    const state = loadState(stateFile(ROOT));
    const { session, error } = readSession();
    let login = 'unknown';
    if (session) {
      const r = await fetchRecommendFeeds({ limit: 1, cfg }).catch(() => null);
      login = r ? 'ok' : 'feed-failed';
    }
    const can = canSendNow(state, { quota, minGapMs: cfg.comment?.minGapMs ?? 90000 });
    return text({
      login,
      loginError: error,
      mode: quota.mode,
      dryRun: quota.dryRun,
      quota: { maxPerDay: quota.maxPerDay, maxPerHour: quota.maxPerHour, minGapMs: cfg.comment?.minGapMs, minChars: quota.minChars, maxChars: quota.maxChars },
      todayCount: state.quota.dayCount,
      lastSentAt: state.lastSentAt || null,
      canSendNow: can,
      allowSendViaMcp: cfg.mcp?.allowSend === true,
      stopFile: fs.existsSync(path.join(ROOT, 'state', 'STOP'))
    });
  }
);

server.tool(
  'huyou_feed',
  '拉取狐友推荐信息流（匿名可读，最多 20 条）。返回 feedId、正文、圈子、评论数、时间。',
  { limit: z.number().min(1).max(20).optional().describe('条数，默认 10') },
  async ({ limit }) => {
    const cfg = loadConfig(ROOT);
    const feeds = await fetchRecommendFeeds({ limit: limit ?? 10, cfg });
    return text({ count: feeds.length, feeds });
  }
);

server.tool(
  'huyou_feed_detail',
  '按 feedId 读取单条帖子详情（需要登录态）。',
  { feed_id: z.string().describe('帖子 id') },
  async ({ feed_id }) => {
    const { session, error } = readSession();
    if (!session) return text({ ok: false, error });
    const feed = await fetchFeedDetail(feed_id, { session });
    return text({ ok: true, feed });
  }
);

server.tool(
  'huyou_comments',
  '读取某条帖子下的评论（需要登录态）。',
  {
    feed_id: z.string().describe('帖子 id'),
    count: z.number().min(1).max(50).optional().describe('条数，默认 20')
  },
  async ({ feed_id, count }) => {
    const { session, error } = readSession();
    if (!session) return text({ ok: false, error });
    const list = await fetchComments(feed_id, { count: count ?? 20, session });
    return text({ ok: true, count: list.length, comments: list });
  }
);

server.tool(
  'huyou_draft_comment',
  '给一条帖子写评论草稿并做**闸门预检**（不发送）。返回是否允许发、命中了哪条规则。想真发请用 huyou_send_comment（需管理员开启）。',
  {
    feed_id: z.string().describe('帖子 id'),
    text: z.string().min(1).max(200).describe('拟发送的评论')
  },
  async ({ feed_id, text: body }) => {
    const cfg = loadConfig(ROOT);
    const quota = loadQuota(ROOT);
    const state = loadState(stateFile(ROOT));
    const feeds = await fetchRecommendFeeds({ limit: 20, cfg }).catch(() => []);
    const feed = feeds.find((f) => f.feedId === String(feed_id)) ?? { content: '' };
    const gate = checkGate({
      feed, text: body, cfg: cfg.gates, quota, history: recentTexts(state, 20)
    });
    return text({
      ok: gate.ok,
      reasons: gate.reasons,
      duplicate: alreadyCommented(state, feed_id),
      quota: canSendNow(state, { quota, minGapMs: cfg.comment?.minGapMs ?? 90000 })
    });
  }
);

server.tool(
  'huyou_send_comment',
  '真的发表一条评论（写操作）。只有 config.json 里 mcp.allowSend=true 时可用，且必须显式传 confirm=true。会经过全部闸门与配额限制。',
  {
    feed_id: z.string().describe('帖子 id'),
    text: z.string().min(1).max(200).describe('评论内容'),
    confirm: z.boolean().describe('必须为 true，表示确认要真实发布')
  },
  async ({ feed_id, text: body, confirm }) => {
    const cfg = loadConfig(ROOT);
    const quota = loadQuota(ROOT);
    if (cfg.mcp?.allowSend !== true) {
      return text({ ok: false, error: '未开启 mcp.allowSend，写操作被拒绝' });
    }
    if (confirm !== true) return text({ ok: false, error: '需要 confirm=true' });
    if (fs.existsSync(path.join(ROOT, 'state', 'STOP'))) return text({ ok: false, error: 'STOP 文件存在，已停止' });

    const { session, error } = readSession();
    if (!session) return text({ ok: false, error });

    const state = loadState(stateFile(ROOT));
    const feeds = await fetchRecommendFeeds({ limit: 20, cfg }).catch(() => []);
    const feed = feeds.find((f) => f.feedId === String(feed_id)) ?? { content: '' };
    const result = await submitComment({
      feedId: feed_id, text: body, feed, session, state, cfg, quota, dryRun: false
    });
    const { saveState } = await import('./state.js');
    saveState(stateFile(ROOT), state);
    return text(result);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('ready');
