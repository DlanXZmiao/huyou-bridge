# 狐友评论接口（P0 抓包）

> 生成时间：2026/11/10 01:16:28　采集 6 条　评论提交 1 条

## 说明

本文由 `src/login.mjs` 在登录/发评论过程中自动生成。**凭据已脱敏**，完整原始包在 `state/capture/`（不入库）。

## 发表评论（提交）

### POST 200

```
https://cs-ol.sns.sohu.com/v8/comment/text
```

请求头（脱敏）：

```json
{
  "appid": "330012",
  "sec-ch-ua-platform": "\"Windows\"",
  "s-ppid": "<your-ppid>",
  "sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\"",
  "p-appid": "110503",
  "sec-ch-ua-mobile": "?0",
  "s-cid": "<your-gid>",
  "baggage": "sentry-environment=hyweb_prod,sentry-public_key=8d20b41cbc89834c6da0bc4dc879fa4f,sentry-trace_id=c2e4b8d9a244493e8399a53a3432b2bc,sentry-transaction=%2F,sentry-sampled=false,sentry-sample_rand=0.2179466050507458,sentry-sample_rate=0.05",
  "s-pid": "<your-uid>",
  "sentry-trace": "c2e4b8d9a244493e8399a53a3432b2bc-bdcab9aebc705052-0",
  "accept": "application/json",
  "content-type": "application/x-www-form-urlencoded",
  "token": "eyJleHAiOjE3…<redacted>",
  "Referer": "https://w.sohu.com/",
  "s-nonce": "1a1c14f9f64b66185306921c89571ef5",
  "flyer": "1794244583268",
  "s-vs": "6.24.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "gid": "<your-gid>"
}
```

请求体（脱敏）：

```
feed_id=1495689332906984704&comment_type=comment&content=%E6%89%93%E8%BD%A6%E7%A1%AE%E5%AE%9E%E8%B4%B5&tid=1794244583268&flyer=1794244583268&appid=330012&app_key_vs=6.24.0&sig=13085345ff75fea06fee70db91eddae6
```

响应预览：

```
{"data":{"contentIsSub":false,"timeId":1794244585971,"likeCount":0,"avatar":"https://edc3f09a7c333.cdn.sohucs.com/anon/v2/anon34.png","stpl":4,"userName":"质朴的石破天","userId":"<your-uid>","liked":false,"content":"打车确实贵","highlight":false,"replyCount":0,"at":[],"sourceRegion":"广东","commentId":"1495689608711832960","anonymous":true,"status":1},"status":100000,"desc":"评论成功"}
```

## 评论/帖子读取（参考）

### OPTIONS 200

```
https://cs-ol.sns.sohu.com/v8/comment/list?feed_id=1495689332906984704&stpl=1,2,4,7,8,9,16&score=0&count=20&flyer=1794244569593&appid=330012&app_key_vs=6.24.0&sig=636c5fe2e05b6ca0de03e49d471df6cf
```

请求头（脱敏）：

```json
{
  "Accept": "*/*",
  "Access-Control-Request-Headers": "appid,baggage,flyer,gid,p-appid,s-cid,s-nonce,s-pid,s-ppid,s-vs,sentry-trace,token",
  "Access-Control-Request-Method": "GET",
  "Origin": "https://w.sohu.com",
  "Sec-Fetch-Mode": "cors",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
}
```

请求体（脱敏）：

```
(无)
```

响应预览：

```

```

### GET 200

```
https://cs-ol.sns.sohu.com/v8/comment/list?feed_id=1495689332906984704&stpl=1,2,4,7,8,9,16&score=0&count=20&flyer=1794244569593&appid=330012&app_key_vs=6.24.0&sig=636c5fe2e05b6ca0de03e49d471df6cf
```

请求头（脱敏）：

```json
{
  "appid": "330012",
  "sec-ch-ua-platform": "\"Windows\"",
  "s-ppid": "<your-ppid>",
  "sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\"",
  "p-appid": "110503",
  "sec-ch-ua-mobile": "?0",
  "s-cid": "<your-gid>",
  "baggage": "sentry-environment=hyweb_prod,sentry-public_key=8d20b41cbc89834c6da0bc4dc879fa4f,sentry-trace_id=c2e4b8d9a244493e8399a53a3432b2bc,sentry-transaction=%2F,sentry-sampled=false,sentry-sample_rand=0.2179466050507458,sentry-sample_rate=0.05",
  "s-pid": "<your-uid>",
  "sentry-trace": "c2e4b8d9a244493e8399a53a3432b2bc-b1dadce374137258-0",
  "content-type": "application/x-www-form-urlencoded",
  "token": "eyJleHAiOjE3…<redacted>",
  "Referer": "https://w.sohu.com/",
  "s-nonce": "1a1c14f69f934f27203ecf24a2d54127",
  "flyer": "1794244569593",
  "s-vs": "6.24.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "gid": "<your-gid>"
}
```

请求体（脱敏）：

```
(无)
```

响应预览：

```
{"data":{"pageInfo":{"hasMore":false,"totalCount":0,"infoCount":0},"jumpIndex":0,"filters":[],"list":[]},"status":100000,"desc":"success"}
```

### OPTIONS 200

```
https://cs-ol.sns.sohu.com/v8/comment/text
```

请求头（脱敏）：

```json
{
  "Accept": "*/*",
  "Access-Control-Request-Headers": "appid,baggage,flyer,gid,p-appid,s-cid,s-nonce,s-pid,s-ppid,s-vs,sentry-trace,token",
  "Access-Control-Request-Method": "POST",
  "Origin": "https://w.sohu.com",
  "Sec-Fetch-Mode": "cors",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
}
```

请求体（脱敏）：

```
(无)
```

响应预览：

```

```
