// post.js — 发帖：生成「文言 + 白话」两段，并从 表情包/ 随机挑一张图。
//
// 只负责生成草稿，不负责发布（发布接口另说）。

import fs from 'node:fs';
import path from 'node:path';
import { publishTextFeed, uploadFeedImage, publishDynamicFeed } from './api.js';
import { imageSize } from './image-size.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_CLASSICAL = 140;
const MAX_VERNACULAR = 80;

/** 从 表情包/ 里随机挑一张。空目录返回 null。 */
export function pickSticker(dir, rand = Math.random) {
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name));
  } catch {
    return null;
  }
  if (!files.length) return null;
  return files[Math.floor(rand() * files.length) % files.length];
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export function loadStyle(root) {
  return readText(path.join(root, 'settings', 'style.md'));
}

export function buildPostMessages({ persona, style, feeds }) {
  const system = [
    '你在扮演狐友上的一个普通网友，准备发一条动态。',
    '动态分两段，只输出 JSON，不要解释、不要代码块。',
    '',
    '【上半段 · 周礼体】',
    '注意：不是真文言，是"现代白话为骨、古意点缀"的翻译腔，写成真文言就失败了。',
    style || '（未配置文风）',
    '',
    '【上半段的具体要求】',
    '- 从素材里挑两三件**轻松、无害**的事来写，最好彼此有点反差。',
    '- 先一句短比喻或旧事，再落到这几件事，最后给一个郑重又意外的结论。',
    '- 可以略作点评，但不嘲讽、不给当事人定性、不点学校和名字。',
    '- 素材里如果有情绪低落、求助、家庭、疾病、身材之类的内容，**一律跳过，不许写进去**。',
    '',
    '【下半段 · 白话】',
    '- 一到两句，口语，写你今天的感受或想说的话。',
    '- 不总结上半段、不升华、不喊口号。',
    '',
    '【人设】',
    persona || '（未配置）',
    '',
    '【硬规则】',
    '- 不嘲讽、不挖苦、不给别人定性；不点具体人名。',
    '- 不带链接、@、话题标签。',
    '- 不提及 AI，不说"我在总结"。',
    '- 不使用「圣人云」「孔子曰」「古人云」「《周礼》所言」这类伪引用。',
    '- 不使用「你且想想」「其中的道理」这类机械结尾。',
    `- 上半段不超过 ${MAX_CLASSICAL} 字，下半段不超过 ${MAX_VERNACULAR} 字。`,
    '- 两段之间不要自己加分隔符。',
    '',
    '【输出】只输出一行 JSON：',
    '{"classical":"周礼体那一段","vernacular":"白话那一段"}'
  ].join('\n');

  const digest = (feeds ?? []).slice(0, 12).map((f, i) => ({
    序号: i + 1,
    圈子: f.circle || '',
    内容: String(f.content ?? '').replace(/\s+/g, ' ').slice(0, 80)
  }));

  const user = [
    '这是最近狐友上的帖子（可能包含不同圈子，挑两三件有意思的写进上半段）：',
    '```json',
    JSON.stringify(digest, null, 2),
    '```'
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function parsePost(raw) {
  const text = String(raw ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`模型输出里没有 JSON: ${text.slice(0, 120)}`);
  const obj = JSON.parse(candidate.slice(start, end + 1));
  const classical = String(obj.classical ?? '').trim();
  const vernacular = String(obj.vernacular ?? '').trim();
  if (!classical || !vernacular) throw new Error('两段都要有内容');
  return { classical, vernacular };
}

/**
 * 生成一条动态草稿。
 * @returns {Promise<{classical:string, vernacular:string, text:string, image:string|null}>}
 */
export async function composePost({ llm, persona, style, feeds, stickerDir }) {
  const messages = buildPostMessages({ persona, style, feeds });
  const out = await llm.chat({ messages, temperature: 0.95, maxTokens: 700 });
  let { classical, vernacular } = parsePost(out);

  // 超长就让它自己压一次（比截断体面）
  if (classical.length > MAX_CLASSICAL) {
    try {
      const retry = await llm.chat({
        messages: [
          ...messages,
          { role: 'assistant', content: out },
          {
            role: 'user',
            content: `上半段写了 ${classical.length} 字，超过 ${MAX_CLASSICAL} 字。请压缩到 ${MAX_CLASSICAL} 字以内，保留那几件事和语气，只输出同样格式的 JSON。`
          }
        ],
        temperature: 0.6,
        maxTokens: 500
      });
      const shortened = parsePost(retry);
      if (shortened.classical.length <= classical.length) ({ classical, vernacular } = shortened);
    } catch { /* 压缩失败就用原来的 */ }
  }

  return {
    classical,
    vernacular,
    text: `${classical}\n\n${vernacular}`,
    image: pickSticker(stickerDir)
  };
}

/**
 * 发布一条动态。有图就走上传 + /v7/feeds/dynamic，没图走 /v7/feeds/text。
 * @returns {Promise<{status:number, desc:string, feedId:string, image?:string}>}
 */
export async function publishDraft({ draft, session, circleId, anonymous = true, withImage = true }) {
  if (!circleId) throw new Error('没有配置发帖目标圈子（settings/post.json 的 circleId）');

  if (withImage && draft.image) {
    const buf = fs.readFileSync(draft.image);
    const size = imageSize(buf);
    const up = await uploadFeedImage(buf, {
      session,
      filename: path.basename(draft.image),
      mime: size.mime,
      width: size.width,
      height: size.height
    });
    const r = await publishDynamicFeed(draft.text, {
      session,
      circleId,
      pics: [{ p: up.basename, w: size.width, h: size.height }]
    });
    return {
      status: r.status,
      desc: r.desc ?? '',
      feedId: r.data?.newFeedId ? String(r.data.newFeedId) : '',
      image: up.picUrl || up.key
    };
  }

  const r = await publishTextFeed(draft.text, { session, circleId, anonymous });
  return {
    status: r.status,
    desc: r.desc ?? '',
    feedId: r.data?.newFeedId ? String(r.data.newFeedId) : ''
  };
}
