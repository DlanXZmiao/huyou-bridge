// decide.js — "要不要评论、评论什么"由模型决定。
//
// 模型只输出一段 JSON；合不合规由 gates.js 和 comment.js 说了算。

import fs from 'node:fs';
import path from 'node:path';

const MAX_JSON_ATTEMPTS = 2;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/** 读人设与策略。改文件即生效，不用重启。 */
export function loadPersona(root) {
  return {
    persona: readText(path.join(root, 'settings', 'persona.md')),
    policy: readText(path.join(root, 'settings', 'policy.md'))
  };
}

export function buildMessages({ persona, policy, feed, comments = [], quota }) {
  const examples = (persona.match(/^-\s+.+$/gm) ?? []).slice(0, 6).join('\n');
  const system = [
    '你在扮演一个真实的人，在校园社交产品「狐友」上刷信息流、偶尔留一句评论。',
    '',
    '【人设】',
    persona || '（未配置）',
    '',
    '【评论策略】',
    policy || '（未配置）',
    '',
    '【硬规则】',
    `- 评论长度必须在 ${quota.minChars}~${quota.maxChars} 个汉字之间。`,
    '- 只输出一句自然的话，不要解释、不要总结对方、不要说教、不要用"抱抱/加油/我懂你"这类模板。',
    '- 不要提及 AI、机器人、模型。不要带链接、@、联系方式。',
    '- 看不懂、太沉重、已经有类似评论、或者你只是想说"加油"——一律 skip。',
    '- 宁可少说，不要错说。',
    '',
    '【输出格式】只输出一行 JSON，不要代码块：',
    '{"action":"comment"|"skip","text":"要发的话（skip 时留空）","reason":"一句话理由","confidence":0.0~1.0}',
    examples ? `\n参考语气：\n${examples}` : ''
  ].join('\n');

  const feedBlock = {
    正文: feed.content,
    圈子: feed.circle || null,
    匿名: feed.anonymous,
    评论数: feed.commentCount,
    已有热评: comments.slice(0, 5).map((c) => String(c.content ?? '').slice(0, 60))
  };

  const user = [
    '下面是一条帖子，判断你要不要评论、评论什么。',
    '```json',
    JSON.stringify(feedBlock, null, 2),
    '```'
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹和前后废话）。 */
export function parseDecision(raw) {
  const text = String(raw ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`模型输出里没有 JSON: ${text.slice(0, 120)}`);

  const obj = JSON.parse(candidate.slice(start, end + 1));
  const action = obj.action === 'comment' ? 'comment' : 'skip';
  return {
    action,
    text: typeof obj.text === 'string' ? obj.text.trim() : '',
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    confidence: Number(obj.confidence ?? 0)
  };
}

/**
 * 让模型决定一条帖子。
 * @returns {Promise<{action:'comment'|'skip', text:string, reason:string, confidence:number}>}
 */
export async function decide({ llm, persona, policy, feed, comments, quota }) {
  const messages = buildMessages({ persona, policy, feed, comments, quota });
  return runDecision(llm, messages);
}

/** 楼中楼：对方回复了我，我要不要接一句。 */
export function buildReplyMessages({ persona, policy, feedContent, myComment, theirReply, quota }) {
  const system = [
    '你在狐友上和一个人聊起来了：他回复了你的评论，现在你要回他一句。',
    '',
    '【人设】',
    persona || '（未配置）',
    '',
    '【规则】',
    '- 只回一句，长度 ' + quota.minChars + '~' + quota.maxChars + ' 个汉字。',
    '- 像接着聊天：不客套（不说"谢谢回复"）、不总结、不说教、不给方案。',
    '- 不重复对方的话，也不重复你自己之前说过的。',
    '- 对方在开玩笑就接轻梗；对方情绪低落就用安慰语气；对方在挑衅、阴阳、骂人 → skip。',
    '- 不提及 AI，不带链接、@、联系方式。',
    '- 拿不准就 skip，别硬接。',
    '',
    '【策略】',
    policy || '（未配置）',
    '',
    '【输出】只输出一行 JSON，不要代码块：',
    '{"action":"comment"|"skip","text":"要回的话（skip 时留空）","reason":"一句话理由","confidence":0.0~1.0}'
  ].join('\n');

  const user = [
    '【原帖】',
    String(feedContent ?? '').slice(0, 300) || '（未知）',
    '',
    '【我之前评论的】',
    String(myComment ?? ''),
    '',
    '【他回复我】',
    String(theirReply ?? ''),
    '',
    '判断要不要回、回什么。'
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export async function decideReply({ llm, persona, policy, feedContent, myComment, theirReply, quota }) {
  const messages = buildReplyMessages({ persona, policy, feedContent, myComment, theirReply, quota });
  return runDecision(llm, messages);
}

async function runDecision(llm, messages) {
  let lastError = null;
  for (let i = 0; i < MAX_JSON_ATTEMPTS; i++) {
    try {
      const out = await llm.chat({ messages, temperature: i === 0 ? 0.8 : 0.3, maxTokens: 300 });
      const decision = parseDecision(out);
      if (decision.action === 'comment' && decision.confidence < 0.7) {
        return { ...decision, action: 'skip', reason: `置信度不足（${decision.confidence}）：${decision.reason}` };
      }
      return decision;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('模型决策失败');
}
