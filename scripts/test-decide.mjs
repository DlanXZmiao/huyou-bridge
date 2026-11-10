#!/usr/bin/env node
// test-decide.mjs — 决策层离线单测（fake 模型，不发网络请求）。

import assert from 'node:assert/strict';
import { parseDecision, buildMessages, decide } from '../src/decide.js';

const quota = { minChars: 6, maxChars: 60 };
const persona = '# 人设\n\n- 这猫胖得有点过分了\n- 十一点开故事会，我搬个小板凳';
const policy = '# 策略\n\n- 轻松吐槽可以评';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const tf = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('decide:');

t('解析裸 JSON', () => {
  const d = parseDecision('{"action":"comment","text":"这猫胖得有点过分了","reason":"玩梗","confidence":0.9}');
  assert.equal(d.action, 'comment');
  assert.equal(d.text, '这猫胖得有点过分了');
});

t('解析 ```json 包裹', () => {
  const d = parseDecision('```json\n{"action":"skip","reason":"看不懂","confidence":0.2}\n```');
  assert.equal(d.action, 'skip');
});

t('前后有废话也能抠出来', () => {
  const d = parseDecision('好的，我的判断是：{"action":"skip","reason":"x","confidence":0.1} 以上。');
  assert.equal(d.action, 'skip');
});

t('非法 action 退化为 skip', () => {
  const d = parseDecision('{"action":"delete","text":"x","confidence":0.9}');
  assert.equal(d.action, 'skip');
});

t('没有 JSON 会抛错', () => {
  assert.throws(() => parseDecision('我觉得这条不用评。'));
});

t('prompt 含人设、策略与长度约束', () => {
  const msgs = buildMessages({
    persona, policy,
    feed: { content: '今天好累', circle: '某圈', anonymous: false, commentCount: 3 },
    comments: [],
    quota
  });
  const all = msgs.map((m) => m.content).join('\n');
  assert.ok(all.includes('这猫胖得有点过分了'));
  assert.ok(all.includes('轻松吐槽可以评'));
  assert.ok(all.includes('6~60'));
  assert.ok(all.includes('今天好累'));
});

await tf('假模型输出 comment 且置信度够 → 采用', async () => {
  const llm = { chat: async () => '{"action":"comment","text":"这猫胖得有点过分了","reason":"玩梗","confidence":0.9}' };
  const d = await decide({ llm, persona, policy, feed: { content: '我家猫 20 斤' }, comments: [], quota });
  assert.equal(d.action, 'comment');
});

await tf('置信度 < 0.7 → 降级为 skip', async () => {
  const llm = { chat: async () => '{"action":"comment","text":"随便说一句","reason":"不确定","confidence":0.4}' };
  const d = await decide({ llm, persona, policy, feed: { content: '今天好累' }, comments: [], quota });
  assert.equal(d.action, 'skip');
  assert.ok(d.reason.includes('置信度'));
});

await tf('模型先输出坏 JSON、第二次正常 → 重试成功', async () => {
  let n = 0;
  const llm = {
    chat: async () => {
      n += 1;
      return n === 1 ? '我想想啊……' : '{"action":"skip","reason":"没接上","confidence":0.1}';
    }
  };
  const d = await decide({ llm, persona, policy, feed: { content: '今天好累' }, comments: [], quota });
  assert.equal(d.action, 'skip');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
