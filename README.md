# 吵架练习室

一个用于练习冲突表达的 AI 对话网页原型。它不是“骂人生成器”，而是一个冲突表达训练室：用户选择或生成一个争吵场景，和争吵方进行多轮对话；需要时可以开启“找人帮忙”，让 AI 教练给下一步表达建议；结束后由复盘分析师总结表达过程和沟通倾向。

项目目前处于基础开发阶段，重点是验证交互、三智能体架构、场景生成和多会话持久化能力。

## 技术栈

- 前端：原生 HTML、CSS、JavaScript
- 后端：Node.js 原生 `http` 服务
- 数据库：Node 内置 `node:sqlite`，使用 SQLite 持久化会话、消息、复盘和场景生成任务
- AI 对话：OpenAI Chat Completions 兼容接口
- AI 图片：OpenAI Images API 风格的 `/images/generations` 兼容接口
- 语音识别：本地 `whisper.cpp`，或 OpenAI Audio Transcriptions 兼容接口
- 语音合成：OpenAI Audio Speech 兼容接口
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
- 图片接口地址：可填根地址、`/v1` 地址，或完整 `/images/generations` 地址
- 图片模型名称
- 图片 API Key
- 图片生成超时时间
- 语音识别模式、接口地址、模型、API Key 和超时时间
- 语音合成接口地址、模型、声音、格式、语速、API Key 和超时时间

常见 OpenAI 兼容服务商只要提供 `base_url`、模型名和 API Key，一般都可以接入。后台提供“测试对话”和“测试图片”，两者分开测试，便于排查模型服务商问题。

## 实现流程

1. 用户进入首页并选择场景，再选择“训练模式”或“沉浸模式”。
2. 创建新场景时，前端先创建持久生成任务，并通过 SSE 订阅任务进度。
3. 文案模型生成场景标题、三句字幕、争吵方开场、三个智能体提示词和图片提示词。
4. 图片模型根据 `artPrompt` 生成场景背景图。
5. 服务端先把文案和图片写入 `data/staging/` 暂存目录，校验完整后再原子发布到 `scene-configs/generated/<sceneId>/`。
6. 场景页面创建匿名练习会话，服务端把会话、消息和复盘持久化到 SQLite。
7. 用户与争吵方对话时，服务端从数据库读取可信上下文并调用争吵方智能体流式返回。
8. 用户开启“找人帮忙”后，AI 教练使用独立上下文给出建议，不污染争吵方上下文。
9. 用户结束练习后，复盘分析师读取争吵记录和教练建议，生成过程分析、评分、沟通倾向和下一步建议。
10. 沉浸模式会先朗读争吵方开场，再循环执行浏览器录音、语音识别、争吵方流式回复和语音合成播放；该模式不启用帮忙专家。

## 已实现功能

- 三个内置场景：家庭边界、餐厅烟雾、深夜对峙
- 每个场景拥有独立 URL，例如 `/scene/family`
- 用户一句话生成新场景
- 场景生成任务支持 SSE 进度推送和轮询兜底
- 场景发布具备原子性，失败时不会暴露半成品
- OpenAI Chat Completions 兼容对话模型配置
- OpenAI Images API 风格图片模型配置
- 对话模型和图片模型分开测试
- 争吵方、帮忙专家、复盘分析师三个智能体职责解耦
- 对话流式返回
- 多用户匿名会话隔离
- SQLite 持久化会话、消息、复盘和生成任务
- 同一会话内请求加锁，避免并发写入错乱
- `requestId` 幂等写入，降低重试导致的重复消息风险
- 本地缓存用户创建过的场景，首页最多展示 3 个最新记录
- Enter 发送消息，Shift+Enter 换行
- 每个场景支持训练模式和沉浸语音模式
- 沉浸模式首句自动朗读，支持一轮一轮录音、识别、回复和播放
- 本地 whisper.cpp 与 OpenAI 兼容语音识别可切换
- 语音识别和语音合成可分别测试
- 后台异常和模型异常会在服务端打印日志，但不会打印 API Key
- `.gitignore` 已忽略运行时数据、密钥、数据库和用户生成场景

## 三智能体设计

每次练习包含三个职责分离的智能体：

- 争吵方：只扮演当前场景中的对方，继续推进冲突，不输出建议或复盘。
- 帮忙专家：用户点击“找人帮忙”后，只站在用户身边提供下一步策略和一句可直接说出口的话。
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

标准 OpenAI 语音输出调用服务商的 `/audio/speech`。小米 MiMo 音频模型需要在后台选择“MiMo Chat 音频协议”：ASR 使用 `mimo-v2.5-asr`，TTS 使用 `mimo-v2.5-tts` 和 `mimo_default` 音色，两者都调用 `/chat/completions`，可复用对话 API Key。若尚未配置 TTS，页面只会临时使用浏览器内置朗读作为演示回退。

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
- `opponentGender`：争吵方性别，决定可用的中文预置音色
- `ttsVoice`：女性使用冰糖/茉莉，男性使用苏打/白桦
- `voiceProfile`：角色年龄、声音质感和说话习惯
- `openingSpeechStyle`：开场台词的情绪、语调、语速、停顿与节奏
- `opponentPrompt`
- `coachPrompt`
- `analysisPrompt`
- `art`
- `artPrompt`

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
