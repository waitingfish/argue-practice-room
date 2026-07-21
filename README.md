# 吵架练习室

需要 Node.js 22.5 或更高版本。运行：`npm start`

打开 `http://127.0.0.1:4173`，在“后台配置”中填写文案模型的 OpenAI Chat Completions 兼容接口、模型名和 API Key。

接口地址支持两种写法：

- 根地址或版本地址，例如 `https://api.openai.com/v1`
- 完整接口地址，例如 `https://api.openai.com/v1/chat/completions`

常见 OpenAI 兼容模型服务商只要提供 `base_url`、模型名和 API Key，一般都可以直接填入。比如 DeepSeek、通义千问百炼、Moonshot、智谱、OpenRouter、SiliconFlow 等，按各自控制台给出的 OpenAI 兼容地址填写即可。后台的“测试对话”和“测试图片”会分别使用当前表单内容，不需要先保存。

练习对话接口会使用 OpenAI Chat Completions 的流式模式，也就是请求体会带上 `stream: true`。前台会边接收边显示回复；如果某个兼容服务商忽略流式参数并返回普通 JSON，服务端会自动兜底读取完整结果。

## 三智能体架构

每次练习包含三个职责和上下文相互隔离的智能体：

- 争吵方：只扮演场景中的对方，使用会话消息接口流式回应，不输出建议或复盘。
- 帮忙专家：用户开启“找人帮忙”后，使用独立会话接口流式给出判断、策略和一句可直接使用的表达。专家建议不会写入争吵方上下文。
- 复盘分析师：用户完成至少两轮表达并点击“结束并复盘”后，从数据库读取完整争吵记录和独立专家记录，输出结构化过程分析、四项沟通评分、沟通倾向、优势、风险和下一步练习。

复盘中的“性格分析”只描述本次文字练习显示出的沟通倾向，不做心理诊断或固定人格判断。每条倾向必须逐字引用用户发言中的连续原文；服务端会验证证据确实存在，不匹配时自动要求模型重做一次，仍不匹配则用真实用户原文修复或降级为样本不足。只有一轮用户表达时，分析接口返回 `400`，避免根据过少样本强行下结论。

浏览器不再回传对话历史，只提交会话令牌和本轮内容。服务端从 SQLite 读取可信场景与历史，因此用户修改前端请求不能替换三个智能体的系统提示词或读取其他会话。三个角色可以暂时共用后台配置的同一个 OpenAI-compatible 模型服务，但调用、提示词和上下文完全分开。

## 多用户与持久化会话

项目使用 Node 内置 SQLite，数据库位于 `data/app.db`，启用了 WAL、外键和 5 秒 busy timeout。数据库保存：

- 匿名练习会话和令牌哈希
- 用户、争吵方和帮忙专家的消息
- 按消息版本缓存的复盘报告
- 一句话生成场景的任务状态

每个页面标签使用 `sessionStorage` 保存自己的 `sessionId` 和明文会话令牌。刷新后会恢复同一会话；新打开的独立标签会创建新会话。数据库只保存令牌 SHA-256 哈希，错误令牌无法读取会话。

主要会话接口：

- `POST /api/sessions`：为指定场景创建匿名会话
- `GET /api/sessions/:id`：恢复会话及全部消息
- `PATCH /api/sessions/:id`：开关帮忙专家
- `POST /api/sessions/:id/messages`：保存用户消息并流式返回争吵方回复
- `POST /api/sessions/:id/coach`：流式返回并保存专家建议
- `POST /api/sessions/:id/analyze`：生成或读取当前消息版本的复盘报告

除创建接口外，所有会话接口都要求 `X-Session-Token`。消息接口同时要求唯一 `requestId`，网络重试不会重复写入。同一会话通过带过期时间的数据库锁串行处理；不同会话不会持有共同事务，可以同时调用模型。

默认仍只监听 `127.0.0.1`。部署给局域网或外部用户时可运行：

```bash
HOST=0.0.0.0 PORT=4173 npm start
```

公网部署还应在前面配置 HTTPS 反向代理、用户登录、分布式限流和更可靠的后台身份认证。当前匿名令牌方案支持多用户会话隔离，但不等同于正式账号系统。

内置场景有独立地址：`/scene/family`、`/scene/restaurant`、`/scene/night`。`/create` 用于创建新场景：页面先创建持久生成任务，文案模型生成叙事、角色提示词和图片提示词，图片模型随后调用 `/images/generations` 生成画面；所有内容校验并原子发布后，页面才会跳转到 `/scene/scene-...`。

## 场景生成任务

生成采用异步任务架构：

1. `POST /api/scene-jobs` 创建任务，必须携带 `Idempotency-Key`，返回 `202`、`jobId` 和 `eventsUrl`。
2. `GET /api/scene-jobs/:jobId/events` 使用 SSE 推送 `queued`、`generating_text`、`generating_image`、`validating`、`publishing`、`completed` 或 `failed`。
3. `GET /api/scene-jobs/:jobId` 是状态查询和 SSE 断线后的轮询兜底。
4. 前端把当前任务保存在 `localStorage`，刷新页面后会继续订阅；收到 `completed` 后自动进入 `sceneUrl`。

相同 `Idempotency-Key` 始终返回同一个任务，避免浏览器重试造成重复调用和重复扣费。服务重启时会扫描未完成任务：已保存的文案或图片会继续复用，已经发布但尚未更新任务状态的场景会补记为完成。

任务状态保存在 SQLite 的 `scene_jobs` 表，不可见的生成中间产物保存在 `data/staging/`。生成成功前，场景配置和图片都只存在于暂存目录；完整性检查通过后，整个目录通过同一文件系统内的 `rename` 一次性发布到：

```text
scene-configs/generated/<sceneId>/
  scene.json
  background.png | background.jpg | background.webp
```

场景读取接口只读取已发布目录，图片只通过 `/scene-assets/<sceneId>/background.*` 提供。任何阶段失败都会将任务标记为 `failed` 并清理暂存目录，不会出现可访问的半成品。外部模型调用产生的费用无法回滚，因此这里保证的是“发布原子性”，不是外部服务调用的事务回滚。

场景配置统一保存在 `scene-configs/` 文件夹。每个场景一个 JSON 文件，字段包括：

- `title`、`kicker`、`intro`、`introLines`：页面叙事与背景文案
- `opponent`：争吵方第一句
- `opponentPrompt`：争吵方的人设与对话方式
- `coachPrompt`：AI 教练在这个场景里的指导重点
- `analysisPrompt`：复盘分析师在这个场景里重点观察的表达模式
- `art`：场景图片路径
- `artPrompt`：生成场景图片时使用的提示词

内置场景和用户通过“一句话生成场景”创建的场景都会走同一套配置结构。内置场景仍是 `scene-configs/*.json`；生成场景使用上面的独立场景包，便于完整迁移、备份和清理。

图片模型可复用文案 API Key，也可以在后台单独填写图片接口地址、模型名、超时秒数和 API Key。图片接口需要兼容 OpenAI Images API，并返回 `b64_json` 或可下载的 `url`。图片地址同样可以填根地址，例如 `https://api.openai.com/v1`，也可以填完整的 `/images/generations` 地址。图片生成通常比对话慢，默认超时为 180 秒，可在后台调整为 30 到 300 秒。

“测试图片”会实际调用一次图片生成接口，但不会把测试图片保存到项目里。这个测试可能消耗对应服务商的图片生成额度。

首次后台访问码为 `admin`，保存模型配置后请立即修改。配置文件仅保存在 `data/config.json`，服务只监听本机地址，密钥不会下发给浏览器。

静态文件服务使用公开白名单，`data/`、任务记录和场景内部配置不能通过 URL 直接读取。模型或图片生成异常会在服务端输出包含 `jobId`、`sceneId`、生成阶段、模型接口和错误堆栈的日志，但不会打印 API Key。

## 开发期迁移

项目当前处于基础开发阶段，不在运行时保留旧原型兼容分支。旧配置或旧数据结构使用一次性脚本迁移：

```bash
npm run migrate
```

迁移脚本会处理旧双角色 `systemPrompt`、旧 `data/jobs/*.json` 任务记录，以及旧 `data/scenes/*.json` 场景配置。迁移后服务端只读取当前结构：`scene-configs/*.json`、`scene-configs/generated/*/scene.json` 和 SQLite。
