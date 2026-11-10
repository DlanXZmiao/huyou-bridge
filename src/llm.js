// llm.js — 模型调用（默认 DeepSeek 官方 API）
//
// key 的来源优先级：
//   1. 环境变量（默认 DEEPSEEK_API_KEY）
//   2. config.json 的 llm.apiKey
//   3. ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY（DSH 已经手输过，直接复用）
//
// provider=fake 时不联网，返回固定 JSON，供离线测试用。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

function readDshKey() {
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const text = fs.readFileSync(file, 'utf8');
    const m = /DEEPSEEK_API_KEY:\s*['"]?(sk-[A-Za-z0-9_-]+)['"]?/.exec(text);
    return m?.[1] ?? '';
  } catch {
    return '';
  }
}

export function resolveApiKey(cfg = {}) {
  const envName = cfg.llm?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  return process.env[envName] || cfg.llm?.apiKey || readDshKey() || '';
}

/**
 * 创建一个 chat 客户端。
 * @returns {{chat: (p:{messages:Array,system?:string,temperature?:number,maxTokens?:number})=>Promise<string>, describe:()=>string}}
 */
export function createLLM(cfg = {}, { onUsage } = {}) {
  const provider = cfg.llm?.provider ?? 'deepseek';

  if (provider === 'fake') {
    return {
      describe: () => 'fake',
      chat: async () => process.env.FAKE_REPLY
        ?? JSON.stringify({ action: 'skip', reason: 'fake provider', text: '', confidence: 0 })
    };
  }

  const key = resolveApiKey(cfg);
  if (!key) {
    throw new Error('没有可用的模型 key：请设置 DEEPSEEK_API_KEY，或在 config.json 的 llm.apiKey 填写');
  }
  const base = String(cfg.llm?.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
  const model = cfg.llm?.model ?? DEFAULT_MODEL;

  return {
    describe: () => `${provider}/${model}`,
    async chat({ messages, temperature = 0.7, maxTokens = 400 }) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
        signal: AbortSignal.timeout(90000)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`模型 HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = await res.json();
      if (onUsage && body?.usage) {
        try { onUsage(body.usage); } catch { /* 记账失败不能影响主流程 */ }
      }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('模型返回里没有 content');
      return content;
    }
  };
}
