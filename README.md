# 吵架练习室

一个用于练习冲突表达的 AI 对话网页原型。它不是“骂人生成器”，而是一个冲突表达训练室：用户选择或生成一个争吵场景，和争吵方进行多轮对话；需要时可以开启“找人帮忙”，让 AI 教练给下一步表达建议；结束后由复盘分析师总结表达过程和沟通倾向。

项目目前处于基础开发阶段，重点是验证交互、多智能体架构、场景生成和多会话持久化能力。

## 技术栈

- 前端：原生 HTML、CSS、JavaScript
- 后端：Node.js 原生 `http` 服务
- 数据库：Node 内置 `node:sqlite`，使用 SQLite 持久化会话、消息、复盘和场景生成任务
- AI 对话：OpenAI Chat Completions 兼容接口
- AI 图片：OpenAI Images API 风格的 `/images/generations` 兼容接口
- 语音识别：本地 `whisper.cpp`，或 OpenAI Audio Transcriptions 兼容接口
- 语音合成：OpenAI Audio Speech 兼容接口，或小米 MiMo Chat 音频协议
- 流式返回：服务端使用 `stream: true` 调用对话模型，前端边接收边展示
- 本地缓存：`sessionStorage` 保存当前标签页会话，`localStorage` 保存用户本地创建过的场景记录

需要 Node.js `22.5` 或更高版本。

## 快速运行

```bash
npm start
```

默认访问：

```text
http://127.0.0.1:4173
```

后台配置页：

```text
http://127.0.0.1:4173/admin.html
```

首次后台访问码为 `admin`。配置文件保存在 `data/config.json`，其中可能包含 API Key，已被 `.gitignore` 忽略，不应提交到 GitHub。

## 模型配置

后台支持填写 OpenAI 兼容模型服务商：

- 对话接口地址：可填根地址、`/v1` 地址，或完整 `/chat/completions` 地址
- 对话模型名称
- 对话 API Key
- 图片接口地址：可填根地址、`/v1` 地址，或完整 `/images/generations`、`/images/edits` 地址；服务商必须同时支持图片生成和图片编辑
- 图片模型名称
- 图片 API Key
- 图片生成超时时间
- 语音识别模式、接口地址、模型、API Key 和超时时间
- 语音合成接口地址、模型、声音、格式、API Key 和超时时间

常见 OpenAI 兼容服务商只要提供 `base_url`、模型名和 API Key，一般都可以接入。后台提供“测试对话”和“测试图片”，两者分开测试，便于排查模型服务商问题。

## 实现流程

1. 用户进入首页并选择场景，再选择“训练模式”或“沉浸模式”。
2. 创建新场景时，前端先创建持久生成任务，并通过 SSE 订阅任务进度。
3. 文案模型根据用户描述和“对方性别”生成场景标题、三句字幕、争吵方开场、四个智能体提示词、胜利条件和三类图片提示词。
4. 图片模型先根据 `thumbnailArtPrompt` 生成包含完整环境和对方角色的视觉母图，并直接作为首页小图；随后把母图作为图片输入，结合 `artPrompt` 编辑派生无人沉浸背景，再结合 `opponentArtPrompt` 编辑派生同一角色。右侧人物的编辑 prompt 会追加服务端固定的 `#00ff00` 绿幕约束，最后抠成透明 PNG。三个步骤各自最多尝试两次。
5. 服务端先把文案和图片写入 `data/staging/` 暂存目录，校验完整后再原子发布到 `scene-configs/generated/<sceneId>/`。
6. 场景页面创建匿名练习会话，服务端把会话、消息和复盘持久化到 SQLite。
7. 用户与争吵方对话时，服务端从数据库读取可信上下文并调用争吵方智能体流式返回。
8. 用户开启“找人帮忙”后，AI 教练使用独立上下文给出建议，不污染争吵方上下文。
9. 沉浸模式每轮结束后，裁判只读取当前会话和新增轮次，判断是否达到场景胜利条件，并持久化判决。
10. 裁判判赢后，页面展示争吵成果和即时心理状态文案，再由用户决定是否生成复盘报告。
11. 用户结束练习后，复盘分析师读取争吵记录和教练建议，生成过程分析、评分、沟通倾向和下一步建议。
12. 沉浸模式会先朗读争吵方开场，再循环执行浏览器录音、语音识别、争吵方流式回复、裁判判定和语音合成播放；该模式不启用帮忙专家。

## 已实现功能

- 三个内置场景：家庭边界、餐厅烟雾、深夜对峙
- 每个场景拥有独立 URL，例如 `/scene/phone-night`
- 用户一句话生成新场景
- 场景生成任务支持 SSE 进度推送和轮询兜底
- 场景发布具备原子性，失败时不会暴露半成品
- OpenAI Chat Completions 兼容对话模型配置
- OpenAI Images API 风格图片模型配置
- 对话模型和图片模型分开测试
- 争吵方、帮忙专家、裁判、复盘分析师四个智能体职责解耦
- 对话流式返回
- 多用户匿名会话隔离
- SQLite 持久化会话、消息、复盘和生成任务
- 获胜后可保存双方文字与语音，并通过独立回放链接分享
- 同一会话内请求加锁，避免并发写入错乱
- `requestId` 幂等写入，降低重试导致的重复消息风险
- 本地缓存用户创建过的场景，首页最多展示 3 个最新记录
- Enter 发送消息，Shift+Enter 换行
- 每个场景支持训练模式和沉浸语音模式
- 沉浸模式首句自动朗读，支持一轮一轮录音、识别、回复和播放
- 沉浸模式逐轮裁判，判赢后展示成果与即时心理状态，并提供复盘入口
- 本地 whisper.cpp 与 OpenAI 兼容语音识别可切换
- 语音识别和语音合成可分别测试
- MiMo TTS 优先使用 `stream:true` + `pcm16` 低延迟流式播放，失败时回退到完整音频播放
- 后台异常和模型异常会在服务端打印日志，但不会打印 API Key
- `.gitignore` 已忽略运行时数据、密钥、数据库和用户生成场景

## 多智能体设计

项目包含四个职责分离的智能体；训练模式使用争吵方、帮忙专家和复盘分析师，沉浸模式使用争吵方、裁判和复盘分析师：

- 争吵方：只扮演当前场景中的对方，继续推进冲突，不输出建议或复盘。
- 帮忙专家：用户点击“找人帮忙”后，只站在用户身边提供下一步策略和一句可直接说出口的话。
- 裁判：沉浸模式每轮检查对方是否真正接受边界或承诺行动；不把辱骂、压制、敷衍或沉默当作胜利，并谨慎估计用户当下的心理状态。
- 复盘分析师：练习结束后，只分析已经发生的对话，输出结构化复盘和沟通倾向。

复盘中的“性格分析”只描述本次文字练习显示出的沟通倾向，不做心理诊断或固定人格判断。服务端会检查模型引用的证据是否来自用户真实原文；如果模型引用不合格，会要求模型重做，仍不合格则使用真实用户原文修复或降级为样本不足。

## 本地语音识别

项目使用官方 `whisper.cpp` 的 `whisper-server` 拉通本地识别。首次安装需要 `git`、`cmake` 和网络：

```bash
npm run voice:setup
npm run voice:start
```

然后在后台选择“本地 whisper.cpp”，识别地址填写 `http://127.0.0.1:8080/inference`，点击“测试语音识别”。默认下载多语言 `base` 模型；模型和编译产物保存在 `.local/`，不会提交到 GitHub。

若使用云端服务商，选择“OpenAI 兼容接口”，填写服务商根地址或 `/v1` 地址、模型和独立 API Key。服务端会以 multipart/form-data 调用 `/audio/transcriptions`。

标准 OpenAI 语音输出调用服务商的 `/audio/speech`。小米 MiMo 音频模型需要在后台选择“MiMo Chat 音频协议”：ASR 使用 `mimo-v2.5-asr`，TTS 使用 `mimo-v2.5-tts` 和 `mimo_default` 音色，两者都调用 `/chat/completions`，可复用对话 API Key。MiMo TTS 会优先使用 `stream:true` 和 `pcm16` 返回 24kHz PCM16LE mono 音频块，浏览器用 Web Audio 边收边播；如果服务商流式返回异常，会自动回退到原来的完整音频接口。若尚未配置 TTS，页面只会临时使用浏览器内置朗读作为演示回退。

## 数据与目录

```text
.
├── admin.html / admin.js        # 后台配置
├── create.html / create.js      # 一句话生成场景
├── index.html / lobby.js        # 首页和本地场景缓存
├── scene.html / scene.js        # 场景练习页
├── server.js                    # Node 服务端
├── database.js                  # SQLite 封装
├── scene-configs/               # 内置场景配置
├── assets/                      # 内置场景图片资源
├── scripts/migrate-dev.js       # 开发期一次性迁移脚本
└── data/                        # 本地运行时数据，已忽略
```

场景配置字段包括：

- `title`、`kicker`、`intro`、`introLines`
- `opponent`
- `opponentGender`：争吵方性别，会参与争吵文案和角色图片生成
- `opponentPrompt`
- `coachPrompt`
- `analysisPrompt`
- `winCondition`：必须能从对方言行观察确认的场景胜利条件
- `refereePrompt`：裁判在该场景中重点检查的让步、边界或行动承诺
- `art`、`thumbnailArt`、`opponentArt`
- `artPrompt`、`thumbnailArtPrompt`、`opponentArtPrompt`：`thumbnailArtPrompt` 定义视觉母图，`artPrompt` 定义从母图移除人物后的沉浸背景，`opponentArtPrompt` 定义从母图提取的同一人物；绿幕背景和抠图限制由服务端固定追加。

## 安全注意

以下内容不会提交到仓库：

- `data/config.json`
- SQLite 数据库文件
- 用户会话数据
- 场景生成任务中间态
- 用户本地生成的场景包 `scene-configs/generated/`

如果截图、日志或终端输出中暴露了 API Key，请到对应服务商后台轮换密钥。

## 开发期迁移

项目当前不在运行时保留旧原型兼容分支。旧配置或旧数据结构使用一次性脚本迁移：

```bash
npm run migrate
```

迁移脚本会处理旧双角色 `systemPrompt`、旧 `data/jobs/*.json` 任务记录，以及旧 `data/scenes/*.json` 场景配置。迁移后服务端只读取当前结构：`scene-configs/*.json`、`scene-configs/generated/*/scene.json` 和 SQLite。

## 未来开发方向

- 引入正式用户账号系统，替代匿名会话令牌
- 增加场景广场、收藏、分享和导入导出
- 支持每个智能体单独配置模型服务商
- 增加更细的安全策略和内容审核
- 把 SQLite 升级为 PostgreSQL，以支持多实例部署
- 用 Redis 或队列系统承载场景生成任务
- 把生成图片迁移到对象存储，便于部署到多台服务器
- 增加更完整的自动化测试和浏览器端回归测试
- 设计更完善的后台管理页，包括场景管理、会话管理和模型调用统计
