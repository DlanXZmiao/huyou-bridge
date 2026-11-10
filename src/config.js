// config.js — 配置加载（config.json 覆盖 config.example.json 的默认值）
//
// 所有阈值都有默认值，config.json 不存在也能跑（只读模式）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 3400 },
  huyou: {
    webBase: 'https://w.sohu.com',
    pollIntervalMs: 600000,
    maxCandidatesPerRound: 5,
    maxAgeHours: 168,
    decideTtlHours: 6,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
  },
  comment: { minGapMs: 90000, maxPerRound: 1 },
  llm: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKey: ''
  },
  mcp: { allowSend: false },
  gates: {
    hardBlockTopics: [
      '自伤', '自杀', '想死', '不想活', '自残', '抑郁', '崩溃',
      '疾病', '癌症', '手术',
      '贫困', '没钱', '欠钱', '学费', '家暴', '性取向', '政治', '宗教',
      '抽奖', '广告', '加微信'
    ],
    bannedPhrases: ['抱抱', '加油', '心疼你', '我懂你', '一切都会好'],
    noLinks: true,
    noAt: true,
    maxOverlapWithFeed: 8,
    similarityThreshold: 0.8
  },
  circuitBreaker: { consecutiveFailures: 3, cooldownMs: 3600000 },
  sessionFile: 'state/session.json',
  killSwitchFile: 'state/STOP'
};

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function readJson(file, label) {
  try {
    // 去掉 PowerShell 写文件时可能带的 BOM，否则 JSON.parse 会直接炸
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} 解析失败: ${e.message}`);
  }
}

export function loadConfig(root = ROOT) {
  const example = path.join(root, 'config.example.json');
  const local = path.join(root, 'config.json');
  let cfg = DEFAULTS;
  if (fs.existsSync(example)) cfg = deepMerge(cfg, readJson(example, 'config.example.json'));
  if (fs.existsSync(local)) cfg = deepMerge(cfg, readJson(local, 'config.json'));
  return cfg;
}

export function loadQuota(root = ROOT) {
  const file = path.join(root, 'settings', 'quota.json');
  const fallback = {
    mode: 'off', dryRun: true, maxPerDay: 10, maxPerHour: 3, minGapMs: 90000, minChars: 6, maxChars: 60,
    allowCircles: [], circleIds: [], replyThreads: true,
    threadsScanIntervalMs: 600000, threadMaxRounds: 2, threadWindowHours: 24, threadMaxPerDay: 5, threadMaxPerHour: 2
  };
  if (!fs.existsSync(file)) return fallback;
  return { ...fallback, ...readJson(file, 'settings/quota.json') };
}

export function loadPostSettings(root = ROOT) {
  const file = path.join(root, 'settings', 'post.json');
  const fallback = {
    enabled: false,
    mode: 'manual',      // manual = 只手动；daily = 每天定时
    dailyTime: '20:30',  // HH:MM
    circleId: '',
    anonymous: true,
    withImage: true
  };
  if (!fs.existsSync(file)) return fallback;
  return { ...fallback, ...readJson(file, 'settings/post.json') };
}

export function loadCleanupSettings(root = ROOT) {
  const file = path.join(root, 'settings', 'cleanup.json');
  const fallback = { enabled: false, hours: 48, dailyTime: '03:30' };
  if (!fs.existsSync(file)) return fallback;
  return { ...fallback, ...readJson(file, 'settings/cleanup.json') };
}

export function killSwitchOn(cfg, root = ROOT) {
  return fs.existsSync(path.join(root, cfg.killSwitchFile ?? 'state/STOP'));
}
