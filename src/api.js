// api.js — 狐友 Web 接口客户端（零依赖）
//
// 签名算法逆向自前端 bundle 的 signDataWithCoreServer，已用真实请求逐字符验证，
// 详见 docs/SIGNATURE.md。
//
// 提供：读评论列表、读帖子详情、发评论。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const API_BASE = 'https://cs-ol.sns.sohu.com';
const APP_ID = '330012';
const P_APP_ID = '110503';
const APP_KEY = '1U32034rUs20A064';
const APP_KEY_VS = '6.24.0';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

export function loadSession(root) {
  const file = path.join(root, 'state', 'session.json');
  if (!fs.existsSync(file)) throw new Error('找不到 state/session.json，请先运行 login.bat 登录');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cookies = Object.fromEntries((doc.cookies ?? []).map((c) => [c.name, c.value]));
  return { doc, cookies };
}

/** 签名：补固定参数 → 展开 k=v → 追加 s-nonce/S-VS → 整串排序 → 末尾拼 app_key → md5。 */
export function signParams(input, { nonce, version = APP_KEY_VS } = {}) {
  const params = { ...input };
  params.flyer = params.flyer ?? String(Date.now());
  params.appid = APP_ID;
  params.app_key_vs = version;

  const pairs = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    pairs.push(`${k}=${v}`);
  }
  if (nonce) {
    pairs.push(`s-nonce=${nonce}`);
    pairs.push(`S-VS=${version}`);
  }
  pairs.sort();
  const sig = crypto.createHash('md5').update(pairs.join('') + APP_KEY).digest('hex');
  return { params, sig };
}

function headers(cookies, { nonce, flyer, form = false }) {
  const h = {
    token: cookies.pchytk ?? '',          // 登录 token（也是 pchytk cookie）
    appid: APP_ID,
    'p-appid': P_APP_ID,
    's-vs': APP_KEY_VS,
    's-nonce': nonce,
    flyer,
    's-cid': cookies.gidinf ?? '',        // 设备 id：cookie 名为 gidinf
    gid: cookies.gidinf ?? '',
    's-ppid': cookies.pchypp ?? '',       // 形如 <your-ppid>
    's-pid': cookies.hyuid ?? '',         // 用户 id
    Referer: 'https://w.sohu.com/',
    Origin: 'https://w.sohu.com',
    'User-Agent': UA
  };
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  return h;
}

/**
 * 发一个签名请求。
 * @param {object} opts
 * @param {'GET'|'POST'} opts.method
 * @param {object} opts.params 参与签名的参数
 * @param {boolean} opts.form  是否把参数放进 body（POST 表单）
 */
export async function call(pathname, { method = 'GET', params = {}, form = false, session } = {}) {
  const { cookies } = session ?? loadSession(process.cwd());
  const nonce = crypto.randomBytes(16).toString('hex');
  const { params: signed, sig } = signParams(params, { nonce });
  const url = new URL(API_BASE + pathname);
  const h = headers(cookies, { nonce, flyer: signed.flyer, form });

  let res;
  if (form) {
    const body = new URLSearchParams({ ...signed, sig }).toString();
    res = await fetch(url, { method: 'POST', headers: h, body });
  } else {
    url.search = new URLSearchParams({ ...signed, sig }).toString();
    res = await fetch(url, { method, headers: h });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { httpStatus: res.status, status: json?.status, desc: json?.desc, data: json?.data, text };
}

export const getCommentList = (feedId, { count = 20, session } = {}) =>
  call('/v8/comment/list', {
    params: { feed_id: String(feedId), stpl: '1,2,4,7,8,9,16', score: '0', count: String(count) },
    session
  });

export const getFeed = (feedId, { session } = {}) =>
  call('/v7/feeds/show', { params: { feed_id: String(feedId) }, session });

/**
 * 发评论 / 发回复。
 * @param {string} feedId
 * @param {string} content 纯文本
 * @param {{tid?: string, session?: object, replyToCommentId?: string}} opts
 *   replyToCommentId 非空时走回复：comment_type=reply + reply_comment_id
 */
export async function postComment(feedId, content, { tid, session, replyToCommentId } = {}) {
  const flyer = String(Date.now());
  const params = {
    feed_id: String(feedId),
    comment_type: replyToCommentId ? 'reply' : 'comment',
    content,
    tid: tid ?? flyer
  };
  if (replyToCommentId) params.reply_comment_id = String(replyToCommentId);
  return call('/v8/comment/text', { method: 'POST', form: true, params, session });
}

/**
 * 发一条纯文字动态。
 * @param {string} content
 * @param {{session?: object, circleId?: string, anonymous?: boolean, tid?: string}} opts
 */
export async function publishTextFeed(content, { session, circleId, anonymous = true, tid } = {}) {
  const { cookies } = session ?? loadSession(process.cwd());
  return call('/v7/feeds/text', {
    method: 'POST',
    form: true,
    params: {
      content: String(content),
      circle_id: String(circleId ?? ''),
      anonymous: anonymous ? '1' : '0',
      user_id: cookies.hyuid ?? '',
      tid: tid ?? String(Date.now())
    },
    session
  });
}

/** 上传一张图到狐友图床，返回 { key, basename, picUrl }。 */
export async function uploadFeedImage(buffer, { session, filename = 'image.jpg', mime = 'image/jpeg', width = 0, height = 0 } = {}) {
  const { cookies } = session ?? loadSession(process.cwd());
  const fd = new FormData();
  fd.append('file_type', 'pic');
  fd.append('file_metas', JSON.stringify([{ w: width, h: height }]));
  fd.append('file', new Blob([buffer], { type: mime }), filename);

  const res = await fetch(`${API_BASE}/v5/upload/uploadFromFeed`, {
    method: 'POST',
    body: fd,
    headers: {
      token: cookies.pchytk ?? '',
      appid: APP_ID,
      'p-appid': P_APP_ID,
      's-vs': APP_KEY_VS,
      gid: cookies.gidinf ?? '',
      's-cid': cookies.gidinf ?? '',
      's-ppid': cookies.pchypp ?? '',
      's-pid': cookies.hyuid ?? ''
    },
    signal: AbortSignal.timeout(120000)
  });
  const body = await res.json().catch(() => ({}));
  if (body.status !== 100000) throw new Error(`图片上传失败: ${body.status} ${body.desc ?? ''}`);
  const key = body.data?.keys?.[0] ?? '';
  if (!key) throw new Error('图片上传成功但没返回 key');
  return {
    key,
    basename: key.split('/').pop(),
    picUrl: body.data?.files?.[0]?.picUrl ?? '',
    hasMetaAIGC: body.data?.hasMetaAIGC
  };
}

/**
 * 发一条带图动态。
 * 注意 dynamic_pic 里的 p 只放**文件名**（如 `1495...png`），不是完整路径 —— 这是实测抓包得出的。
 */
export async function publishDynamicFeed(content, { session, circleId, pics = [], tid } = {}) {
  const { cookies } = session ?? loadSession(process.cwd());
  return call('/v7/feeds/dynamic', {
    method: 'POST',
    form: true,
    params: {
      content: String(content),
      tid: tid ?? String(Date.now()),
      circle_id: String(circleId ?? ''),
      board_id: '',
      statement_code: '0',
      dynamic_pic: JSON.stringify(pics.map((p) => ({ p: p.p, w: p.w ?? 0, h: p.h ?? 0, f: '1' }))),
      user_id: cookies.hyuid ?? ''
    },
    session
  });
}

/** 删除自己发的一条动态。 */
export async function deleteFeed(feedId, { session } = {}) {
  const { cookies } = session ?? loadSession(process.cwd());
  return call('/v6/feeds/delete', {
    method: 'POST',
    form: true,
    params: { feed_id: String(feedId), user_id: cookies.hyuid ?? '' },
    session
  });
}

/** 删除自己的一条评论/回复（GET /v6/feeds/comment/remove）。 */
export async function removeComment(commentId, { session, logUserId } = {}) {
  const { cookies } = session ?? loadSession(process.cwd());
  return call('/v6/feeds/comment/remove', {
    params: {
      comment_id: String(commentId),
      log_user_id: String(logUserId ?? cookies.hyuid ?? '')
    },
    session
  });
}

/**
 * 读某条评论下的回复（楼中楼）。
 * 注意：`comment/list` 内嵌的 replies 最多只有 3 条，会漏；要完整必须走这个接口。
 */
export async function getReplyList(feedId, commentId, { count = 20, pageIndex = 0, session } = {}) {
  return call('/v8/comment/replylist', {
    params: {
      feed_id: String(feedId),
      comment_id: String(commentId),
      score: '0',
      stpl: '1,2,4,7,8,9,16',
      count: String(count),
      page_index: String(pageIndex)
    },
    session
  });
}
