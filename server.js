const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const sharp = require("sharp");
const { createDatabase } = require("./database");

const root = __dirname;
const dataDir = path.join(root, "data");
const configPath = path.join(dataDir, "config.json");
const sceneConfigDir = path.join(root, "scene-configs");
const publishedScenesDir = path.join(sceneConfigDir, "generated");
const stagingDir = path.join(dataDir, "staging");
const sessionAudioDir = path.join(dataDir, "session-audio");
const replayDir = path.join(dataDir, "replays");
const replayStagingDir = path.join(dataDir, "replay-staging");
const database = createDatabase(path.join(dataDir, "app.db"));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const jobSubscribers = new Map();
const queuedJobIds = new Set();
const jobQueue = [];
let processingJobs = false;

const defaultPrompt = `目标是帮助用户坚定、清晰、不过度攻击地表达边界。不要羞辱、操纵或鼓励报复；遇到威胁、暴力或自伤风险时，停止角色扮演，建议立即联系可信任的人或当地紧急服务。全程用简体中文。`;

const opponentRolePrompt = `你是当前冲突场景里的“争吵方”，不是教练、裁判、旁白或用户。你的身份、立场、行为事实必须始终等同于场景专属提示和对方开场；即使用户辱骂、夸奖、说“不错/可以/行”，也只能理解为用户正在对你这个场景角色说话，绝不能理解成对 AI 练习的评价。不得和用户交换身份，不得替用户说理，不得站到用户一边指责自己。你只回应用户刚说的话，保持场景里的立场、情绪和压力，但不要输出“教练：”、建议、评分、复盘、括号旁白、心理分析、语音表演说明、练习进度或“可以结束/这一轮”等元话语。每次回复 1 到 3 句，像真实对话一样继续推进冲突。不要生成歧视、威胁、骚扰、煽动现实报复或人身伤害内容。直接输出真正对用户说的台词，只输出台词本身。`;

const coachRolePrompt = `你是“吵架练习室”里的 AI 教练，不是争吵方。你只站在用户身边给下一步建议，不替对方说话，不继续角色扮演。请用简体中文输出：1 句判断、1 句下一步策略、1 句用户可以直接说出口的话。总长度不超过 120 字。不要羞辱、操纵或鼓励报复。`;

const analystRolePrompt = `你是“吵架练习室”的复盘分析师，不是争吵方，也不是实时教练。你只分析已经发生的对话，不继续角色扮演。重点观察用户如何表达事实、感受、请求和边界，以及面对压力时的沟通变化。性格部分只能描述“本次对话显示的沟通倾向”，每个倾向必须引用用户说过的话作为证据，并说明样本有限；禁止心理诊断、人格定型、道德评判或推断现实身份。返回严格 JSON，不要 markdown：{"overview":"过程概览","turningPoint":"关键转折","scores":{"clarity":0,"boundary":0,"emotionalControl":0,"listening":0},"personality":{"summary":"谨慎总结","traits":[{"name":"倾向名","evidence":"逐字复制用户发言中的一段连续原文，不加前缀，不改写","caveat":"限制说明"}]},"strengths":["优势"],"risks":["风险"],"nextSteps":["练习建议"],"suggestedReply":"一条更好的表达","disclaimer":"本报告只基于本次练习，不是心理诊断。"}。四项分数为 0 到 100 的整数；traits 2 到 4 条，其余数组 2 到 4 条。`;

const refereeRolePrompt = `你是“吵架练习室”的裁判智能体，不是争吵方、教练或复盘分析师。你在沉浸模式每完成一轮后判断训练目标是否真正达成。只有对方明确让步、接受用户边界、承诺具体行动，或冲突形成符合本场景目标的可执行收束时，才能判定 won；这里的 won 只表示“表达目标达成”，不表示压倒、羞辱或战胜对方。用户辱骂、音量更大、单方面宣布成功、对方暂时沉默或敷衍都不算目标达成。你还要基于用户本轮和本会话的措辞，谨慎估计吵完后的即时心理状态；这是情绪推测，不是心理诊断。返回严格 JSON，不要 markdown：{"status":"ongoing或won","confidence":0,"reason":"判定依据，不超过100字","mood":{"label":"例如松了一口气、终于被回应、仍不开心、兴奋、疲惫或憋屈","valence":0,"arousal":0,"confidence":0},"resultCopy":"仅在won时填写一段40到100字、第二人称、有画面感但克制的成果文案；不要写裁判判定、胜利条件、满足条件、你赢了等裁判式结论；ongoing时为空字符串"}。confidence、mood.valence、mood.arousal、mood.confidence 均为整数；valence 范围 -100 到 100，其余范围 0 到 100。`;

const finalAnswerOnlyPrompt = `不要输出思考过程、推理过程、analysis、reasoning、草稿、解释计划或 <think> 标签；只输出用户应该看到的最终内容。`;

function defaultConfig() {
  return {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKey: "",
    temperature: 0.7,
    systemPrompt: defaultPrompt,
    imageBaseUrl: "https://api.openai.com/v1",
    imageModel: "gpt-image-1",
    imageApiKey: "",
    imageTimeoutSeconds: 180,
    transcriptionMode: "local",
    transcriptionBaseUrl: "http://127.0.0.1:8080/inference",
    transcriptionModel: "whisper-1",
    transcriptionApiKey: "",
    transcriptionTimeoutSeconds: 120,
    speechMode: "openai",
    speechBaseUrl: "",
    speechModel: "gpt-4o-mini-tts",
    speechApiKey: "",
    speechVoice: "alloy",
    speechFormat: "mp3",
    speechTimeoutSeconds: 120,
    adminPassword: process.env.ADMIN_PASSWORD || "admin"
  };
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig(), null, 2), { mode: 0o600 });
  }
  const defaults = defaultConfig();
  const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return Object.fromEntries(Object.keys(defaults).map((key) => [key, stored[key] ?? defaults[key]]));
}

function writeConfig(config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(tempPath, "w", mode);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(tempPath, filePath);
  syncDirectory(path.dirname(filePath));
}

function durableWriteFile(filePath, buffer, mode = 0o600) {
  const descriptor = fs.openSync(filePath, "w", mode);
  try {
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // 部分平台不允许同步目录；文件内容仍已单独同步。
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readJob(id) {
  return /^[a-z0-9-]+$/.test(id) ? database.getJob(id) : null;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    sceneId: job.sceneId || null,
    sceneUrl: job.sceneUrl || null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function notifyJob(job) {
  const clients = jobSubscribers.get(job.id);
  if (!clients?.size) return;
  const event = job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : "progress";
  const payload = `id: ${Date.now()}\nevent: ${event}\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const response of clients) {
    response.write(payload);
    if (["completed", "failed"].includes(job.status)) response.end();
  }
  if (["completed", "failed"].includes(job.status)) jobSubscribers.delete(job.id);
}

function saveJob(job) {
  const next = { ...job, updatedAt: new Date().toISOString() };
  const saved = database.saveJob(next);
  notifyJob(saved);
  return saved;
}

function updateJob(id, patch) {
  const job = readJob(id);
  if (!job) throw new Error(`任务不存在：${id}`);
  return saveJob({ ...job, ...patch });
}

function findJobByIdempotencyKey(key) {
  return database.findJobByIdempotencyKey(key);
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

function getBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 200000) request.destroy();
    });
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("请求格式无效")); }
    });
    request.on("error", reject);
  });
}

function getRawBody(request, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("音频文件不能超过 25MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function isAdmin(request, config) {
  return request.headers["x-admin-password"] === config.adminPassword;
}

function publicConfig(config) {
  return {
    baseUrl: config.baseUrl, model: config.model, temperature: config.temperature, systemPrompt: config.systemPrompt,
    hasApiKey: Boolean(config.apiKey), imageBaseUrl: config.imageBaseUrl, imageModel: config.imageModel,
    imageTimeoutSeconds: config.imageTimeoutSeconds, hasImageApiKey: Boolean(config.imageApiKey || config.apiKey),
    transcriptionMode: config.transcriptionMode, transcriptionBaseUrl: config.transcriptionBaseUrl,
    transcriptionModel: config.transcriptionModel, transcriptionTimeoutSeconds: config.transcriptionTimeoutSeconds,
    hasTranscriptionApiKey: Boolean(config.transcriptionApiKey || (config.transcriptionMode === "mimo" && config.apiKey)),
    speechMode: config.speechMode, speechBaseUrl: config.speechBaseUrl,
    speechModel: config.speechModel, speechVoice: config.speechVoice,
    speechFormat: config.speechFormat,
    speechTimeoutSeconds: config.speechTimeoutSeconds,
    hasSpeechApiKey: Boolean(config.speechApiKey || config.apiKey)
  };
}

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildEndpoint(baseUrl, suffix) {
  const clean = trimSlash(baseUrl);
  if (!clean) return "";
  if (clean.endsWith(suffix)) return clean;
  return `${clean}${suffix}`;
}

function buildImageEndpoint(baseUrl, operation) {
  const clean = trimSlash(baseUrl).replace(/\/images\/(?:generations|edits)$/, "");
  return `${clean}/images/${operation}`;
}

function logModelError(scope, error, details = {}) {
  console.error(`[${new Date().toISOString()}] ${scope} 异常`, {
    ...details,
    message: error?.message || String(error),
    stack: error?.stack
  });
}

function effectiveSafetyPrompt(config) {
  return String(config.systemPrompt || defaultPrompt).trim();
}

function rolePrompt(config, role) {
  const base = role === "coach" ? coachRolePrompt : role === "analyst" ? analystRolePrompt : role === "referee" ? refereeRolePrompt : opponentRolePrompt;
  const scenePrompt = role === "coach" ? config.sceneCoachPrompt : role === "analyst" ? config.sceneAnalysisPrompt : role === "referee" ? config.sceneRefereePrompt : config.sceneOpponentPrompt;
  return `${base}\n\n${finalAnswerOnlyPrompt}\n\n场景专属提示：${scenePrompt || ""}\n\n补充原则：${effectiveSafetyPrompt(config)}`;
}

function modelTemperature(config, role) {
  const value = Number(config.temperature);
  if (role === "opponent") return Math.min(Number.isFinite(value) ? value : 0.7, 0.45);
  return value;
}

function sceneForRole(scene, role) {
  return {
    ...scene,
    sceneOpponentPrompt: scene.opponentPrompt || "",
    sceneCoachPrompt: scene.coachPrompt || "",
    sceneAnalysisPrompt: scene.analysisPrompt || "",
    sceneRefereePrompt: `${scene.refereePrompt || ""}\n胜利条件：${scene.winCondition || "对方明确接受用户提出的合理边界或行动请求。"}`,
    _role: role
  };
}

function mergeConfig(config, update = {}) {
  const baseUrl = trimSlash(update.baseUrl || config.baseUrl);
  const imageBaseUrl = trimSlash(update.imageBaseUrl || config.imageBaseUrl || baseUrl);
  return {
    ...config,
    baseUrl,
    model: String(update.model || config.model).trim(),
    temperature: Math.max(0, Math.min(2, Number(update.temperature ?? config.temperature))),
    systemPrompt: String(update.systemPrompt || config.systemPrompt || defaultPrompt).trim().slice(0, 8000),
    apiKey: update.apiKey ? String(update.apiKey).trim() : config.apiKey,
    imageBaseUrl,
    imageModel: String(update.imageModel || config.imageModel || "gpt-image-1").trim(),
    imageApiKey: update.imageApiKey ? String(update.imageApiKey).trim() : config.imageApiKey,
    imageTimeoutSeconds: Math.max(30, Math.min(300, Number(update.imageTimeoutSeconds ?? config.imageTimeoutSeconds ?? 180))),
    transcriptionMode: ["local", "openai", "mimo"].includes(String(update.transcriptionMode ?? config.transcriptionMode)) ? String(update.transcriptionMode ?? config.transcriptionMode) : "local",
    transcriptionBaseUrl: trimSlash(update.transcriptionBaseUrl || config.transcriptionBaseUrl || "http://127.0.0.1:8080/inference"),
    transcriptionModel: String(update.transcriptionModel || config.transcriptionModel || "whisper-1").trim(),
    transcriptionApiKey: update.transcriptionApiKey ? String(update.transcriptionApiKey).trim() : config.transcriptionApiKey,
    transcriptionTimeoutSeconds: Math.max(15, Math.min(300, Number(update.transcriptionTimeoutSeconds ?? config.transcriptionTimeoutSeconds ?? 120))),
    speechMode: String(update.speechMode ?? config.speechMode) === "mimo" ? "mimo" : "openai",
    speechBaseUrl: update.speechBaseUrl !== undefined ? trimSlash(update.speechBaseUrl) : trimSlash(config.speechBaseUrl || ""),
    speechModel: String(update.speechModel || config.speechModel || "gpt-4o-mini-tts").trim(),
    speechApiKey: update.speechApiKey ? String(update.speechApiKey).trim() : config.speechApiKey,
    speechVoice: String(update.speechVoice || config.speechVoice || "alloy").trim(),
    speechFormat: ["mp3", "opus", "aac", "flac", "wav", "pcm"].includes(update.speechFormat) ? update.speechFormat : (config.speechFormat || "mp3"),
    speechTimeoutSeconds: Math.max(15, Math.min(300, Number(update.speechTimeoutSeconds ?? config.speechTimeoutSeconds ?? 120))),
    adminPassword: update.newAdminPassword ? String(update.newAdminPassword) : config.adminPassword
  };
}

function validateConfig(config) {
  if (!config.baseUrl.startsWith("https://") && !config.baseUrl.startsWith("http://localhost") && !config.baseUrl.startsWith("http://127.0.0.1")) return "接口地址必须使用 HTTPS，或指向本机服务";
  if (config.imageBaseUrl && !config.imageBaseUrl.startsWith("https://") && !config.imageBaseUrl.startsWith("http://localhost") && !config.imageBaseUrl.startsWith("http://127.0.0.1")) return "图片接口地址必须使用 HTTPS，或指向本机服务";
  if (!config.model || !Number.isFinite(config.temperature)) return "请检查模型名称和温度";
  return "";
}

function validateImageConfig(config) {
  const imageBaseUrl = config.imageBaseUrl || config.baseUrl;
  if (!imageBaseUrl.startsWith("https://") && !imageBaseUrl.startsWith("http://localhost") && !imageBaseUrl.startsWith("http://127.0.0.1")) return "图片接口地址必须使用 HTTPS，或指向本机服务";
  if (!config.imageModel) return "请填写图片模型名称";
  if (!config.imageApiKey && !config.apiKey) return "请填写图片 API Key，或填写可复用的对话 API Key";
  if (!Number.isFinite(config.imageTimeoutSeconds) || config.imageTimeoutSeconds < 30 || config.imageTimeoutSeconds > 300) return "图片超时时间必须在 30 到 300 秒之间";
  return "";
}

function isAllowedServiceUrl(value) {
  return value.startsWith("https://") || value.startsWith("http://localhost") || value.startsWith("http://127.0.0.1");
}

function validateTranscriptionConfig(config) {
  if (!isAllowedServiceUrl(config.transcriptionBaseUrl)) return "语音识别地址必须使用 HTTPS，或指向本机服务";
  if (!config.transcriptionModel) return "请填写语音识别模型名称";
  if (config.transcriptionMode === "openai" && !config.transcriptionApiKey) return "OpenAI Audio 语音识别需要独立 API Key";
  if (config.transcriptionMode === "mimo" && !config.transcriptionApiKey && !config.apiKey) return "MiMo 语音识别需要 API Key，或可复用的对话 API Key";
  return "";
}

function validateSpeechConfig(config) {
  if (!isAllowedServiceUrl(config.speechBaseUrl)) return "语音合成地址必须使用 HTTPS，或指向本机服务";
  if (!config.speechModel || !config.speechVoice) return "请填写语音合成模型和声音";
  if (!config.speechApiKey && !config.apiKey) return "请填写语音合成 API Key，或填写可复用的对话 API Key";
  return "";
}

function stripThinkingContent(value, { trim = true } = {}) {
  let content = String(value || "");
  content = content.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, "");
  content = content.replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, "");
  content = content.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "");
  content = content.replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/gi, "");
  content = content.replace(/<reasoning\b[^>]*>[\s\S]*$/gi, "");
  content = content.replace(/<analysis\b[^>]*>[\s\S]*$/gi, "");
  const markers = ["最终答案：", "最终答复：", "最终回复：", "Final answer:", "Final:", "Answer:"];
  for (const marker of markers) {
    const index = content.toLowerCase().lastIndexOf(marker.toLowerCase());
    if (index >= 0) content = content.slice(index + marker.length);
  }
  return trim ? content.trim() : content;
}

function extractJsonObject(content) {
  const clean = stripThinkingContent(content).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (clean.startsWith("{") && clean.endsWith("}")) return clean;
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) return clean.slice(start, end + 1);
  return clean;
}

function readContentParts(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type && /reason/i.test(part.type)) return "";
      return part?.text || part?.content || "";
    }).join("");
  }
  return "";
}

function readChatContent(data, { allowThinking = false } = {}) {
  const content = data.choices?.[0]?.message?.content;
  const text = readContentParts(content || data.output_text || data.content || "");
  return allowThinking ? String(text || "").trim() : stripThinkingContent(text);
}

function readDeltaContent(data) {
  const delta = data.choices?.[0]?.delta;
  if (delta?.reasoning_content || delta?.reasoning || delta?.thinking || data.reasoning || data.thinking) return "";
  return readContentParts(delta?.content ?? data.choices?.[0]?.text ?? data.content ?? "");
}

function createThinkingFilter(onChunk) {
  let pending = "";
  let inThinking = false;
  const tagPattern = /<\/?(?:think|thinking|reasoning|analysis)\b[^>]*>/i;

  return (chunk, flush = false) => {
    pending += String(chunk || "");
    let visible = "";

    while (pending) {
      const match = pending.match(tagPattern);
      if (!match) {
        if (inThinking) {
          if (flush) pending = "";
          else pending = pending.slice(Math.max(0, pending.length - 32));
          break;
        }
        const keep = flush ? 0 : 32;
        if (pending.length <= keep) break;
        visible += pending.slice(0, pending.length - keep);
        pending = keep > 0 ? pending.slice(-keep) : "";
        break;
      }

      const before = pending.slice(0, match.index);
      const tag = match[0].toLowerCase();
      if (!inThinking && tag.startsWith("</")) visible += before;
      inThinking = !tag.startsWith("</");
      pending = pending.slice(match.index + match[0].length);
    }

    if (flush && pending && !inThinking) {
      visible += pending;
      pending = "";
    }

    const clean = stripThinkingContent(visible, { trim: false });
    if (clean) onChunk(clean);
  };
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-10).map((message) => ({
    role: ["assistant", "user"].includes(message.role) ? message.role : "user",
    content: String(message.content || "").slice(0, 1600)
  })).filter((message) => message.content.trim());
}

function validateOpponentReply(scene, content) {
  const text = String(content || "");
  if (/用户似乎|这一轮练习|可以结束|作为AI|复盘|评分/.test(text) || /^[（(]/.test(text.trim())) {
    throw new Error("争吵方回复包含旁白或练习元信息");
  }
}

function opponentRewriteMessages(messages, badReply, reason) {
  return [
    ...messages,
    {
      role: "user",
      content: `上一次争吵方回复不合格，原因：${reason}。\n不合格回复：${String(badReply || "").slice(0, 500)}\n请重新输出争吵方台词：保持固定身份和场景事实，不要旁白，不要解释，不要和用户交换立场。`
    }
  ];
}

function coachMessages(messages) {
  const transcript = sanitizeMessages(messages).map((message) => {
    const speaker = message.role === "assistant" ? "争吵方" : "用户";
    return `${speaker}：${message.content}`;
  }).join("\n");
  return [{ role: "user", content: `请根据以下对话记录，给用户下一步建议。\n\n${transcript}` }];
}

function analysisTranscript(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-30).filter((message) => ["assistant", "user"].includes(message?.role)).map((message) => ({
    role: message.role,
    content: String(message.content || "").slice(0, 2000)
  })).filter((message) => message.content.trim());
}

function analysisMessages(messages, coachHistory = []) {
  const transcript = analysisTranscript(messages).map((message) => `${message.role === "assistant" ? "争吵方" : "用户"}：${message.content}`).join("\n");
  const coaching = Array.isArray(coachHistory) ? coachHistory.slice(-8).map((item) => `帮忙专家：${String(item || "").slice(0, 1200)}`).join("\n") : "";
  return [{ role: "user", content: `请复盘下面这次练习。性格倾向只能从“用户”发言取证；专家建议只用于判断用户是否借助过提示，不可当作用户自己的表达。\n\n对话记录：\n${transcript}${coaching ? `\n\n练习中出现过的专家建议：\n${coaching}` : ""}` }];
}

function refereeMessages(messages) {
  const transcript = analysisTranscript(messages).map((message) => `${message.role === "assistant" ? "争吵方" : "用户"}：${message.content}`).join("\n");
  const latest = analysisTranscript(messages).slice(-2).map((message) => `${message.role === "assistant" ? "争吵方" : "用户"}：${message.content}`).join("\n");
  return [{ role: "user", content: `请只判断新增的最后一轮是否让整场争吵达到胜利条件。不得引用其他会话。\n\n当前会话完整记录：\n${transcript}\n\n本轮新增内容：\n${latest}` }];
}

function parseVerdict(content) {
  const result = JSON.parse(extractJsonObject(content));
  const status = result.status === "won" ? "won" : "ongoing";
  const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
  const verdict = {
    status,
    confidence: clamp(result.confidence),
    reason: String(result.reason || "对方还没有明确接受边界或行动请求。").slice(0, 240),
    mood: {
      label: String(result.mood?.label || "仍在较劲").slice(0, 60),
      valence: clamp(result.mood?.valence, -100, 100),
      arousal: clamp(result.mood?.arousal),
      confidence: clamp(result.mood?.confidence)
    },
    resultCopy: status === "won" ? String(result.resultCopy || "这次表达有了结果。你把真正想守住的东西说清楚了，也让对方给出了回应。").slice(0, 300) : ""
  };
  if (status === "won" && verdict.confidence < 50) throw new Error("裁判模型的胜利判定置信度不足");
  return verdict;
}

async function judgeConversation(config, scene, messages) {
  const content = await callModel(config, scene, refereeMessages(messages), "referee");
  return parseVerdict(content);
}

function parseAnalysis(content) {
  const clean = extractJsonObject(content);
  const result = JSON.parse(clean);
  const clampScore = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const stringList = (value, max = 4) => Array.isArray(value) ? value.slice(0, max).map((item) => String(item).slice(0, 240)).filter(Boolean) : [];
  const traits = Array.isArray(result.personality?.traits) ? result.personality.traits.slice(0, 4).map((trait) => ({
    name: String(trait?.name || "沟通倾向").slice(0, 40),
    evidence: String(trait?.evidence || "样本不足").slice(0, 300),
    caveat: String(trait?.caveat || "仅基于本次练习").slice(0, 180)
  })) : [];
  if (!result.overview || !result.turningPoint || traits.length < 1) throw new Error("分析模型没有返回完整报告");
  return {
    overview: String(result.overview).slice(0, 500),
    turningPoint: String(result.turningPoint).slice(0, 400),
    scores: {
      clarity: clampScore(result.scores?.clarity),
      boundary: clampScore(result.scores?.boundary),
      emotionalControl: clampScore(result.scores?.emotionalControl),
      listening: clampScore(result.scores?.listening)
    },
    personality: { summary: String(result.personality?.summary || "本次样本有限。").slice(0, 500), traits },
    strengths: stringList(result.strengths),
    risks: stringList(result.risks),
    nextSteps: stringList(result.nextSteps),
    suggestedReply: String(result.suggestedReply || "").slice(0, 500),
    disclaimer: "本报告只基于本次练习中的文字表达，不是心理诊断或固定人格结论。"
  };
}

function normalizeEvidence(value) {
  return String(value || "").replace(/[^\p{L}\p{N}]/gu, "");
}

function userEvidenceSnippets(messages) {
  return analysisTranscript(messages)
    .filter((message) => message.role === "user")
    .map((message) => String(message.content || "").trim().replace(/\s+/g, " ").slice(0, 160))
    .filter((content) => normalizeEvidence(content).length >= 4);
}

function evidenceBelongsToUser(evidence, snippets) {
  const normalized = normalizeEvidence(evidence);
  return normalized.length >= 4 && snippets.some((snippet) => normalizeEvidence(snippet).includes(normalized));
}

function reportHasInvalidTurningQuote(report, messages) {
  const allStatements = analysisTranscript(messages).map((message) => normalizeEvidence(message.content));
  const quotedClaims = [...String(report.turningPoint || "").matchAll(/[“"]([^”"]{4,})[”"]/g)].map((match) => normalizeEvidence(match[1]));
  return quotedClaims.some((quote) => !allStatements.some((statement) => statement.includes(quote)));
}

function repairAnalysisGrounding(report, messages, cause) {
  const snippets = userEvidenceSnippets(messages);
  const repaired = JSON.parse(JSON.stringify(report));
  const traits = Array.isArray(repaired.personality?.traits) ? repaired.personality.traits : [];
  let nextSnippet = 0;
  repaired.personality = repaired.personality || {};
  repaired.personality.traits = traits.map((trait) => {
    if (evidenceBelongsToUser(trait.evidence, snippets)) return trait;
    const evidence = snippets[nextSnippet++];
    if (!evidence) return null;
    return {
      ...trait,
      evidence,
      caveat: "这条证据已由服务端校正为用户原文；样本仍然有限。"
    };
  }).filter(Boolean);

  if (!repaired.personality.traits.length) {
    repaired.personality.summary = "本次用户发言样本较短，暂不做性格或稳定沟通倾向判断；下面只保留过程复盘和下一步建议。";
  }

  if (reportHasInvalidTurningQuote(repaired, messages)) {
    const lastUser = snippets.at(-1);
    repaired.turningPoint = lastUser ? `关键转折来自用户最后一次表达：${lastUser}` : "关键转折来自对话推进过程，但用户原文样本不足，暂不引用具体语句。";
  }

  repaired.disclaimer = "本报告只基于本次练习中的文字表达，不是心理诊断或固定人格结论。";
  repaired.groundingNotice = cause?.message ? `部分模型证据未能匹配用户原文，已由服务端降级修复：${cause.message}` : "部分模型证据已由服务端降级修复。";
  return repaired;
}

function assertGroundedAnalysis(report, messages) {
  const transcript = analysisTranscript(messages);
  const userStatements = transcript
    .filter((message) => message.role === "user")
    .map((message) => normalizeEvidence(message.content));
  const allStatements = transcript.map((message) => normalizeEvidence(message.content));
  for (const trait of report.personality.traits) {
    const evidence = normalizeEvidence(trait.evidence);
    if (evidence.length < 4 || !userStatements.some((statement) => statement.includes(evidence))) {
      throw new Error("分析模型引用了用户没有说过的证据");
    }
  }
  const quotedClaims = [...String(report.turningPoint || "").matchAll(/[“"]([^”"]{4,})[”"]/g)].map((match) => normalizeEvidence(match[1]));
  if (quotedClaims.some((quote) => !allStatements.some((statement) => statement.includes(quote)))) {
    throw new Error("分析模型的关键转折引用了对话中不存在的内容");
  }
}

async function analyzeConversation(config, scene, messages, coachHistory) {
  const endpoint = buildEndpoint(config.baseUrl, "/chat/completions");
  const context = `当前练习场景：${scene.title}\n场景说明：${scene.intro}\n对方开场：${scene.opponent}`;
  const baseMessages = [{ role: "system", content: `${rolePrompt({ ...config, ...sceneForRole(scene, "analyst") }, "analyst")}\n\n${context}` }, ...analysisMessages(messages, coachHistory)];
  let lastError;
  let lastReport;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestMessages = attempt === 0 ? baseMessages : [...baseMessages, { role: "user", content: "上一次报告格式或证据不合格。请重新返回完整 JSON；traits.evidence 必须逐字复制用户发言中的一段连续原文，不得概括、改写或引用用户没说过的话。" }];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, temperature: 0.2, messages: requestMessages }),
        signal: AbortSignal.timeout(60000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || `分析模型返回 ${response.status}`);
      const report = parseAnalysis(readChatContent(data));
      lastReport = report;
      assertGroundedAnalysis(report, messages);
      return report;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastReport) {
    const repaired = repairAnalysisGrounding(lastReport, messages, lastError);
    assertGroundedAnalysis(repaired, messages);
    return repaired;
  }
  throw lastError || new Error("分析模型没有返回有效报告");
}

async function callModel(config, scene, messages, role = "opponent") {
  const endpoint = buildEndpoint(config.baseUrl, "/chat/completions");
  const context = `当前练习场景：${scene.title}\n场景说明：${scene.intro}\n对方开场：${scene.opponent}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(chatCompletionBody(config, {
      model: config.model,
      temperature: modelTemperature(config, role),
      messages: [{ role: "system", content: `${rolePrompt({ ...config, ...sceneForRole(scene, role) }, role)}\n\n${context}` }, ...messages]
    }, role)),
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `模型接口返回 ${response.status}`);
  const content = readChatContent(data);
  if (!content) throw new Error("模型没有返回有效内容");
  return content;
}

async function streamModel(config, scene, messages, onChunk, signal, role = "opponent") {
  const endpoint = buildEndpoint(config.baseUrl, "/chat/completions");
  const context = `当前练习场景：${scene.title}\n场景说明：${scene.intro}\n对方开场：${scene.opponent}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(chatCompletionBody(config, {
      model: config.model,
      temperature: modelTemperature(config, role),
      stream: true,
      messages: [{ role: "system", content: `${rolePrompt({ ...config, ...sceneForRole(scene, role) }, role)}\n\n${context}` }, ...messages]
    }, role)),
    signal
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || `模型接口返回 ${response.status}`);
  }
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    const data = await response.json();
    const content = readChatContent(data);
    if (role === "opponent") {
      if (content) onChunk(content);
      return content;
    }
    if (content) onChunk(content);
    return content;
  }

  const emitVisibleChunk = createThinkingFilter(onChunk);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        emitVisibleChunk("", true);
        return "";
      }
      try {
        const text = readDeltaContent(JSON.parse(payload));
        if (text) emitVisibleChunk(text);
      } catch {
        continue;
      }
    }
  }
  emitVisibleChunk("", true);
  return "";
}

function parseScene(content) {
  const clean = extractJsonObject(content);
  const result = JSON.parse(clean);
  if (!result.title || !result.opponent || !Array.isArray(result.introLines) || result.introLines.length !== 3) throw new Error("文案模型没有按要求返回场景结构");
  const artPrompt = String(result.artPrompt || "charcoal and ink narrative scene").slice(0, 1200);
  return {
    title: String(result.title).slice(0, 80), kicker: String(result.kicker || "新的对峙。"), intro: String(result.intro || "把你想说的话留在这里。"),
    introLines: result.introLines.map((line) => String(line).slice(0, 70)),
    opponent: String(result.opponent).slice(0, 250),
    opponentPrompt: String(result.opponentPrompt || "").slice(0, 1000),
    coachPrompt: String(result.coachPrompt || "").slice(0, 1000),
    analysisPrompt: String(result.analysisPrompt || "重点分析用户如何表达边界、请求和情绪，并结合原话说明沟通倾向。").slice(0, 1000),
    winCondition: String(result.winCondition || "对方明确接受用户提出的合理边界或行动请求。").slice(0, 1000),
    refereePrompt: String(result.refereePrompt || "重点确认对方是否明确让步，以及用户是否得到可执行的结果；不要把辱骂或压制判为胜利。").slice(0, 1000),
    opponentGender: String(result.opponentGender || "unspecified"),
    artPrompt,
    thumbnailArtPrompt: String(result.thumbnailArtPrompt || artPrompt).slice(0, 1200),
    opponentArtPrompt: normalizeOpponentArtPrompt(result.opponentArtPrompt || artPrompt)
  };
}

const imageStyleGuard = "Japanese retro hand-drawn manga manuscript sketch from the 1990s, like an original comic artist draft scanned from an old sketchbook, monochrome black-and-white low-saturation image, high contrast, warm nostalgic aged off-white paper scan, thick handmade black outlines, rough uneven ink lines, visible pencil construction marks and corrections, loose graphite strokes, charcoal shading, dense cross-hatching for shadows, raw sketch texture, simple background only. No color, no vivid yellow background, no solid yellow fill background, no 3D effect, no glossy high-definition anime rendering, no modern digital painting style, no smooth clean AI linework, no complex background, no overly polished commercial anime character design.";

function normalizeOpponentArtPrompt(value) {
  const prompt = String(value || "").trim();
  if (/Japanese retro hand-drawn manga manuscript|1990s.*manga manuscript/i.test(prompt)) return prompt.slice(0, 1200);
  return `${prompt}. ${imageStyleGuard} Visible off-white paper-cut silhouette with irregular paper edge, low-detail expressive face, not photorealistic, not realistic portrait, not fashion illustration.`.slice(0, 1200);
}

function genderLabel(gender) {
  if (gender === "male") return "男性";
  if (gender === "female") return "女性";
  return "不限定性别";
}

function defaultOpponentVoice(gender) {
  if (gender === "female") return "茉莉";
  if (gender === "male") return "白桦";
  return "";
}

function inferOpponentGenderFromScene(scene, fallback = "female") {
  const text = [
    scene.opponentGender,
    scene.opponentPrompt,
    scene.opponentArtPrompt,
    scene.thumbnailArtPrompt,
    scene.opponent,
    scene.title,
    scene.kicker,
    scene.intro,
    scene.prompt
  ].filter(Boolean).join("\n").toLowerCase();

  const femalePatterns = [
    /女性|女生|女士|女人|女友|女朋友|妻子|老婆|太太|妈妈|母亲|婆婆|岳母|姐姐|妹妹|女儿|阿姨|闺蜜|女室友|女同事|女老板|女邻居|female|woman|girl|girlfriend|wife|mother|mom|daughter|sister|aunt/
  ];
  const malePatterns = [
    /男性|男生|男士|男人|男友|男朋友|丈夫|老公|爸爸|父亲|公公|岳父|哥哥|弟弟|儿子|叔叔|男室友|男同事|男老板|男邻居|male|man|boy|boyfriend|husband|father|dad|son|brother|uncle/
  ];
  const femaleScore = femalePatterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  const maleScore = malePatterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  if (femaleScore > maleScore) return "female";
  if (maleScore > femaleScore) return "male";
  return fallback === "male" ? "male" : "female";
}

function finalizeGeneratedSceneVoice(scene) {
  const gender = scene.opponentGender === "female" ? "female" : scene.opponentGender === "male" ? "male" : inferOpponentGenderFromScene(scene);
  const voice = String(scene.opponentVoice || "").trim() || defaultOpponentVoice(gender) || "茉莉";
  return {
    ...scene,
    opponentGender: gender,
    opponentVoice: voice
  };
}

const sceneWriterSystemPrompt = `你是互动叙事场景编剧。可以在内部进行必要推理，但最终回复只能包含一个严格 JSON 对象，不要 markdown，不要解释，不要把思考过程写进结果：{title,kicker,intro,introLines:[三句中文],opponent,opponentPrompt,coachPrompt,analysisPrompt,winCondition,refereePrompt,opponentGender,artPrompt,thumbnailArtPrompt,opponentArtPrompt}。
文案简体中文，克制、具体、非暴力；opponent 是对方的第一句，只能是对用户说的台词，不能包含括号动作、旁白、角色名或舞台说明；opponentGender 只能是 male 或 female，用户指定男性/女性时必须遵循，用户不限定性别时必须根据用户描述、关系身份、称谓和场景文案推断一个最合适的 male 或 female，不能返回 unspecified；opponentPrompt 描述争吵方的人设、关系身份、说话方式和施压/防御方式，并明确对方性别；coachPrompt 描述实时帮忙专家应该重点教什么；analysisPrompt 描述复盘分析师在这个场景中要重点观察的表达模式，不能做心理诊断；winCondition 描述必须由对方言行可观察确认的场景胜利条件，不能把辱骂或压制当胜利；refereePrompt 描述裁判在本场景应重点检查的让步、边界或行动承诺。
三类图片 prompt 必须都是英文，并描述同一地点、同一个对方角色和同一组服装道具；服务端会先用 thumbnailArtPrompt 生成母图，再把母图作为输入派生另外两张图。thumbnailArtPrompt 是视觉母图：完整表现环境、单个对方角色和冲突瞬间，构图适合首页横向小图，必须是一张不规则撕纸边缘的横向画片，画面内容都在旧纸片内部，不能有文字；artPrompt 是从母图派生沉浸背景的编辑要求，描述要保留的同一环境、视角和关键道具，移除所有人物，并在右侧预留角色空间；opponentArtPrompt 是从母图提取同一对方角色的编辑要求，只描述该角色的身份、性别、年龄段、姿态、表情、发型、服装、道具、朝向和黑白手绘剪贴/纸片边缘风格，人物身份、服装与道具必须和 thumbnailArtPrompt 完全一致，性别必须与 opponentGender 一致，三分之二或全身。
三张图统一为 ${imageStyleGuard} thumbnailArtPrompt 和 opponentArtPrompt 不要描述透明背景、green screen、chroma key、background removal，也不要写 no text/logo/watermark 等固定限制；这些限制由服务端代码统一追加。`;

async function createSceneText(config, prompt, opponentGender) {
  const preferredGender = ["male", "female"].includes(opponentGender) ? opponentGender : "unspecified";
  const genderCopy = genderLabel(preferredGender);
  const response = await fetch(buildEndpoint(config.baseUrl, "/chat/completions"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, temperature: 0.85, messages: [{ role: "system", content: sceneWriterSystemPrompt }, { role: "user", content: `用户描述：${prompt}\n对方性别偏好：${genderCopy}\n规范化性别：${preferredGender}` }] }), signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `文案模型返回 ${response.status}`);
  const scene = parseScene(readChatContent(data, { allowThinking: true }));
  if (preferredGender !== "unspecified") scene.opponentGender = preferredGender;
  return finalizeGeneratedSceneVoice(scene);
}

function sceneConfigPath(id) {
  return path.join(sceneConfigDir, `${id}.json`);
}

function publishedSceneDir(id) {
  return path.join(publishedScenesDir, id);
}

function readSceneConfig(id) {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  const published = path.join(publishedSceneDir(id), "scene.json");
  const primary = sceneConfigPath(id);
  const filePath = fs.existsSync(primary) ? primary : fs.existsSync(published) ? published : "";
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const builtInSceneOrder = ["restaurant-smoking", "phone-night", "roommate-gaming"];

function listBuiltInScenes() {
  if (!fs.existsSync(sceneConfigDir)) return [];
  const scenes = fs.readdirSync(sceneConfigDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.basename(name, ".json"))
    .map((id) => readSceneConfig(id))
    .filter((scene) => scene && scene.source !== "generated")
    .map((scene) => ({
      id: scene.id,
      title: scene.title,
      kicker: scene.kicker,
      intro: scene.intro,
      art: scene.thumbnailArt || scene.art,
      url: `/scene/${scene.id}`
    }));
  return scenes.sort((left, right) => {
    const leftIndex = builtInSceneOrder.indexOf(left.id);
    const rightIndex = builtInSceneOrder.indexOf(right.id);
    const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return leftRank - rightRank || left.title.localeCompare(right.title, "zh-CN");
  });
}

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) throw new Error("图片文件为空或不完整");
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mime: "image/png" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: "jpg", mime: "image/jpeg" };
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { extension: "webp", mime: "image/webp" };
  throw new Error("图片模型返回了不支持的文件格式");
}

async function readSceneImageResponse(response, timeoutMs) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `图片模型返回 ${response.status}`);
  const item = data.data?.[0];
  if (!item) throw new Error("图片模型没有返回图像");
  let buffer;
  if (item.b64_json) buffer = Buffer.from(item.b64_json, "base64");
  else if (item.url) {
    const image = await fetch(item.url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 60000)) });
    if (!image.ok) throw new Error("无法下载图片模型生成的图像");
    const contentLength = Number(image.headers.get("content-length") || 0);
    if (contentLength > 25 * 1024 * 1024) throw new Error("图片模型返回的文件过大");
    buffer = Buffer.from(await image.arrayBuffer());
  } else {
    throw new Error("图片模型返回格式不受支持");
  }
  if (buffer.length > 25 * 1024 * 1024) throw new Error("图片模型返回的文件过大");
  return { buffer, ...detectImageFormat(buffer) };
}

async function createSceneImage(config, artPrompt, size = "1536x1024") {
  const apiKey = config.imageApiKey || config.apiKey;
  if (!apiKey) throw new Error("未配置图片模型 API Key");
  const timeoutMs = Number(config.imageTimeoutSeconds || 180) * 1000;
  const response = await fetch(buildImageEndpoint(config.imageBaseUrl || config.baseUrl, "generations"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: config.imageModel || "gpt-image-1", prompt: artPrompt, size, response_format: "b64_json" }), signal: AbortSignal.timeout(timeoutMs)
  });
  return readSceneImageResponse(response, timeoutMs);
}

async function createSceneImageEdit(config, artPrompt, referenceImage, size = "1536x1024") {
  const apiKey = config.imageApiKey || config.apiKey;
  if (!apiKey) throw new Error("未配置图片模型 API Key");
  const timeoutMs = Number(config.imageTimeoutSeconds || 180) * 1000;
  const referenceFormat = detectImageFormat(referenceImage);
  const form = new FormData();
  form.append("model", config.imageModel || "gpt-image-1");
  form.append("prompt", artPrompt);
  form.append("size", size);
  form.append("response_format", "b64_json");
  form.append("image", new Blob([referenceImage], { type: referenceFormat.mime }), `reference.${referenceFormat.extension}`);
  const response = await fetch(buildImageEndpoint(config.imageBaseUrl || config.baseUrl, "edits"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return readSceneImageResponse(response, timeoutMs);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chromaKeyCutoutPrompt = `Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.`;

function cutoutImagePrompt(prompt) {
  const subjectPrompt = String(prompt || "").trim().slice(0, 1700);
  return [subjectPrompt, chromaKeyCutoutPrompt].filter(Boolean).join("\n\n");
}

function thumbnailImagePrompt(prompt) {
  return `${String(prompt || "").trim().slice(0, 900)}

This image is the visual master reference for one coherent three-image asset set. Show exactly one opponent character and the complete conflict environment. The whole illustration must live on one large horizontal torn piece of aged off-white paper with ragged, uneven, fibrous, hand-torn edges; the paper silhouette should be organic, not rectangular, with generous padding around the paper edge. Establish a distinctive but simple character identity, hairstyle, clothing silhouette, prop, room geometry, viewpoint, and manuscript line language that can be preserved in later edits. The artwork and paper must stay monochrome or warm off-white only. Exception: outside the torn paper only, use the flat #00ff00 technical background required below so the server can remove it. ${imageStyleGuard} No photorealism, no text, no logo, no watermark.

${chromaKeyCutoutPrompt}`.slice(0, 2400);
}

function backgroundEditPrompt(prompt) {
  return `Use the input image as the visual master reference.
Transform it into the immersive-mode environment background described below:
${String(prompt || "").trim().slice(0, 900)}

Remove every person completely. Preserve the same location, viewpoint, room geometry, furniture, props, monochrome black-and-white palette, aged paper scan texture, dense cross-hatching, charcoal shadows, rough handmade manga manuscript line style, visible sketch marks, and correction traces from the input image. Reconstruct naturally any area previously hidden by the character. Keep the right third visually quiet and open for placing the matching character cutout. ${imageStyleGuard} Do not introduce a new location, new character, text, logo, or watermark.`.slice(0, 2200);
}

function opponentEditPrompt(prompt) {
  return cutoutImagePrompt(`Use the input image as the visual master reference.
Extract and redraw the exact same single opponent character shown in the input image:
${String(prompt || "").trim().slice(0, 900)}

Preserve the character's identity, gender, age, face design, hairstyle, clothing, accessories, prop, proportions, pose language, monochrome black-and-white palette, aged paper scan texture, dense cross-hatching, charcoal shadows, rough handmade manga manuscript line style, visible sketch marks, and correction traces. Show one three-quarter-body or full-body character facing toward the user. Remove the original environment and all other visual elements. ${imageStyleGuard}`);
}

function saveImageDebugArtifact(stagePath, baseName, attempt, prompt, image) {
  const debugPath = path.join(stagePath, "debug-images");
  fs.mkdirSync(debugPath, { recursive: true });
  const prefix = `${baseName}-attempt-${attempt}`;
  durableWriteFile(path.join(debugPath, `${prefix}-raw.${image.extension}`), image.buffer);
  durableWriteFile(path.join(debugPath, `${prefix}-prompt.txt`), Buffer.from(String(prompt || ""), "utf8"));
}

async function makeCutoutTransparent(buffer, options = {}) {
  const image = sharp(buffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const total = width * height;
  const background = new Uint8Array(total);
  const queue = [];
  let head = 0;

  function clamp(value, min = 0, max = 255) {
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  function pixel(index) {
    const offset = index * channels;
    return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] };
  }

  function isChromaGreen(index, loose = false) {
    const { r, g, b, a } = pixel(index);
    if (a < 8) return true;
    const maxOther = Math.max(r, b);
    if (loose) return g > 115 && g - maxOther > 36 && g > r * 1.22 && g > b * 1.22;
    return g > 145 && g - r > 64 && g - b > 64;
  }

  function enqueue(index) {
    if (background[index] || !isChromaGreen(index, true)) return;
    background[index] = 1;
    queue.push(index);
  }

  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < queue.length) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index + width < total) enqueue(index + width);
  }

  for (let index = 0; index < total; index++) {
    if (isChromaGreen(index)) background[index] = 1;
  }

  const removedCount = background.reduce((sum, value) => sum + value, 0);
  const label = options.label || "图片";
  if (removedCount < total * 0.05) throw new Error(`${label}没有检测到稳定的 #00ff00 绿幕背景`);

  function touchesBackground(index) {
    const x = index % width;
    if (x > 0 && background[index - 1]) return true;
    if (x + 1 < width && background[index + 1]) return true;
    if (index >= width && background[index - width]) return true;
    if (index + width < total && background[index + width]) return true;
    return false;
  }

  const alpha = new Uint8Array(total);
  const matte = new Uint8Array(total);
  for (let index = 0; index < total; index++) {
    const offset = index * channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const sourceAlpha = data[offset + 3];
    if (background[index] || sourceAlpha < 8) {
      alpha[index] = 0;
      matte[index] = 1;
      continue;
    }

    const maxOther = Math.max(r, b);
    const greenExcess = g - maxOther;
    const nearEdge = touchesBackground(index);
    if (nearEdge && greenExcess > 8 && g > 80) {
      const estimatedAlpha = clamp((maxOther / 245) * 255);
      alpha[index] = Math.max(24, Math.min(255, estimatedAlpha));
      matte[index] = alpha[index] < 250 ? 1 : 0;
      continue;
    }
    alpha[index] = sourceAlpha;
  }

  for (let index = 0; index < total; index++) {
    const offset = index * channels;
    const nextAlpha = alpha[index];
    if (nextAlpha === 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
    } else if (matte[index]) {
      const normalized = nextAlpha / 255;
      data[offset] = clamp(data[offset] / normalized);
      data[offset + 1] = clamp((data[offset + 1] - (1 - normalized) * 255) / normalized);
      data[offset + 2] = clamp(data[offset + 2] / normalized);
    } else if (touchesBackground(index) && data[offset + 1] > Math.max(data[offset], data[offset + 2]) + 12) {
      data[offset + 1] = Math.max(data[offset], data[offset + 2]) + 12;
    }
    data[offset + 3] = nextAlpha;
  }

  const output = sharp(data, { raw: { width, height, channels } });
  return (options.preserveColor ? output : output.greyscale()).png().toBuffer();
}

function validateSceneDefinition(scene) {
  const requiredStrings = ["title", "kicker", "intro", "opponent", "opponentPrompt", "coachPrompt", "analysisPrompt", "winCondition", "refereePrompt", "opponentGender", "opponentVoice", "artPrompt", "thumbnailArtPrompt", "opponentArtPrompt", "art", "thumbnailArt", "opponentArt"];
  for (const key of requiredStrings) {
    if (!String(scene[key] || "").trim()) throw new Error(`场景配置缺少字段：${key}`);
  }
  if (!Array.isArray(scene.introLines) || scene.introLines.length !== 3 || scene.introLines.some((line) => !String(line).trim())) {
    throw new Error("场景配置必须包含三句完整字幕");
  }
}

function stagedImage(stagePath, baseName) {
  if (!fs.existsSync(stagePath)) return null;
  const pattern = new RegExp(`^${baseName}\\.(png|jpg|webp)$`);
  const name = fs.readdirSync(stagePath).find((item) => pattern.test(item));
  return name ? path.join(stagePath, name) : null;
}

async function ensureSceneImage(stagePath, jobId, scene, promptKey, baseName, size, progress, message, options = {}) {
  let imagePath = stagedImage(stagePath, baseName);
  if (imagePath) {
    if (!options.transparentCutout) return imagePath;
    const stagedBuffer = fs.readFileSync(imagePath);
    const stats = await sharp(stagedBuffer).ensureAlpha().stats();
    if (stats.channels[3]?.min < 255) return imagePath;
    const converted = await makeCutoutTransparent(stagedBuffer, options.cutout || {});
    const transparentPath = path.join(stagePath, `${baseName}.png`);
    durableWriteFile(transparentPath, converted);
    if (imagePath !== transparentPath) fs.unlinkSync(imagePath);
    return transparentPath;
  }
  updateJob(jobId, { status: "generating_image", progress, message });
  const imagePrompt = options.promptBuilder ? options.promptBuilder(scene[promptKey]) : scene[promptKey];

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const config = readConfig();
      const image = options.referenceImagePath
        ? await createSceneImageEdit(config, imagePrompt, fs.readFileSync(options.referenceImagePath), size)
        : await createSceneImage(config, imagePrompt, size);
      saveImageDebugArtifact(stagePath, baseName, attempt, imagePrompt, image);
      if (options.transparentCutout) {
        const converted = await makeCutoutTransparent(image.buffer, options.cutout || {});
        imagePath = path.join(stagePath, `${baseName}.png`);
        durableWriteFile(imagePath, converted);
        durableWriteFile(path.join(stagePath, "debug-images", `${baseName}-attempt-${attempt}-processed.png`), converted);
        return imagePath;
      }
      imagePath = path.join(stagePath, `${baseName}.${image.extension}`);
      durableWriteFile(imagePath, image.buffer);
      return imagePath;
    } catch (error) {
      lastError = error;
      logModelError("场景图片生成", error, { jobId, promptKey, baseName, size, attempt, maxAttempts: 2 });
      if (attempt < 2) {
        updateJob(jobId, { status: "generating_image", progress, message: `${message}失败，正在重试一次`, error: error.message || "图片生成失败" });
        await wait(800);
      }
    }
  }

  throw new Error(`${message}连续失败 2 次：${lastError?.message || "图片生成失败"}`);
}

async function runSceneJob(id) {
  let job = readJob(id);
  if (!job || ["completed", "failed"].includes(job.status)) return;
  const stagePath = path.join(stagingDir, id);
  const destination = publishedSceneDir(job.sceneId);

  try {
    if (fs.existsSync(path.join(destination, "scene.json"))) {
      updateJob(id, { status: "completed", progress: 100, message: "场景已经完成", sceneUrl: `/scene/${job.sceneId}`, error: null });
      return;
    }

    fs.mkdirSync(stagePath, { recursive: true });
    const draftPath = path.join(stagePath, "draft.json");
    let scene;
    if (fs.existsSync(draftPath)) {
      scene = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    } else {
      job = updateJob(id, { status: "generating_text", progress: 20, message: "正在生成场景文案", error: null });
      const config = readConfig();
      scene = await createSceneText(config, job.prompt, job.opponentGender);
      atomicWriteJson(draftPath, scene);
    }

    const thumbnailPath = await ensureSceneImage(stagePath, id, scene, "thumbnailArtPrompt", "thumbnail", "1536x1024", 42, "文案已完成，正在生成撕纸小图", { promptBuilder: thumbnailImagePrompt, transparentCutout: true, cutout: { label: "首页小图", preserveColor: true } });
    const backgroundPath = await ensureSceneImage(stagePath, id, scene, "artPrompt", "background", "1536x1024", 60, "正在从母图派生沉浸背景", { referenceImagePath: thumbnailPath, promptBuilder: backgroundEditPrompt });
    const opponentPath = await ensureSceneImage(stagePath, id, scene, "opponentArtPrompt", "opponent", "1024x1536", 76, "正在从母图派生争吵人形象", { referenceImagePath: thumbnailPath, promptBuilder: opponentEditPrompt, transparentCutout: true });

    const backgroundFormat = detectImageFormat(fs.readFileSync(backgroundPath));
    const thumbnailFormat = detectImageFormat(fs.readFileSync(thumbnailPath));
    const opponentFormat = detectImageFormat(fs.readFileSync(opponentPath));
    scene = {
      id: job.sceneId,
      source: "generated",
      ...scene,
      art: `scene-assets/${job.sceneId}/background.${backgroundFormat.extension}`,
      thumbnailArt: `scene-assets/${job.sceneId}/thumbnail.${thumbnailFormat.extension}`,
      opponentArt: `scene-assets/${job.sceneId}/opponent.${opponentFormat.extension}`
    };
    atomicWriteJson(path.join(stagePath, "scene.json"), scene);

    updateJob(id, { status: "validating", progress: 80, message: "正在检查场景完整性" });
    const persistedScene = JSON.parse(fs.readFileSync(path.join(stagePath, "scene.json"), "utf8"));
    validateSceneDefinition(persistedScene);
    detectImageFormat(fs.readFileSync(backgroundPath));
    detectImageFormat(fs.readFileSync(thumbnailPath));
    detectImageFormat(fs.readFileSync(opponentPath));

    updateJob(id, { status: "publishing", progress: 95, message: "正在发布完整场景" });
    if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
    syncDirectory(stagePath);
    fs.mkdirSync(publishedScenesDir, { recursive: true });
    if (fs.existsSync(destination)) throw new Error("场景发布地址已存在");
    fs.renameSync(stagePath, destination);
    syncDirectory(publishedScenesDir);

    updateJob(id, { status: "completed", progress: 100, message: "场景生成完成", sceneUrl: `/scene/${job.sceneId}`, error: null });
  } catch (error) {
    logModelError("场景生成任务", error, {
      jobId: id,
      sceneId: job?.sceneId,
      stage: readJob(id)?.status,
      chatEndpoint: buildEndpoint(readConfig().baseUrl, "/chat/completions"),
      imageEndpoint: buildImageEndpoint(readConfig().imageBaseUrl || readConfig().baseUrl, "generations"),
      imageEditEndpoint: buildImageEndpoint(readConfig().imageBaseUrl || readConfig().baseUrl, "edits")
    });
    if (!fs.existsSync(destination) && fs.existsSync(stagePath)) fs.rmSync(stagePath, { recursive: true, force: true });
    updateJob(id, { status: "failed", progress: 0, message: "场景生成失败", error: error.message || "生成失败" });
  }
}

function enqueueJob(id) {
  if (queuedJobIds.has(id)) return;
  queuedJobIds.add(id);
  jobQueue.push(id);
  if (!processingJobs) setImmediate(processJobQueue);
}

async function processJobQueue() {
  if (processingJobs) return;
  processingJobs = true;
  while (jobQueue.length) {
    const id = jobQueue.shift();
    queuedJobIds.delete(id);
    await runSceneJob(id);
  }
  processingJobs = false;
}

function recoverJobs() {
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const job of database.listRecoverableJobs()) {
    saveJob({ ...job, status: "queued", message: "服务恢复后继续生成", error: null });
    enqueueJob(job.id);
  }
}

async function testSceneImage(config) {
  const apiKey = config.imageApiKey || config.apiKey;
  const timeoutMs = Number(config.imageTimeoutSeconds || 180) * 1000;
  const response = await fetch(buildImageEndpoint(config.imageBaseUrl || config.baseUrl, "generations"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.imageModel || "gpt-image-1",
      prompt: `A simple original tense conversation scene. ${imageStyleGuard} No text, no logo, no watermark.`,
      size: "1024x1024",
      response_format: "b64_json"
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `图片模型返回 ${response.status}`);
  const item = data.data?.[0];
  if (!item?.b64_json && !item?.url) throw new Error("图片模型没有返回 b64_json 或 url");
  return item.b64_json ? "图片生成正常，已收到 b64_json" : "图片生成正常，已收到图片 URL";
}

function audioExtension(mimeType) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  return "webm";
}

function transcriptionEndpoint(config) {
  if (config.transcriptionMode === "local") return buildEndpoint(config.transcriptionBaseUrl, "/inference");
  if (config.transcriptionMode === "mimo") return buildEndpoint(config.transcriptionBaseUrl, "/chat/completions");
  return buildEndpoint(config.transcriptionBaseUrl, "/audio/transcriptions");
}

async function callTranscription(config, audio, mimeType = "audio/webm", { allowEmpty = false } = {}) {
  const endpoint = transcriptionEndpoint(config);
  if (config.transcriptionMode === "mimo") {
    const apiKey = config.transcriptionApiKey || config.apiKey;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.transcriptionModel || "mimo-v2.5-asr",
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:${mimeType};base64,${audio.toString("base64")}` } }] }],
        asr_options: { language: "auto" }
      }),
      signal: AbortSignal.timeout(Number(config.transcriptionTimeoutSeconds || 120) * 1000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.error || data?.message || `MiMo 语音识别返回 ${response.status}`);
    const text = readChatContent(data);
    if (!text && !allowEmpty) throw new Error("MiMo 语音识别没有返回文字，请靠近麦克风再说一次");
    return text;
  }
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `recording.${audioExtension(mimeType)}`);
  form.append("model", config.transcriptionModel || "whisper-1");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", "zh");
  const headers = {};
  if (config.transcriptionMode === "openai" && config.transcriptionApiKey) headers.Authorization = `Bearer ${config.transcriptionApiKey}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(Number(config.transcriptionTimeoutSeconds || 120) * 1000)
  });
  const responseType = response.headers.get("content-type") || "";
  const data = responseType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) {
    const detail = typeof data === "string" ? data.trim() : data?.error?.message || data?.error || data?.message;
    throw new Error(detail || `语音识别服务返回 ${response.status}`);
  }
  const text = String(typeof data === "string" ? data : data.text || data.transcription || data.result || "").trim();
  if (!text && !allowEmpty) throw new Error("语音识别服务没有返回文字，请靠近麦克风再说一次");
  return text;
}

function speechEndpoint(config) {
  return buildEndpoint(config.speechBaseUrl, config.speechMode === "mimo" ? "/chat/completions" : "/audio/speech");
}

function isMimoChatConfig(config) {
  const value = `${config.baseUrl || ""} ${config.model || ""}`.toLowerCase();
  return value.includes("mimo") || value.includes("xiaomi");
}

function chatCompletionBody(config, body, role = "") {
  const result = { ...body };
  if (isMimoChatConfig(config) && ["opponent", "coach", "referee"].includes(role)) {
    result.thinking = { type: "disabled" };
  }
  return result;
}

function mimoSpeechMessages(input) {
  return [
    { role: "assistant", content: String(input).slice(0, 4096) }
  ];
}

function mimoHeaders(apiKey) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "api-key": apiKey };
}

function speechVoiceForScene(config, scene = {}) {
  if (config.speechMode !== "mimo") return config.speechVoice;
  return String(scene.opponentVoice || "").trim() || config.speechVoice || "mimo_default";
}

async function callSpeech(config, input, options = {}) {
  const apiKey = config.speechApiKey || config.apiKey;
  const voice = speechVoiceForScene(config, options.scene);
  if (config.speechMode === "mimo") {
    const endpoint = speechEndpoint(config);
    const format = config.speechFormat || "wav";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: mimoHeaders(apiKey),
      body: JSON.stringify({
        model: config.speechModel || "mimo-v2.5-tts",
        messages: mimoSpeechMessages(input),
        audio: { format, voice }
      }),
      signal: AbortSignal.timeout(Number(config.speechTimeoutSeconds || 120) * 1000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.error || data?.message || `MiMo 语音合成返回 ${response.status}`);
    const base64Audio = data?.choices?.[0]?.message?.audio?.data;
    if (!base64Audio) throw new Error("MiMo 语音合成没有返回 choices[0].message.audio.data");
    const buffer = Buffer.from(base64Audio, "base64");
    if (!buffer.length) throw new Error("MiMo 语音合成返回了空音频");
    return { buffer, contentType: format === "mp3" ? "audio/mpeg" : `audio/${format}` };
  }
  const endpoint = speechEndpoint(config);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.speechModel,
      voice,
      input: String(input).slice(0, 4096),
      response_format: config.speechFormat
    }),
    signal: AbortSignal.timeout(Number(config.speechTimeoutSeconds || 120) * 1000)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || `语音合成服务返回 ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("语音合成服务返回了空音频");
  return { buffer, contentType: response.headers.get("content-type") || `audio/${config.speechFormat || "mpeg"}` };
}

function replayPublicData(replay) {
  return replay ? { id: replay.id, createdAt: replay.createdAt, ...replay.manifest } : null;
}

function sessionRecordingPath(sessionId, requestId) {
  return path.join(sessionAudioDir, sessionId, `${requestId}.wav`);
}

function cleanupSessionFiles(sessionId) {
  fs.rmSync(path.join(sessionAudioDir, sessionId), { recursive: true, force: true });
}

function replayPause(messages, index) {
  if (index >= messages.length - 1) return 0;
  const current = Date.parse(messages[index].createdAt || "");
  const next = Date.parse(messages[index + 1].createdAt || "");
  if (!Number.isFinite(current) || !Number.isFinite(next)) return 700;
  return Math.max(450, Math.min(2400, next - current));
}

async function createReplay(config, scene, sessionId) {
  const existing = database.getReplayBySession(sessionId);
  if (existing) return existing;

  const messages = database.listArgumentMessages(sessionId);
  if (!messages.length) throw new Error("这场对话没有可保存的内容");
  const replayId = `replay-${crypto.randomBytes(12).toString("hex")}`;
  const stagePath = path.join(replayStagingDir, replayId);
  const finalPath = path.join(replayDir, replayId);
  fs.mkdirSync(stagePath, { recursive: true });

  try {
    const timeline = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const fileName = `${String(index + 1).padStart(3, "0")}-${message.role}.wav`;
      const destination = path.join(stagePath, fileName);
      const recording = message.role === "user" ? sessionRecordingPath(sessionId, message.requestId) : "";
      let audioSource = "generated";
      if (recording && fs.existsSync(recording)) {
        fs.copyFileSync(recording, destination);
        audioSource = "recorded";
      } else {
        const audio = await callSpeech(
          { ...config, speechFormat: "wav" },
          message.content,
          message.role === "opponent" ? { scene } : {}
        );
        durableWriteFile(destination, audio.buffer);
      }
      timeline.push({
        role: message.role,
        text: message.content,
        audioUrl: `/replay-assets/${replayId}/${fileName}`,
        audioSource,
        pauseAfterMs: replayPause(messages, index)
      });
    }

    const latestVerdict = database.getLatestVerdict(sessionId)?.verdict || {};
    const manifest = {
      scene: { id: scene.id, title: scene.title, kicker: scene.kicker, art: scene.art },
      outcome: { resultCopy: latestVerdict.resultCopy || "这场争吵已经结束。", mood: latestVerdict.mood?.label || "" },
      timeline
    };
    atomicWriteJson(path.join(stagePath, "manifest.json"), manifest);
    fs.mkdirSync(replayDir, { recursive: true });
    fs.renameSync(stagePath, finalPath);
    syncDirectory(replayDir);
    const replay = database.saveReplay(replayId, sessionId, scene.id, manifest);
    try { cleanupSessionFiles(sessionId); } catch { /* 回放已保存，临时录音可稍后清理。 */ }
    return replay;
  } catch (error) {
    fs.rmSync(stagePath, { recursive: true, force: true });
    if (!database.getReplay(replayId)) fs.rmSync(finalPath, { recursive: true, force: true });
    throw error;
  }
}

async function streamMimoSpeech(config, input, response, options = {}) {
  const apiKey = config.speechApiKey || config.apiKey;
  if (config.speechMode !== "mimo") throw new Error("当前语音服务不支持流式合成");
  const endpoint = speechEndpoint(config);
  const voice = speechVoiceForScene(config, options.scene);
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: mimoHeaders(apiKey),
    body: JSON.stringify({
      model: config.speechModel || "mimo-v2.5-tts",
      messages: mimoSpeechMessages(input),
      audio: { format: "pcm16", voice },
      stream: true
    }),
    signal: AbortSignal.timeout(Number(config.speechTimeoutSeconds || 120) * 1000)
  });
  if (!upstream.ok) {
    const data = await upstream.json().catch(() => ({}));
    throw new Error(data?.error?.message || data?.error || data?.message || `MiMo 流式语音合成返回 ${upstream.status}`);
  }
  response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Audio-Format": "pcm16", "X-Audio-Sample-Rate": "24000" });
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        response.write(JSON.stringify({ done: true, chunks: chunkCount }) + "\n");
        return response.end();
      }
      try {
        const data = JSON.parse(payload);
        const audio = data?.choices?.[0]?.delta?.audio?.data;
        if (audio) {
          chunkCount += 1;
          response.write(JSON.stringify({ audio }) + "\n");
        }
      } catch {
        continue;
      }
    }
  }
  response.write(JSON.stringify({ done: true, chunks: chunkCount }) + "\n");
  return response.end();
}

function silentWav(durationMs = 300) {
  const sampleRate = 16000;
  const sampleCount = Math.floor(sampleRate * durationMs / 1000);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  return buffer;
}

function sessionToken(request) {
  return String(request.headers["x-session-token"] || "");
}

function sessionState(session) {
  return { ...session, messages: database.listMessages(session.id), latestVerdict: database.getLatestVerdict(session.id) };
}

function argumentMessagesForModel(sessionId) {
  return database.listArgumentMessages(sessionId).map((message) => ({
    role: message.role === "opponent" ? "assistant" : "user",
    content: message.content
  }));
}

function argumentMessagesForTurn(sessionId, userContent) {
  return [
    ...argumentMessagesForModel(sessionId),
    { role: "user", content: String(userContent || "").slice(0, 1600) }
  ];
}

function coachContents(sessionId) {
  return database.listCoachMessages(sessionId).map((message) => message.content);
}

function validRequestId(value) {
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(String(value || ""));
}

function authenticateSession(request, id) {
  return database.authenticateSession(id, sessionToken(request));
}

function streamHeaders(response) {
  response.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no"
  });
}

function localCoachAdvice(text) {
  if (/滚|闭嘴|傻|蠢|有病|垃圾|废物|去死/.test(text)) return "判断：这句话带有攻击。\n策略：保留立场，把羞辱换成具体请求。\n可以说：我不同意你的做法，请停止并处理这件事。";
  if (/不|不能|请|需要|边界|停止|具体|时间|如果/.test(text)) return "判断：你已经说出了边界。\n策略：再补一个期限或后续行动。\n可以说：请你现在处理；如果继续，我会先结束谈话。";
  return "判断：你的不满已经表达出来。\n策略：补充一个明确请求。\n可以说：这件事影响到我，我需要你现在给出具体处理方式。";
}

function localSessionReport(messages) {
  const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content);
  const combined = userMessages.join(" ");
  const hasBoundary = /不接受|不能|停止|边界|请你|需要你|如果/.test(combined);
  const hasAttack = /滚|闭嘴|傻|蠢|有病|垃圾|废物/.test(combined);
  return {
    overview: `你完成了 ${userMessages.length} 轮表达。${hasBoundary ? "表达里已经出现了清楚的边界或请求。" : "你表达了不满，但希望对方怎么做还可以更明确。"}`,
    turningPoint: `关键转折是：“${userMessages.at(-1).slice(0, 160)}”`,
    scores: { clarity: hasBoundary ? 76 : 55, boundary: hasBoundary ? 80 : 48, emotionalControl: hasAttack ? 38 : 72, listening: 60 },
    personality: {
      summary: "这次练习显示，你愿意面对冲突并尝试把不舒服说出来；样本仍然很少，只适合观察当下的表达习惯。",
      traits: [
        { name: "愿意正面表达", evidence: userMessages[0].slice(0, 160), caveat: "这里只能说明你在本场景中的选择。" },
        { name: hasBoundary ? "开始建立边界" : "容易停在情绪描述", evidence: userMessages.at(-1).slice(0, 160), caveat: "需要更多不同场景才能判断是否稳定。" }
      ]
    },
    strengths: ["愿意开口处理冲突", hasAttack ? "真实表达了强烈情绪" : "没有依赖人身攻击"],
    risks: [hasBoundary ? "边界之后还需要说明后续行动" : "请求不够具体时，对方容易继续回避", "压力上升时可能重复解释"],
    nextSteps: ["用一句事实开头", "提出一个当下可执行的请求", "说明对方拒绝时你会采取什么行动"],
    suggestedReply: hasBoundary ? userMessages.at(-1) : "这件事已经影响到我。我需要你现在给出一个具体处理方式；如果做不到，我会先结束这次对话。",
    disclaimer: "本报告只基于本次练习中的文字表达，不是心理诊断或固定人格结论。"
  };
}

function localRefereeVerdict(messages) {
  const userTurns = messages.filter((message) => message.role === "user");
  const lastOpponent = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
  const won = userTurns.length >= 2 && /^(行|好|可以)|知道了|我会|我停|不抽了|答应你|按你说的|是我的问题/.test(lastOpponent);
  return {
    status: won ? "won" : "ongoing",
    confidence: won ? 70 : 58,
    reason: won ? "对方最新回复包含可观察的接受或承诺。" : "目前仍缺少对方接受边界或承诺行动的证据。",
    mood: { label: won ? "松了一口气" : "仍在较劲", valence: won ? 45 : -12, arousal: won ? 42 : 62, confidence: 45 },
    resultCopy: won ? "你把这次表达推到了一个真实的结果：对方终于给出了回应。重要的不是压过对方，而是那条终于被看见的边界。" : ""
  };
}

async function generateOpponentReply(config, scene, sessionId, content) {
  if (!config.apiKey) return scene.opponent;
  let reply = await callModel(config, scene, argumentMessagesForTurn(sessionId, content), "opponent");
  if (!reply.trim()) throw new Error("争吵方没有返回有效内容");
  try {
    validateOpponentReply(scene, reply);
  } catch (validationError) {
    reply = await callModel(config, scene, opponentRewriteMessages(argumentMessagesForTurn(sessionId, content), reply, validationError.message), "opponent");
    validateOpponentReply(scene, reply);
  }
  return reply.trim();
}

async function completeOpponentTurn(config, scene, sessionId, requestId, content) {
  const existingTurn = database.getTurn(sessionId, requestId);
  if (existingTurn?.status === "completed" && existingTurn.userContent !== content) {
    const error = new Error("同一个 requestId 已经完成，不能改用另一条消息重试");
    error.statusCode = 409;
    throw error;
  }
  const existing = database.getMessage(sessionId, requestId, "opponent");
  if (existing) return existing.content;

  const lockToken = database.claimSession(sessionId);
  if (!lockToken) {
    const error = new Error("这个会话正在处理上一条消息，请稍后重试");
    error.statusCode = 409;
    throw error;
  }

  let turnBegan = false;
  try {
    database.beginTurn(sessionId, requestId, content);
    turnBegan = true;
    const reply = await generateOpponentReply(config, scene, sessionId, content);
    database.completeTurn(sessionId, requestId, content, reply);
    return reply;
  } catch (error) {
    if (turnBegan) database.failTurn(sessionId, requestId, error.message);
    throw error;
  } finally {
    database.releaseSession(sessionId, lockToken);
  }
}

async function handleApi(request, response, pathname) {
  const config = readConfig();
  const requestUrl = new URL(request.url, `http://${host}`);
  const effectiveMethod = requestUrl.searchParams.get("_method") === "DELETE" ? "DELETE" : request.method;
  if (pathname === "/api/status" && request.method === "GET") return sendJson(response, 200, {
    configured: Boolean(config.apiKey), model: config.model,
    transcriptionMode: config.transcriptionMode,
    speechMode: config.speechMode,
    immersiveConfigured: Boolean((config.speechApiKey || config.apiKey) && config.speechBaseUrl && config.transcriptionBaseUrl)
  });
  const publicReplayRoute = pathname.match(/^\/api\/replays\/(replay-[a-f0-9]{24})$/);
  if (publicReplayRoute && request.method === "GET") {
    const replay = database.getReplay(publicReplayRoute[1]);
    if (!replay) return sendJson(response, 404, { error: "回放不存在或已被删除" });
    return sendJson(response, 200, replayPublicData(replay));
  }
  if ((pathname === "/api/scene-jobs" || pathname === "/api/scenes/generate") && request.method === "POST") {
    const payload = await getBody(request);
    const prompt = String(payload.prompt || "").trim();
    const idempotencyKey = String(request.headers["idempotency-key"] || payload.idempotencyKey || "").trim();
    if (prompt.length < 8) return sendJson(response, 400, { error: "请多说一点你想吵的那件事。" });
    if (!config.apiKey) return sendJson(response, 503, { error: "请先在后台配置文案模型 API Key。" });
    const imageConfigError = validateImageConfig(config);
    if (imageConfigError) return sendJson(response, 503, { error: imageConfigError });
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(response, 400, { error: "请求缺少有效的 Idempotency-Key" });

    const existing = findJobByIdempotencyKey(idempotencyKey);
    if (existing) {
      return sendJson(response, existing.status === "completed" ? 200 : 202, {
        ...publicJob(existing),
        eventsUrl: `/api/scene-jobs/${existing.id}/events`
      });
    }

    const opponentGender = ["male", "female"].includes(payload.opponentGender) ? payload.opponentGender : "unspecified";
    const now = new Date().toISOString();
    const job = {
      id: `job-${crypto.randomUUID()}`,
      idempotencyKey,
      status: "queued",
      progress: 5,
      message: "任务已创建，等待生成",
      prompt: prompt.slice(0, 3000),
      opponentGender,
      sceneId: `scene-${crypto.randomUUID()}`,
      sceneUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    database.saveJob(job);
    enqueueJob(job.id);
    return sendJson(response, 202, { ...publicJob(job), eventsUrl: `/api/scene-jobs/${job.id}/events` });
  }

  const jobRoute = pathname.match(/^\/api\/scene-jobs\/([a-z0-9-]+)(\/events)?$/);
  if (jobRoute && request.method === "GET") {
    const job = readJob(jobRoute[1]);
    if (!job) return sendJson(response, 404, { error: "生成任务不存在" });
    if (!jobRoute[2]) return sendJson(response, 200, publicJob(job));

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
    if (["completed", "failed"].includes(job.status)) return response.end();

    const clients = jobSubscribers.get(job.id) || new Set();
    clients.add(response);
    jobSubscribers.set(job.id, clients);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15000);
    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
      if (!clients.size) jobSubscribers.delete(job.id);
    });
    return;
  }

  if (pathname === "/api/sessions" && request.method === "POST") {
    const payload = await getBody(request);
    const scene = readSceneConfig(String(payload.sceneId || ""));
    if (!scene) return sendJson(response, 404, { error: "场景不存在" });
    const mode = payload.mode === "immersive" ? "immersive" : "training";
    const created = database.createSession(scene.id, scene.opponent, mode);
    return sendJson(response, 201, created);
  }

  const sessionRoute = pathname.match(/^\/api\/sessions\/(session-[a-z0-9-]+)(?:\/(messages|coach|judge|analyze|transcriptions|speech|speech-stream|replay))?$/);
  if (sessionRoute) {
    const sessionId = sessionRoute[1];
    const action = sessionRoute[2] || "";
    let deletePayload = null;
    if (!action && effectiveMethod === "DELETE" && !sessionToken(request)) {
      deletePayload = await getBody(request).catch(() => ({}));
    }
    let session = sessionToken(request)
      ? authenticateSession(request, sessionId)
      : database.authenticateSession(sessionId, String(deletePayload?.token || ""));
    if (!session) return sendJson(response, 401, { error: "会话不存在或访问令牌无效" });
    const scene = readSceneConfig(session.sceneId);
    if (!scene) return sendJson(response, 410, { error: "这个会话对应的场景已经不存在" });

    if (!action && request.method === "GET") return sendJson(response, 200, sessionState(session));

    if (!action && effectiveMethod === "DELETE") {
      if (session.mode !== "immersive") return sendJson(response, 409, { error: "只有沉浸模式会话会在离开时直接清除" });
      cleanupSessionFiles(sessionId);
      database.deleteSession(sessionId);
      return sendJson(response, 200, { deleted: true });
    }

    if (!action && request.method === "PATCH") {
      const payload = await getBody(request);
      if (typeof payload.coachEnabled !== "boolean") return sendJson(response, 400, { error: "coachEnabled 必须是布尔值" });
      if (session.mode === "immersive" && payload.coachEnabled) return sendJson(response, 409, { error: "沉浸模式不启用帮忙专家" });
      session = database.setCoachEnabled(sessionId, payload.coachEnabled);
      return sendJson(response, 200, sessionState(session));
    }

    if (action === "transcriptions" && request.method === "POST") {
      const configError = validateTranscriptionConfig(config);
      if (configError) return sendJson(response, 503, { error: configError });
      const mimeType = String(request.headers["content-type"] || "audio/webm").split(";")[0];
      const requestId = String(request.headers["x-request-id"] || "");
      if (!validRequestId(requestId)) return sendJson(response, 400, { error: "录音请求标识无效" });
      let audioBytes = 0;
      try {
        const audio = await getRawBody(request);
        audioBytes = audio.length;
        if (audio.length < 200) return sendJson(response, 400, { error: "录音内容太短，请重新录制" });
        const text = await callTranscription(config, audio, mimeType);
        const recordingPath = sessionRecordingPath(sessionId, requestId);
        fs.mkdirSync(path.dirname(recordingPath), { recursive: true });
        durableWriteFile(recordingPath, audio);
        return sendJson(response, 200, { text });
      } catch (error) {
        logModelError("会话语音识别", error, { sessionId, sceneId: scene.id, endpoint: transcriptionEndpoint(config), model: config.transcriptionModel, mode: config.transcriptionMode, mimeType, audioBytes });
        return sendJson(response, 502, { error: "语音识别失败，请检查后台配置或服务端日志" });
      }
    }

    if (action === "replay" && request.method === "POST") {
      if (session.mode !== "immersive" || database.getLatestVerdict(sessionId)?.verdict?.status !== "won") {
        return sendJson(response, 409, { error: "只能保存已经达成表达目标的沉浸对话" });
      }
      const configError = validateSpeechConfig(config);
      if (configError) return sendJson(response, 503, { error: configError });
      const existing = database.getReplayBySession(sessionId);
      if (existing) return sendJson(response, 200, replayPublicData(existing));
      const lockToken = database.claimSession(sessionId, 300000);
      if (!lockToken) return sendJson(response, 409, { error: "对话正在保存，请稍后重试" });
      try {
        const replay = await createReplay(config, scene, sessionId);
        return sendJson(response, 201, replayPublicData(replay));
      } catch (error) {
        logModelError("保存会话回放", error, { sessionId, sceneId: scene.id });
        return sendJson(response, 502, { error: `保存回放失败：${error.message}` });
      } finally {
        database.releaseSession(sessionId, lockToken);
      }
    }

    if (action === "speech" && request.method === "POST") {
      const configError = validateSpeechConfig(config);
      if (configError) return sendJson(response, 503, { error: configError });
      const payload = await getBody(request);
      const requestId = String(payload.requestId || "");
      const savedMessage = requestId ? database.getMessage(sessionId, requestId, "opponent") : null;
      const input = String(savedMessage?.content || payload.input || "").trim();
      if (!input || input.length > 4096) return sendJson(response, 400, { error: "语音文本长度必须在 1 到 4096 字之间" });
      try {
        const audio = await callSpeech(config, input, { scene });
        response.writeHead(200, { "Content-Type": audio.contentType, "Content-Length": audio.buffer.length, "Cache-Control": "no-store" });
        return response.end(audio.buffer);
      } catch (error) {
        logModelError("会话语音合成", error, { sessionId, sceneId: scene.id, endpoint: speechEndpoint(config), model: config.speechModel, voice: speechVoiceForScene(config, scene), mode: config.speechMode });
        return sendJson(response, 502, { error: "语音合成失败，请检查后台配置或服务端日志" });
      }
    }

    if (action === "speech-stream" && request.method === "POST") {
      const configError = validateSpeechConfig(config);
      if (configError) return sendJson(response, 503, { error: configError });
      const payload = await getBody(request);
      const requestId = String(payload.requestId || "");
      const savedMessage = requestId ? database.getMessage(sessionId, requestId, "opponent") : null;
      const input = String(savedMessage?.content || payload.input || "").trim();
      if (!input || input.length > 4096) return sendJson(response, 400, { error: "语音文本长度必须在 1 到 4096 字之间" });
      try {
        return await streamMimoSpeech(config, input, response, { scene });
      } catch (error) {
        logModelError("会话流式语音合成", error, { sessionId, sceneId: scene.id, endpoint: speechEndpoint(config), model: config.speechModel, voice: speechVoiceForScene(config, scene), mode: config.speechMode });
        if (!response.headersSent) return sendJson(response, 502, { error: "流式语音合成失败，请检查后台配置或服务端日志" });
        return response.destroy(error);
      }
    }

    if (action === "messages" && request.method === "POST") {
      if (session.status === "ended") return sendJson(response, 409, { error: "裁判已经判定这场争吵结束" });
      const payload = await getBody(request);
      const content = String(payload.content || "").trim();
      const requestId = String(payload.requestId || "");
      if (!validRequestId(requestId)) return sendJson(response, 400, { error: "缺少有效的 requestId" });
      if (!content || content.length > 1600) return sendJson(response, 400, { error: "消息长度必须在 1 到 1600 字之间" });
      try {
        const reply = await completeOpponentTurn(config, scene, sessionId, requestId, content);
        streamHeaders(response);
        response.write(reply);
        return response.end();
      } catch (error) {
        logModelError("会话争吵方", error, { sessionId, sceneId: scene.id, endpoint: buildEndpoint(config.baseUrl, "/chat/completions"), model: config.model });
        return sendJson(response, error.statusCode || 502, { error: error.message });
      }
    }

    if (action === "judge" && request.method === "POST") {
      if (session.mode !== "immersive") return sendJson(response, 409, { error: "裁判只在沉浸模式中逐轮判定" });
      const messages = argumentMessagesForModel(sessionId);
      if (!messages.some((message) => message.role === "user")) return sendJson(response, 400, { error: "至少完成一轮表达后才能判定" });
      const version = database.messageVersion(sessionId);
      const cached = database.getVerdict(sessionId, version);
      if (cached) return sendJson(response, 200, { ...cached, cached: true });
      const lockToken = database.claimSession(sessionId, 60000);
      if (!lockToken) return sendJson(response, 409, { error: "这个会话正在处理其他请求，请稍后重试" });
      try {
        const verdict = config.apiKey ? await judgeConversation(config, scene, messages) : localRefereeVerdict(messages);
        const saved = database.saveVerdict(sessionId, version, verdict, config.apiKey ? config.model : "本地裁判");
        return sendJson(response, 200, { ...saved, cached: false });
      } catch (error) {
        logModelError("会话裁判判定", error, { sessionId, sceneId: scene.id, endpoint: buildEndpoint(config.baseUrl, "/chat/completions"), model: config.model, messageVersion: version });
        return sendJson(response, 502, { error: "裁判暂时无法完成判定，请检查服务端日志" });
      } finally {
        database.releaseSession(sessionId, lockToken);
      }
    }

    if (action === "coach" && request.method === "POST") {
      const payload = await getBody(request);
      const requestId = String(payload.requestId || "");
      if (!validRequestId(requestId)) return sendJson(response, 400, { error: "缺少有效的 requestId" });
      if (session.mode === "immersive") return sendJson(response, 409, { error: "沉浸模式不启用帮忙专家" });
      if (!session.coachEnabled) return sendJson(response, 409, { error: "请先开启找人帮忙" });
      const existing = database.getMessage(sessionId, requestId, "coach");
      if (existing) {
        streamHeaders(response);
        return response.end(existing.content);
      }
      const lockToken = database.claimSession(sessionId);
      if (!lockToken) return sendJson(response, 409, { error: "这个会话正在处理其他请求，请稍后重试" });

      let started = false;
      let advice = "";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        if (!config.apiKey) {
          const lastUser = argumentMessagesForModel(sessionId).filter((message) => message.role === "user").at(-1)?.content || "";
          advice = localCoachAdvice(lastUser);
          streamHeaders(response);
          started = true;
          response.write(advice);
        } else {
          await streamModel(config, scene, coachMessages(argumentMessagesForModel(sessionId)), (chunk) => {
            if (!started) { streamHeaders(response); started = true; }
            advice += chunk;
            response.write(chunk);
          }, controller.signal, "coach");
        }
        if (!advice.trim()) throw new Error("帮忙专家没有返回有效内容");
        database.appendMessage(sessionId, requestId, "coach", advice.trim());
        clearTimeout(timeout);
        if (!started) streamHeaders(response);
        return response.end();
      } catch (error) {
        clearTimeout(timeout);
        logModelError("会话帮忙专家", error, { sessionId, sceneId: scene.id, endpoint: buildEndpoint(config.baseUrl, "/chat/completions"), model: config.model });
        if (started) return response.destroy(error);
        return sendJson(response, 502, { error: error.message });
      } finally {
        database.releaseSession(sessionId, lockToken);
      }
    }

    if (action === "analyze" && request.method === "POST") {
      const messages = argumentMessagesForModel(sessionId);
      if (session.mode === "training" && messages.filter((message) => message.role === "user").length < 5) return sendJson(response, 400, { error: "至少完成 5 轮对话后才能生成有效复盘。" });
      if (session.mode === "immersive" && session.status !== "ended") return sendJson(response, 400, { error: "沉浸模式需要在裁判判定结束后才能复盘。" });
      const version = database.messageVersion(sessionId);
      const cached = database.getReport(sessionId, version);
      if (cached) return sendJson(response, 200, { ...cached, cached: true });
      const lockToken = database.claimSession(sessionId, 150000);
      if (!lockToken) return sendJson(response, 409, { error: "这个会话正在处理其他请求，请稍后重试" });
      try {
        const report = config.apiKey ? await analyzeConversation(config, scene, messages, coachContents(sessionId)) : localSessionReport(messages);
        const saved = database.saveReport(sessionId, version, report, config.apiKey ? config.model : "本地分析");
        return sendJson(response, 200, { ...saved, cached: false });
      } catch (error) {
        logModelError("会话复盘分析", error, { sessionId, sceneId: scene.id, endpoint: buildEndpoint(config.baseUrl, "/chat/completions"), model: config.model });
        return sendJson(response, 502, { error: error.message });
      } finally {
        database.releaseSession(sessionId, lockToken);
      }
    }

    return sendJson(response, 405, { error: "会话接口不支持这个操作" });
  }
  if (pathname === "/api/admin/config" && request.method === "GET") {
    return isAdmin(request, config) ? sendJson(response, 200, publicConfig(config)) : sendJson(response, 401, { error: "后台访问码不正确" });
  }
  if (pathname === "/api/admin/config" && request.method === "PUT") {
    if (!isAdmin(request, config)) return sendJson(response, 401, { error: "后台访问码不正确" });
    const update = await getBody(request);
    const next = mergeConfig(config, update);
    const error = validateConfig(next);
    if (error) return sendJson(response, 400, { error });
    writeConfig(next);
    return sendJson(response, 200, publicConfig(next));
  }
  if ((pathname === "/api/admin/test" || pathname === "/api/admin/test/chat") && request.method === "POST") {
    if (!isAdmin(request, config)) return sendJson(response, 401, { error: "后台访问码不正确" });
    const testConfig = mergeConfig(config, await getBody(request));
    const error = validateConfig(testConfig);
    if (error) return sendJson(response, 400, { error });
    if (!testConfig.apiKey) return sendJson(response, 400, { error: "请填写 API Key 后再测试" });
    try {
      const content = await callModel(testConfig, { title: "连接测试", intro: "测试接口。", opponent: "请简短确认。" }, [{ role: "user", content: "请只回复：连接正常" }]);
      return sendJson(response, 200, { message: content.slice(0, 120), endpoint: buildEndpoint(testConfig.baseUrl, "/chat/completions") });
    } catch (error) {
      logModelError("对话测试", error, { endpoint: buildEndpoint(testConfig.baseUrl, "/chat/completions"), model: testConfig.model });
      return sendJson(response, 502, { error: error.message });
    }
  }
  if (pathname === "/api/admin/test/image" && request.method === "POST") {
    if (!isAdmin(request, config)) return sendJson(response, 401, { error: "后台访问码不正确" });
    const testConfig = mergeConfig(config, await getBody(request));
    const error = validateImageConfig(testConfig);
    if (error) return sendJson(response, 400, { error });
    try {
      const message = await testSceneImage(testConfig);
      return sendJson(response, 200, { message, endpoint: buildImageEndpoint(testConfig.imageBaseUrl || testConfig.baseUrl, "generations") });
    } catch (error) {
      logModelError("图片测试", error, { endpoint: buildImageEndpoint(testConfig.imageBaseUrl || testConfig.baseUrl, "generations"), model: testConfig.imageModel });
      return sendJson(response, 502, { error: error.message });
    }
  }
  if (pathname === "/api/admin/test/transcription" && request.method === "POST") {
    if (!isAdmin(request, config)) return sendJson(response, 401, { error: "后台访问码不正确" });
    const testConfig = mergeConfig(config, await getBody(request));
    const error = validateTranscriptionConfig(testConfig);
    if (error) return sendJson(response, 400, { error });
    try {
      await callTranscription(testConfig, silentWav(), "audio/wav", { allowEmpty: true });
      return sendJson(response, 200, { message: "语音识别接口可访问并接受音频", endpoint: transcriptionEndpoint(testConfig) });
    } catch (error) {
      logModelError("语音识别测试", error, { endpoint: transcriptionEndpoint(testConfig), model: testConfig.transcriptionModel, mode: testConfig.transcriptionMode });
      return sendJson(response, 502, { error: error.message });
    }
  }
  if (pathname === "/api/admin/test/speech" && request.method === "POST") {
    if (!isAdmin(request, config)) return sendJson(response, 401, { error: "后台访问码不正确" });
    const testConfig = mergeConfig(config, await getBody(request));
    const error = validateSpeechConfig(testConfig);
    if (error) return sendJson(response, 400, { error });
    try {
      const audio = await callSpeech(testConfig, "语音合成连接正常。");
      return sendJson(response, 200, { message: `语音合成正常，收到 ${audio.buffer.length} 字节音频`, endpoint: speechEndpoint(testConfig) });
    } catch (error) {
      logModelError("语音合成测试", error, { endpoint: speechEndpoint(testConfig), model: testConfig.speechModel, voice: testConfig.speechVoice, mode: testConfig.speechMode });
      return sendJson(response, 502, { error: error.message });
    }
  }
  if (pathname === "/api/scenes" && request.method === "GET") {
    return sendJson(response, 200, { scenes: listBuiltInScenes() });
  }
  if (pathname.startsWith("/api/scenes/") && request.method === "GET") {
    const id = pathname.slice("/api/scenes/".length);
    if (!/^[a-z0-9-]+$/.test(id)) return sendJson(response, 400, { error: "场景地址无效" });
    const scene = readSceneConfig(id);
    if (!scene) return sendJson(response, 404, { error: "场景不存在" });
    return sendJson(response, 200, scene);
  }
  return sendJson(response, 404, { error: "接口不存在" });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4"
};
const publicFiles = new Set(["index.html", "admin.html", "admin.js", "create.html", "create.js", "lobby.js", "scene.html", "scene.js", "replay.html", "replay.js", "styles.css"]);

function sendFile(response, filePath) {
  response.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${host}`).pathname;
    if (pathname.startsWith("/api/")) return await handleApi(request, response, pathname);

    const replayAsset = pathname.match(/^\/replay-assets\/(replay-[a-f0-9]{24})\/(\d{3}-(?:user|opponent)\.wav)$/);
    if (replayAsset) {
      const assetPath = path.join(replayDir, replayAsset[1], replayAsset[2]);
      if (database.getReplay(replayAsset[1]) && fs.existsSync(assetPath)) return sendFile(response, assetPath);
      response.writeHead(404); return response.end("Not found");
    }

    const sceneAsset = pathname.match(/^\/scene-assets\/([a-z0-9-]+)\/((?:background|thumbnail|opponent)\.(?:png|jpg|webp))$/);
    if (sceneAsset) {
      const packageDir = publishedSceneDir(sceneAsset[1]);
      const assetPath = path.join(packageDir, sceneAsset[2]);
      if (fs.existsSync(path.join(packageDir, "scene.json")) && fs.existsSync(assetPath)) return sendFile(response, assetPath);
      response.writeHead(404); return response.end("Not found");
    }

    const fileName = pathname === "/" ? "index.html" : pathname === "/create" ? "create.html" : pathname.startsWith("/scene/") ? "scene.html" : pathname.startsWith("/replay/") ? "replay.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const publicBase = fileName.startsWith("assets/") ? path.join(root, "assets") : null;
    if (!publicFiles.has(fileName) && !publicBase) {
      response.writeHead(404); return response.end("Not found");
    }
    const filePath = path.resolve(root, fileName);
    const insideAllowedBase = publicFiles.has(fileName) ? path.dirname(filePath) === root : filePath.startsWith(publicBase + path.sep);
    if (!insideAllowedBase || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404); return response.end("Not found");
    }
    return sendFile(response, filePath);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] HTTP 服务异常`, { message: error.message, stack: error.stack });
    sendJson(response, 500, { error: error.message || "服务异常" });
  }
});

server.listen(port, host, () => {
  console.log(`吵架练习室已启动：http://${host}:${port}`);
  recoverJobs();
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
