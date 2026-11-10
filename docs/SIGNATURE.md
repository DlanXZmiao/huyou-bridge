# 狐友 Web 接口签名（已验证）

> 验证方式：拿 `2026-11-10 01:16:28` 抓到的一条真实评论请求的 `sig` 反推，
> 用下面的算法重算，**与服务器接受的签名逐字符相同**。

## 常量（前端 bundle 里的公开常量，不是偷来的密钥）

```js
appid       = 330012
app_key     = '1U32034rUs20A064'
app_key_vs  = '6.24.0'
```

来源：`https://hy.cdn.sohucs.com/hy-web/prod/_nuxt/Cq8Xo50L.js`
里的 `Nn={appid:330012,app_key_vs:"6.24.0",app_key:"1U32034rUs20A064"}`。

## 算法

前端实现（函数名 `signDataWithCoreServer`）：

```js
function sign(params, opts) {
  // 1) 补三个固定参数
  params.flyer = opts?.flyer || Date.now();
  params.appid = 330012;
  params.app_key_vs = '6.24.0';

  // 2) 展开成 "k=v"，跳过 null 和 File
  const pairs = [];
  for (const k in params) {
    if (params[k] == null) continue;
    pairs.push(`${k}=${params[k]}`);
  }

  // 3) 如果这次请求带了 s-nonce，把它和版本号也纳入签名
  if (opts?.['s-nonce']) {
    pairs.push(`s-nonce=${opts['s-nonce']}`);
    pairs.push(`S-VS=${opts['S-VS'] ?? opts['s-vs']}`);
  }

  // 4) 字典序排序，末尾拼 app_key，取 md5
  pairs.sort();
  return md5(pairs.join('') + '1U32034rUs20A064');
}
```

注意两点：

- **排序在拼 `app_key` 之前**，所以 `app_key` 永远在最后；
- 排序是**整串** `k=v` 的字典序（大小写敏感，`S-VS=...` 会排在所有小写 key 前面），不是按 key 排。

## 已验证的测试向量

请求（真实抓包）：

```
POST https://cs-ol.sns.sohu.com/v8/comment/text
content-type: application/x-www-form-urlencoded

feed_id=1495689332906984704&comment_type=comment&content=打车确实贵
&tid=1794244583268&flyer=1794244583268&appid=330012&app_key_vs=6.24.0
```

请求头里带 `s-nonce: 1a1c14f9f64b66185306921c89571ef5`、`s-vs: 6.24.0`。

参与签名的串（已排序）：

```
S-VS=6.24.0
app_key_vs=6.24.0
appid=330012
comment_type=comment
content=打车确实贵
feed_id=1495689332906984704
flyer=1794244583268
s-nonce=1a1c14f9f64b66185306921c89571ef5
tid=1794244583268
```

拼接后加 `1U32034rUs20A064`，md5 得到：

```
13085345ff75fea06fee70db91eddae6   ← 与抓包一致
```

要点：`content` 参与签名时是**原文（中文未编码）**，URL 编码只发生在序列化进 body 时。

## 其它必需请求头

| 头 | 值 | 说明 |
|---|---|---|
| `token` | 登录后拿到的 JWT（`eyJ...`） | 放 header，不放 query |
| `appid` | `330012` | |
| `p-appid` | `110503` | |
| `s-vs` | `6.24.0` | |
| `s-nonce` | 每次请求随机 32 位十六进制 | 参与签名 |
| `flyer` | 时间戳（毫秒字符串） | 参与签名 |
| `s-cid` / `gid` | cookie **`gidinf`**（`x099…`） | 缺了写接口返回 `200003 userId \|\| token \|\| gid` |
| `s-ppid` | cookie **`pchypp`**（`…@sohu.com`） | 同上，缺了也 200003 |
| `s-pid` | cookie **`hyuid`**（19 位用户 id） | |
| `Referer` | `https://w.sohu.com/` | |
| `Origin` | `https://w.sohu.com` | 仅跨域预检 |

## 接口清单

| 用途 | 方法与路径 |
|---|---|
| 发评论 | `POST /v8/comment/text`（form-urlencoded） |
| 评论列表 | `GET /v8/comment/list?feed_id=&stpl=1,2,4,7,8,9,16&score=0&count=20` |
| 帖子详情 | `GET /v7/feeds/show?feed_id=` |
| 登录（短信） | `POST /user/mobile/login/v20` |

成功响应形如：

```json
{"data":{"commentId":"1495689608711832960","content":"打车确实贵","userId":"…","anonymous":true,"status":1},"status":100000,"desc":"评论成功"}
```

判定成功看 `status === 100000`。

## 写接口验证记录（2026-11-10）

用 `src/api.js` 纯 Node 发出一条真实评论：

```json
POST /v8/comment/text
{"status":100000,"desc":"评论成功","data":{"commentId":"1495691065280366464"}}
```

回读 `/v8/comment/list` 确认该 commentId 已在列表首位。

- 首次失败：`{"status":200003,"desc":"userId || token || gid"}` —— 原因是 `s-cid`/`s-ppid` 取错了 cookie（应为 `gidinf` / `pchypp`）。
- 删除评论的接口：`/v6/feeds/comment/remove`（已在前端 bundle 中确认存在，尚未实测）。
