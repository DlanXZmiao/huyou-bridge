# 狐友评论器（huyou-bridge）

> **非官方项目**：与搜狐 / 狐友无任何隶属关系，仅用于个人学习与研究。
>
> **风险自负**：自动化操作可能违反平台用户协议，可能导致账号被限流或封禁。请勿用于商业用途、批量刷量或骚扰他人。
>
> **不含凭据**：本仓库不包含任何登录态。`state/`（含 `session.json` 里的 cookie）已在 `.gitignore` 中排除，需自行运行 `login.bat` 用**自己的账号**生成。

让 DSH 读取狐友（<https://w.sohu.com>）公开信息流，按设定人设生成并提交评论。
**独立项目**：不依赖、不 import `qq-bridge`，只复制它的 `dsh-client.js`。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 起隔离浏览器 → 短信登录 → 抓评论接口 | ✅ 完成（接口与签名已验证） |
| P1 | 登录态固化 + 只读拉流 | ✅ 完成（`feed.js` / `api.js`） |
| P2 | 评论提交 + 回读校验 + 配额 | ✅ 完成（`comment.js` / `gates.js` / `state.js`） |
| P3 | 模型决策 + 调度循环（`decide.js` / `scheduler.js`） | ✅ 完成（dry-run 可用） |
| P4 | 设置页 + 接进 DSH | ✅ 完成（插件 `huyou-agent-tools`，工具已在 DSH 可用） |

**现在可以做**：在 DSH 会话里直接问"狐友上有什么"（通过 `huyou_*` 工具），或者在设置页调人设/配额，
由调度器自动跑；也可以让 agent 用 `huyou_draft_comment` 做发送前预检。

## 配置模型 Key

模型调用是纯 HTTP（`api.deepseek.com`），不经过 DSH，也不依赖任何 SDK。Key 按这个顺序查找：

1. 环境变量 `DEEPSEEK_API_KEY`
2. `config.json` 的 `llm.apiKey`
3. `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`（只有本机装了 DSH 才会走到这一步）

clone 之后用前两种之一即可：

```powershell
# 方式一：环境变量（当前窗口有效）
$env:DEEPSEEK_API_KEY = "sk-你的key"
node src/scheduler.js --once
```

```powershell
# 方式二：复制模板，把 key 填进 config.json 的 llm.apiKey
copy config.example.json config.json
```

`config.json` 已在 `.gitignore` 里排除，不会误提交；`config.example.json` 的 `apiKey` 是空串。
没配 key 时会直接报错提示，不会静默失败。

## DSH 插件

```powershell
node scripts/setup-dsh.mjs desktop   # 装进 DSH profile（幂等）
node scripts/test-mcp.mjs            # 不依赖 DSH，直接验证 MCP server
```

装完后 DSH 里会出现这些工具：

| 工具 | 类型 | 作用 |
|---|---|---|
| `huyou_status` | 只读 | 登录态、模式、配额、今日已发、是否熔断 |
| `huyou_feed` | 只读 | 拉推荐流（最多 20 条） |
| `huyou_feed_detail` | 只读 | 单条帖子详情 |
| `huyou_comments` | 只读 | 某条帖子的评论 |
| `huyou_draft_comment` | 只读 | 评论草稿的闸门预检（不发送） |
| `huyou_send_comment` | **写** | 真发；默认禁用，需 `config.json` 的 `mcp.allowSend: true` + 显式 `confirm=true` |

> 写操作默认关闭是故意的：狐友信息流里是陌生人的真实内容，模型可以读，但不应该能直接发布。

## 发帖

设置页「发帖」卡片：

- **手动**：点「立即发帖」（二次确认）
- **每天定时**：选「每天定时」并填 `HH:MM`，调度器在到点后的 90 分钟内发一条（当天只发一次）

内容格式：周礼体一段 + 白话一段；配图从 `表情包/` 随机挑一张。

实测可用的接口：

| 用途 | 接口 | 要点 |
|---|---|---|
| 图片上传 | `POST /v5/upload/uploadFromFeed` | multipart：`file_type=pic`、`file_metas=[{w,h}]`、`file` |
| 带图发帖 | `POST /v7/feeds/dynamic` | `dynamic_pic` 里的 `p` 只放**文件名**，不是路径 |
| 纯文字 | `POST /v7/feeds/text` | `content` + `circle_id` + `user_id` + `tid` |
| 删帖 | `POST /v6/feeds/delete` | `feed_id` + `user_id` |

## 上下文清理

本地会累积评论记录、楼中楼线程、发帖记录和判定缓存。设置页「上下文清理」可以：

- **手动**：点「立即清理」，删掉超过 N 小时（默认 48）的本地记录；
- **自动**：勾「每天自动清理」并填时间（默认 03:30），调度器到点后清理一次。

只删 `state/activity.json` 里的本地记录，不动狐友上的任何内容。

命令行：`node scripts/cleanup.mjs --hours 48 [--dry-run]`

## 只看指定圈子

在设置页「配额与模式」里有一个「只看这些圈子」输入框，每行一个，可以是名字或 ID：

```
汕大树洞
905956136904237440
```

- **填 ID 最准**：会直接抓 `https://w.sohu.com/circle/<id>` 的服务端渲染页面，一次能拿 20+ 条该圈帖子。
- **填名字**只对推荐流里出现的帖子生效（推荐流是随机抽的，命中率低）。
- 留空 = 不过滤，看全部推荐流。

为什么不用官方圈子接口：`/v8/circle/feed/list` 实测对多个圈子都返回 `status:100000` 但 0 条（大概率要求是圈子成员），而圈子页 SSR 对匿名访问也完整。

## 常用命令

```powershell
node scripts/verify-api.mjs            # 只读：验证登录态与签名是否可用
node scripts/dry-run.mjs --limit 5     # 只读：拉推荐流看数据长什么样
node scripts/dry-run.mjs --feed <id> --text "……"   # 只跑闸门，不发
node src/scheduler.js --once           # 跑一轮决策，dry-run（不发）
node src/scheduler.js --once --send    # 跑一轮并真发（默认最多 1 条/轮）
node src/scheduler.js --loop           # 常驻：每 pollIntervalMs 一轮
node src/console.js                    # 打开设置页（终端会打印带 token 的地址）
node scripts/post-comment.mjs --feed <id> --text "……" --send   # 手动发一条
npm test                              # 闸门 + 解析器 + 决策层单测
```

本目录目前只有骨架：目录结构、设置模板、配置模板。**没有任何可运行代码。**

## 目录

```
狐友/
├── settings/          ← 你（或设置页）编辑的人设与策略，改完即时生效
│   ├── persona.md     #   人设：名字/设定/语气/示例/禁语
│   ├── policy.md      #   评论策略：可以评什么、绝不评什么
│   └── quota.json     #   每天几条、每小时几条、长度、模式
├── config.example.json# 工程配置（接口域名、闸门词表），复制成 config.json 使用
├── src/               # 登录、HTTP、评论管道、设置页（待写）
├── scripts/           # 抓包/测试/安装脚本（待写）
├── public/            # 设置页前端（待写）
├── dsh/               # huyou-v2 preset 源（待写）
├── plugins/           # DSH bundle（待写）
├── fixtures/          # 抓包存档，用于改版回归
├── docs/              # 接口文档（P0 产出）
└── state/             # 运行时：登录态、水位、日志、STOP 开关（不入库）
```

## 设计要点

1. **人设不进 DSH preset**，每轮从 `settings/` 读取后拼进 prompt —— 网页保存后下一轮立即生效，不用重启 DSH，也不会被 DSH 重写 `cordis.patch.yml` 时弄丢。
2. **模型只产出评论文本，提交权在 bridge**。模型即便被注入，也发不出去。
3. **硬闸门在代码里**：敏感话题词表、长度、复述率、模板词、相似度、配额、熔断，模型绕不过去。
4. **默认 dry-run**：`quota.json` 里 `dryRun: true` 时只打印"将要发什么"，不真发。确认满意后改 `false`。

## 安全边界（不做）

- 同一帖下多次评论、连续跟评同一个人
- 主动私信、关注、批量点赞
- 评论敏感话题（代码级拦截，改 policy 也不生效）
- 绕过验证码 / 硬撞风控
- 无上限、无限速、关掉熔断的版本

## 停机

在 `state/` 下建一个名为 `STOP` 的文件即可立即停止（优先级高于配置）。

## 下一步

P0：`node src/login.mjs` 起隔离 Chrome → 手机号 + 短信验证码登录 → 抓一条评论请求 → 产出 `docs/COMMENT_API.md`。
