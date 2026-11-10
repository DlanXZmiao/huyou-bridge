# 带图发帖抓包

生成时间：2026/11/10 13:46:00　共 4 条

## OPTIONS 200

```
https://cs-ol.sns.sohu.com/v5/upload/uploadFromFeed
```

请求头：
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

请求体：
```
(无)
```

响应：
```

```

## POST 200

```
https://cs-ol.sns.sohu.com/v5/upload/uploadFromFeed
```

请求头：
```json
{
  "appid": "330012",
  "sec-ch-ua-platform": "\"Windows\"",
  "S-PPID": "<your-ppid>",
  "sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\"",
  "P-APPID": "110503",
  "sec-ch-ua-mobile": "?0",
  "S-CID": "<your-gid>",
  "baggage": "sentry-environment=hyweb_prod,sentry-public_key=8d20b41cbc89834c6da0bc4dc879fa4f,sentry-trace_id=a266d619c18607704115744589da8e12,sentry-sampled=false,sentry-sample_rand=0.6947233048685808,sentry-sample_rate=0.05",
  "S-PID": "<your-uid>",
  "sentry-trace": "a266d619c18607704115744589da8e12-998c3afad43e7e30-0",
  "Content-Type": "multipart/form-data; boundary=----WebKitFormBoundaryi9JGg7FabDpJtwnM",
  "token": "<redacted>",
  "Referer": "https://w.sohu.com/",
  "s-nonce": "1a1c3fdc69a5940198f4d6138150b56f",
  "flyer": "1794289551002",
  "S-VS": "6.24.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "gid": "<your-gid>"
}
```

请求体：
```
(无)
```

响应：
```
{"status":100000,"desc":"success","data":{"s3_pic_domain":"sns-feed.bjcnc.img.sohucs.com","hasMetaAIGC":"0","keys":["pic/20261110/1495878222909291520.png"],"files":[{"picUrl":"https://d040779c2cd49.cdn.sohucs.com/pic/20261110/1495878222909291520.png","fileName":"微信图片_20261109210504_415_3.png","fileSize":"2473184","key":"pic/20261110/1495878222909291520.png"}]}}
```

## OPTIONS 200

```
https://cs-ol.sns.sohu.com/v7/feeds/dynamic
```

请求头：
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

请求体：
```
(无)
```

响应：
```

```

## POST 200

```
https://cs-ol.sns.sohu.com/v7/feeds/dynamic
```

请求头：
```json
{
  "appid": "330012",
  "sec-ch-ua-platform": "\"Windows\"",
  "s-ppid": "<your-ppid>",
  "sec-ch-ua": "\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"157\", \"Chromium\";v=\"157\"",
  "p-appid": "110503",
  "sec-ch-ua-mobile": "?0",
  "s-cid": "<your-gid>",
  "baggage": "sentry-environment=hyweb_prod,sentry-public_key=8d20b41cbc89834c6da0bc4dc879fa4f,sentry-trace_id=a266d619c18607704115744589da8e12,sentry-sampled=false,sentry-sample_rand=0.6947233048685808,sentry-sample_rate=0.05",
  "s-pid": "<your-uid>",
  "sentry-trace": "a266d619c18607704115744589da8e12-99f08f5cb9be9f84-0",
  "accept": "application/json",
  "content-type": "application/x-www-form-urlencoded",
  "token": "<redacted>",
  "Referer": "https://w.sohu.com/",
  "s-nonce": "1a1c3fdd2eff40dfeb10c78c5fd107e4",
  "flyer": "1794289554159",
  "s-vs": "6.24.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "gid": "<your-gid>"
}
```

请求体：
```
content=%E4%BD%A0%E5%A5%BD&tid=1794289554158&circle_id=905956136904237440&board_id=&statement_code=0&dynamic_pic=%5B%7B%22p%22%3A%221495878222909291520.png%22%2C%22w%22%3A1086%2C%22h%22%3A1448%2C%22f%22%3A%221%22%7D%5D&user_id=<your-uid>&flyer=1794289554159&appid=330012&app_key_vs=6.24.0&sig=1d5ef8f932ba50d5dffcac61681bce3a
```

响应：
```
{"data":{"newFeedId":"1495878228815054080","content":"你好"},"status":100000,"desc":"success"}
```
