#!/usr/bin/env node
// cleanup.mjs — 命令行清理上下文（默认保留 48 小时）。
//
// 用法：
//   node scripts/cleanup.mjs              # 真清理
//   node scripts/cleanup.mjs --dry-run    # 只看会删多少
//   node scripts/cleanup.mjs --hours 72

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupContext } from '../src/cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const i = argv.indexOf('--hours');
const hours = i > -1 ? Number(argv[i + 1]) : 48;
const dryRun = argv.includes('--dry-run');

const r = cleanupContext({ root: ROOT, hours, dryRun });
console.log(`${dryRun ? '[dry-run] ' : ''}保留 ${r.keepHours} 小时内（cutoff ${r.cutoff}）`);
console.log('清理前:', JSON.stringify(r.before));
console.log('清理后:', JSON.stringify(r.after));
console.log('删除:  ', JSON.stringify(r.removed));
