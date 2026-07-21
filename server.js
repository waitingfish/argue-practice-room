const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { createDatabase } = require("./database");

const root = __dirname;
const dataDir = path.join(root, "data");
const configPath = path.join(dataDir, "config.json");
const sceneConfigDir = path.join(root, "scene-configs");
const publishedScenesDir = path.join(sceneConfigDir, "generated");
const stagingDir = path.join(dataDir, "staging");
const database = createDatabase(path.join(dataDir, "app.db"));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const jobSubscribers = new Map();
const queuedJobIds = new Set();
const jobQueue = [];
let processingJobs = false;

const defaultPrompt = `目标是帮助用户坚定、清晰、不过度攻击地表达边界。不要羞辱、操纵或鼓励报复；遇到威胁、暴力或自伤风险时，停止角色扮演，建议立即联系可信任的人或当地紧急服务。全程用简体中文。`;

const opponentRolePrompt = `你是当前冲突场景里的“争吵方”，不是教练。你只回应用户刚说的话，保持场景里的立场、情绪和压力，但不要输出“教练：”、建议、评分、复盘或旁白。每次回复 1 到 3 句，像真实对话一样继续推进冲突。不要生成歧视、威胁、骚扰、煽动现实报复或人身伤害内容。`;

const coachRolePrompt = `你是“吵架练习室”里的 AI 教练，不是争吵方。你只站在用户身边给下一步建议，不替对方说话，不继续角色扮演。请用简体中文输出：1 句判断、1 句下一步策略、1 句用户可以直接说出口的话。总长度不超过 120 字。不要羞辱、操纵或鼓励报复。`;

const analystRolePrompt = `你是“吵架练习室”的复盘分析师，不是争吵方，也不是实时教练。你只分析已经发生的对话，不继续角色扮演。重点观察用户如何表达事实、感受、请求和边界，以及面对压力时的沟通变化。性格部分只能描述“本次对话显示的沟通倾向”，每个倾向必须引用用户说过的话作为证据，并说明样本有限；禁止心理诊断、人格定型、道德评判或推断现实身份。返回严格 JSON，不要 markdown：{"overview":"过程概览","turningPoint":"关键转折","scores":{"clarity":0,"boundary":0,"emotionalControl":0,"listening":0},"personality":{"summary":"谨慎总结","traits":[{"name":"倾向名","evidence":"逐字复制用户发言中的一段连续原文，不加前缀，不改写","caveat":"限制说明"}]},"strengths":["优势"],"risks":["风险"],"nextSteps":["练习建议"],"suggestedReply":"一条更好的表达","disclaimer":"本报告只基于本次练习，不是心理诊断。"}。四项分数为 0 到 100 的整数；traits 2 到 4 条，其余数组 2 到 4 条。`;

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
    adminPassword: process.env.ADMIN_PASSWORD || "admin"
  };
}

function readConfig() {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig(), null, 2), { mode: 0o600 });
  }
  return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
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

function isAdmin(request, config) {
  return request.headers["x-admin-password"] === config.adminPassword;
}

function publicConfig(config) {
  return { baseUrl: config.baseUrl, model: config.model, temperature: config.temperature, systemPrompt: config.systemPrompt, hasApiKey: Boolean(config.apiKey), imageBaseUrl: config.imageBaseUrl, imageModel: config.imageModel, imageTimeoutSeconds: config.imageTimeoutSeconds, hasImageApiKey: Boolean(config.imageApiKey || config.apiKey) };
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
  const base = role === "coach" ? coachRolePrompt : role === "analyst" ? analystRolePrompt : opponentRolePrompt;
  const scenePrompt = role === "coach" ? config.sceneCoachPrompt : role === "analyst" ? config.sceneAnalysisPrompt : config.sceneOpponentPrompt;
  return `${base}\n\n场景专属提示：${scenePrompt || ""}\n\n补充原则：${effectiveSafetyPrompt(config)}`;
}

function sceneForRole(scene, role) {
  return {
    ...scene,
    sceneOpponentPrompt: scene.opponentPrompt || "",
    sceneCoachPrompt: scene.coachPrompt || "",
    sceneAnalysisPrompt: scene.analysisPrompt || "",
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

function readChatContent(data) {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part.text || "").join("").trim();
  return "";
}

function readDeltaContent(data) {
  const delta = data.choices?.[0]?.delta;
  const content = delta?.content ?? delta?.reasoning_content ?? data.choices?.[0]?.text ?? data.content ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part.text || "").join("");
  return "";
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-10).map((message) => ({
    role: ["assistant", "user"].includes(message.role) ? message.role : "user",
    content: String(message.content || "").slice(0, 1600)
  })).filter((message) => message.content.trim());
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

function parseAnalysis(content) {
  const clean = String(content || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
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
    body: JSON.stringify({
      model: config.model,
      temperature: Number(config.temperature),
      messages: [{ role: "system", content: `${rolePrompt({ ...config, ...sceneForRole(scene, role) }, role)}\n\n${context}` }, ...messages]
    }),
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
    body: JSON.stringify({
      model: config.model,
      temperature: Number(config.temperature),
      stream: true,
      messages: [{ role: "system", content: `${rolePrompt({ ...config, ...sceneForRole(scene, role) }, role)}\n\n${context}` }, ...messages]
    }),
    signal
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message || `模型接口返回 ${response.status}`);
  }
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    const data = await response.json();
    const content = readChatContent(data);
    if (content) onChunk(content);
    return;
  }

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
      if (payload === "[DONE]") return;
      try {
        const text = readDeltaContent(JSON.parse(payload));
        if (text) onChunk(text);
      } catch {
        continue;
      }
    }
  }
}

function parseScene(content) {
  const clean = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const result = JSON.parse(clean);
  if (!result.title || !result.opponent || !Array.isArray(result.introLines) || result.introLines.length !== 3) throw new Error("文案模型没有按要求返回场景结构");
  return {
    title: String(result.title).slice(0, 80), kicker: String(result.kicker || "新的对峙。"), intro: String(result.intro || "把你想说的话留在这里。"),
    introLines: result.introLines.map((line) => String(line).slice(0, 70)),
    opponent: String(result.opponent).slice(0, 250),
    opponentPrompt: String(result.opponentPrompt || "").slice(0, 1000),
    coachPrompt: String(result.coachPrompt || "").slice(0, 1000),
    analysisPrompt: String(result.analysisPrompt || "重点分析用户如何表达边界、请求和情绪，并结合原话说明沟通倾向。").slice(0, 1000),
    artPrompt: String(result.artPrompt || "charcoal and ink narrative scene").slice(0, 1200)
  };
}

async function createSceneText(config, prompt, voice) {
  const response = await fetch(buildEndpoint(config.baseUrl, "/chat/completions"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, temperature: 0.85, messages: [{ role: "system", content: "你是互动叙事场景编剧。用户给出一段想争吵的事。返回严格 JSON，不要 markdown：{title,kicker,intro,introLines:[三句中文],opponent,opponentPrompt,coachPrompt,analysisPrompt,artPrompt}。文案简体中文，克制、具体、非暴力；opponent 是对方的第一句；opponentPrompt 描述争吵方的人设、说话方式和施压方式；coachPrompt 描述实时帮忙专家应该重点教什么；analysisPrompt 描述复盘分析师在这个场景中要重点观察的表达模式，不能做心理诊断；artPrompt 用英文，描述原创的 charcoal and ink hand-drawn collage illustration, wide 16:9, two people in conflict, no text, no logo, no watermark。" }, { role: "user", content: `用户描述：${prompt}\n对方声音偏好：${voice}` }] }), signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `文案模型返回 ${response.status}`);
  return parseScene(data.choices?.[0]?.message?.content || "");
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
  const filePath = fs.existsSync(published) ? published : fs.existsSync(primary) ? primary : "";
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) throw new Error("图片文件为空或不完整");
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mime: "image/png" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: "jpg", mime: "image/jpeg" };
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { extension: "webp", mime: "image/webp" };
  throw new Error("图片模型返回了不支持的文件格式");
}

async function createSceneImage(config, artPrompt) {
  const apiKey = config.imageApiKey || config.apiKey;
  if (!apiKey) throw new Error("未配置图片模型 API Key");
  const timeoutMs = Number(config.imageTimeoutSeconds || 180) * 1000;
  const response = await fetch(buildEndpoint(config.imageBaseUrl || config.baseUrl, "/images/generations"), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: config.imageModel || "gpt-image-1", prompt: artPrompt, size: "1536x1024", response_format: "b64_json" }), signal: AbortSignal.timeout(timeoutMs)
  });
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
  }
  else throw new Error("图片模型返回格式不受支持");
  if (buffer.length > 25 * 1024 * 1024) throw new Error("图片模型返回的文件过大");
  return { buffer, ...detectImageFormat(buffer) };
}

function validateSceneDefinition(scene) {
  const requiredStrings = ["title", "kicker", "intro", "opponent", "opponentPrompt", "coachPrompt", "analysisPrompt", "artPrompt", "art"];
  for (const key of requiredStrings) {
    if (!String(scene[key] || "").trim()) throw new Error(`场景配置缺少字段：${key}`);
  }
  if (!Array.isArray(scene.introLines) || scene.introLines.length !== 3 || scene.introLines.some((line) => !String(line).trim())) {
    throw new Error("场景配置必须包含三句完整字幕");
  }
}

function stagedImage(stagePath) {
  if (!fs.existsSync(stagePath)) return null;
  const name = fs.readdirSync(stagePath).find((item) => /^background\.(png|jpg|webp)$/.test(item));
  return name ? path.join(stagePath, name) : null;
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
      scene = await createSceneText(config, job.prompt, job.voice);
      atomicWriteJson(draftPath, scene);
    }

    let imagePath = stagedImage(stagePath);
    if (!imagePath) {
      job = updateJob(id, { status: "generating_image", progress: 55, message: "文案已完成，正在生成场景画面" });
      const image = await createSceneImage(readConfig(), scene.artPrompt);
      imagePath = path.join(stagePath, `background.${image.extension}`);
      durableWriteFile(imagePath, image.buffer);
    }

    const imageFormat = detectImageFormat(fs.readFileSync(imagePath));
    scene = {
      id: job.sceneId,
      source: "generated",
      ...scene,
      art: `scene-assets/${job.sceneId}/background.${imageFormat.extension}`
    };
    atomicWriteJson(path.join(stagePath, "scene.json"), scene);

    updateJob(id, { status: "validating", progress: 80, message: "正在检查场景完整性" });
    const persistedScene = JSON.parse(fs.readFileSync(path.join(stagePath, "scene.json"), "utf8"));
    validateSceneDefinition(persistedScene);
    detectImageFormat(fs.readFileSync(imagePath));

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
      imageEndpoint: buildEndpoint(readConfig().imageBaseUrl || readConfig().baseUrl, "/images/generations")
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
  const response = await fetch(buildEndpoint(config.imageBaseUrl || config.baseUrl, "/images/generations"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.imageModel || "gpt-image-1",
      prompt: "A simple original black ink hand-drawn scene, two people in a tense conversation, no text, no logo.",
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

function sessionToken(request) {
  return String(request.headers["x-session-token"] || "");
}

function sessionState(session) {
  return { ...session, messages: database.listMessages(session.id) };
}

function argumentMessagesForModel(sessionId) {
  return database.listArgumentMessages(sessionId).map((message) => ({
    role: message.role === "opponent" ? "assistant" : "user",
    content: message.content
  }));
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

async function handleApi(request, response, pathname) {
  const config = readConfig();
  if (pathname === "/api/status" && request.method === "GET") return sendJson(response, 200, { configured: Boolean(config.apiKey), model: config.model });
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

    const now = new Date().toISOString();
    const job = {
      id: `job-${crypto.randomUUID()}`,
      idempotencyKey,
      status: "queued",
      progress: 5,
      message: "任务已创建，等待生成",
      prompt: prompt.slice(0, 3000),
      voice: String(payload.voice || "无所谓").slice(0, 20),
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
    const created = database.createSession(scene.id, scene.opponent);
    return sendJson(response, 201, created);
  }

  const sessionRoute = pathname.match(/^\/api\/sessions\/(session-[a-z0-9-]+)(?:\/(messages|coach|analyze))?$/);
  if (sessionRoute) {
    const sessionId = sessionRoute[1];
    const action = sessionRoute[2] || "";
    let session = authenticateSession(request, sessionId);
    if (!session) return sendJson(response, 401, { error: "会话不存在或访问令牌无效" });
    const scene = readSceneConfig(session.sceneId);
    if (!scene) return sendJson(response, 410, { error: "这个会话对应的场景已经不存在" });

    if (!action && request.method === "GET") return sendJson(response, 200, sessionState(session));

    if (!action && request.method === "PATCH") {
      const payload = await getBody(request);
      if (typeof payload.coachEnabled !== "boolean") return sendJson(response, 400, { error: "coachEnabled 必须是布尔值" });
      session = database.setCoachEnabled(sessionId, payload.coachEnabled);
      return sendJson(response, 200, sessionState(session));
    }

    if (action === "messages" && request.method === "POST") {
      const payload = await getBody(request);
      const content = String(payload.content || "").trim();
      const requestId = String(payload.requestId || "");
      if (!validRequestId(requestId)) return sendJson(response, 400, { error: "缺少有效的 requestId" });
      if (!content || content.length > 1600) return sendJson(response, 400, { error: "消息长度必须在 1 到 1600 字之间" });
      const existing = database.getMessage(sessionId, requestId, "opponent");
      if (existing) {
        streamHeaders(response);
        return response.end(existing.content);
      }
      const lockToken = database.claimSession(sessionId);
      if (!lockToken) return sendJson(response, 409, { error: "这个会话正在处理上一条消息，请稍后重试" });

      let started = false;
      let reply = "";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        database.appendMessage(sessionId, requestId, "user", content);
        if (!config.apiKey) {
          reply = scene.opponent;
          streamHeaders(response);
          started = true;
          response.write(reply);
        } else {
          await streamModel(config, scene, argumentMessagesForModel(sessionId), (chunk) => {
            if (!started) { streamHeaders(response); started = true; }
            reply += chunk;
            response.write(chunk);
          }, controller.signal, "opponent");
        }
        if (!reply.trim()) throw new Error("争吵方没有返回有效内容");
        database.appendMessage(sessionId, requestId, "opponent", reply.trim());
        clearTimeout(timeout);
        if (!started) streamHeaders(response);
        return response.end();
      } catch (error) {
        clearTimeout(timeout);
        logModelError("会话争吵方", error, { sessionId, sceneId: scene.id, endpoint: buildEndpoint(config.baseUrl, "/chat/completions"), model: config.model });
        if (started) return response.destroy(error);
        return sendJson(response, 502, { error: error.message });
      } finally {
        database.releaseSession(sessionId, lockToken);
      }
    }

    if (action === "coach" && request.method === "POST") {
      const payload = await getBody(request);
      const requestId = String(payload.requestId || "");
      if (!validRequestId(requestId)) return sendJson(response, 400, { error: "缺少有效的 requestId" });
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
      if (messages.filter((message) => message.role === "user").length < 2) return sendJson(response, 400, { error: "至少完成两轮表达后才能生成有效复盘。" });
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
      return sendJson(response, 200, { message, endpoint: buildEndpoint(testConfig.imageBaseUrl || testConfig.baseUrl, "/images/generations") });
    } catch (error) {
      logModelError("图片测试", error, { endpoint: buildEndpoint(testConfig.imageBaseUrl || testConfig.baseUrl, "/images/generations"), model: testConfig.imageModel });
      return sendJson(response, 502, { error: error.message });
    }
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
  ".webp": "image/webp"
};
const publicFiles = new Set(["index.html", "admin.html", "admin.js", "create.html", "create.js", "lobby.js", "scene.html", "scene.js", "styles.css"]);

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

    const sceneAsset = pathname.match(/^\/scene-assets\/([a-z0-9-]+)\/(background\.(?:png|jpg|webp))$/);
    if (sceneAsset) {
      const packageDir = publishedSceneDir(sceneAsset[1]);
      const assetPath = path.join(packageDir, sceneAsset[2]);
      if (fs.existsSync(path.join(packageDir, "scene.json")) && fs.existsSync(assetPath)) return sendFile(response, assetPath);
      response.writeHead(404); return response.end("Not found");
    }

    const fileName = pathname === "/" ? "index.html" : pathname === "/create" ? "create.html" : pathname.startsWith("/scene/") ? "scene.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
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
