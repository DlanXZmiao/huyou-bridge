#!/usr/bin/env node
// test-mcp.mjs — 起一个真实的 MCP 客户端，连本项目的 mcp-huyou.js，验证工具可用。
//
// 用法：node scripts/test-mcp.mjs
// 不依赖 DSH，直接走 stdio 协议。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src', 'mcp-huyou.js')],
  cwd: ROOT,
  stderr: 'pipe'
});

const client = new Client({ name: 'huyou-test', version: '0.0.1' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`工具 ${tools.length} 个:`);
for (const t of tools) console.log(`  - ${t.name}`);

const status = await client.callTool({ name: 'huyou_status', arguments: {} });
const statusObj = JSON.parse(status.content[0].text);
console.log('\nstatus:', JSON.stringify({
  login: statusObj.login,
  mode: statusObj.mode,
  dryRun: statusObj.dryRun,
  todayCount: statusObj.todayCount,
  allowSendViaMcp: statusObj.allowSendViaMcp
}));

const feed = await client.callTool({ name: 'huyou_feed', arguments: { limit: 2 } });
const feedObj = JSON.parse(feed.content[0].text);
console.log(`\nfeed: ${feedObj.count} 条`);
for (const f of feedObj.feeds) console.log(`  - ${f.feedId} ${f.content.slice(0, 30)}`);

const draft = await client.callTool({
  name: 'huyou_draft_comment',
  arguments: { feed_id: feedObj.feeds[0].feedId, text: '这条我接不上话' }
});
console.log('\ndraft 预检:', draft.content[0].text.replace(/\s+/g, ' ').slice(0, 200));

await client.close();
console.log('\n✅ MCP 工具可用');
