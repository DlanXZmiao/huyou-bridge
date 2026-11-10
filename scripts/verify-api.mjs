#!/usr/bin/env node
// verify-api.mjs — 用本地登录态 + 手算签名直接调狐友接口，验证链路是否可用。
//
// 只调用**只读**接口（/v8/comment/list、/v7/feeds/show），不会发评论。
//
// 用法：
//   node scripts/verify-api.mjs
//   node scripts/verify-api.mjs --feed 1495689332906984704
//
// 退出码：0 = 成功；1 = 失败（会打印原因）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SESSION = path.join(ROOT, 'state', 'session.json');

const APP_ID = '330012';
const P_APP_ID = '110503';
const APP_KEY = '1U32034rUs20A064';
const APP_KEY_VS = '6.24.0';
const API = 'https://cs-ol.sns.sohu.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const feedArgIndex = process.argv.indexOf('--feed');
const FEED_ID = feedArgIndex > -1 ? process.argv[feedArgIndex + 1] : '1495689332906984704';

function loadSession() {
  if (!fs.existsSync(SESSION)) {
    throw new Error('找不到 state/session.json，请先运行 login.bat 登录');
  }
  const doc = JSON.parse(fs.readFileSync(SESSION, 'utf8'));
  const cookies = Object.fromEntries((doc.cookies ?? []).map((c) => [c.name, c.value]));
  return { doc, cookies };
}

/**
 * 狐友 Web 的签名（逆向自 bundle 的 signDataWithCoreServer，已用真实请求验证）：
 *   1. 参数补 flyer / appid / app_key_vs；
 *   2. 展开成 "k=v"；
 *   3. 若带 s-nonce，追加 `s-nonce=…` 与 `S-VS=…`；
 *   4. **整串**字典序排序，末尾拼 app_key，md5。
 */
export function signParams(params, { nonce, version = APP_KEY_VS } = {}) {
  const p = { ...params, flyer: params.flyer ?? String(Date.now()), appid: APP_ID, app_key_vs: version };
  const pairs = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined) continue;
    pairs.push(`${k}=${v}`);
  }
  if (nonce) {
    pairs.push(`s-nonce=${nonce}`);
    pairs.push(`S-VS=${version}`);
  }
  pairs.sort();
  const sig = crypto.createHash('md5').update(pairs.join('') + APP_KEY).digest('hex');
  return { params: p, sig, nonce };
}

function buildHeaders(cookies, { nonce, flyer }) {
  return {
    token: cookies.pchytk ?? '',
    appid: APP_ID,
    'p-appid': P_APP_ID,
    's-vs': APP_KEY_VS,
    's-nonce': nonce,
    flyer,
    's-cid': cookies.gidinf ?? '',
    gid: cookies.gidinf ?? '',
    's-ppid': cookies.pchypp ?? '',
    's-pid': cookies.hyuid ?? '',
    Referer: 'https://w.sohu.com/',
    Origin: 'https://w.sohu.com',
    'User-Agent': UA
  };
}

async function call(pathname, params) {
  const { doc, cookies } = loadSession();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signed = signParams(params, { nonce });
  const qs = new URLSearchParams({ ...signed.params, sig: signed.sig }).toString();
  const url = `${API}${pathname}?${qs}`;
  const res = await fetch(url, { headers: buildHeaders(cookies, { nonce, flyer: signed.params.flyer }) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, body, text, session: doc };
}

async function main() {
  console.log('feed_id:', FEED_ID);
  const list = await call('/v8/comment/list', {
    feed_id: FEED_ID, stpl: '1,2,4,7,8,9,16', score: '0', count: '20'
  });
  const ok = list.status === 200 && list.body?.status === 100000;
  console.log('HTTP', list.status, '业务状态', list.body?.status, list.body?.desc ?? '');
  if (!ok) {
    console.log('响应片段:', String(list.text).slice(0, 300));
    process.exitCode = 1;
    return;
  }
  const info = list.body.data?.pageInfo ?? {};
  const items = list.body.data?.list ?? [];
  console.log(`评论 ${info.totalCount ?? 0} 条，本页 ${items.length} 条`);
  for (const it of items.slice(0, 3)) {
    console.log(`  - ${it.userName}${it.anonymous ? '（匿名）' : ''}: ${String(it.content ?? '').slice(0, 40)}`);
  }

  const show = await call('/v7/feeds/show', { feed_id: FEED_ID });
  const feed = show.body?.data?.feed;
  if (feed) {
    console.log(`帖子: ${String(feed.content ?? '').slice(0, 40)}…  作者 ${feed.userName ?? '?'}`);
  }
  console.log('✅ 登录态与签名都可用（纯 HTTP，未开浏览器）');
}

main().catch((e) => {
  console.error('❌ 失败:', e?.message ?? e);
  process.exitCode = 1;
});
