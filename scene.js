const slug = location.pathname.split("/").pop();
const page = document.querySelector(".scene-page");
const conversation = document.querySelector("#conversation");
const input = document.querySelector("#replyInput");
const submit = document.querySelector("#submitButton");
const coachToggle = document.querySelector("#coachToggle");
const reviewButton = document.querySelector("#reviewButton");
const modelState = document.querySelector("#modelState");
const analysisLoading = document.querySelector("#analysisLoading");
const analysisReport = document.querySelector("#analysisReport");
const sessionStorageKey = `argue-practice-session:${slug}`;

let scene = null;
let activeSession = null;
let sessionMessages = [];
let modelReady = false;
let coachMode = false;
let busy = false;
let analysisBusy = false;
let analyzedVersion = 0;

function userTurnCount() {
  return sessionMessages.filter((message) => message.role === "user").length;
}

function setArt(file) {
  document.documentElement.style.setProperty("--scene-art", `url("/${file.includes("/") ? file : `assets/${file}`}")`);
}

function roleLabel(role) {
  if (role === "user") return "你";
  if (role === "coach") return "帮忙专家";
  return "争吵方";
}

function addLine(role, text = "") {
  const element = document.createElement("article");
  element.className = `line ${role === "user" ? "self-line" : role === "coach" ? "coach-line" : "opponent-line"}`;
  const label = document.createElement("span");
  label.textContent = roleLabel(role);
  const content = document.createElement("p");
  content.textContent = text;
  element.append(label, content);
  conversation.append(element);
  element.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return content;
}

function renderMessages(messages) {
  conversation.replaceChildren();
  for (const message of messages) addLine(message.role, message.content);
}

function sessionHeaders(extra = {}) {
  return { "X-Session-Token": activeSession.token, ...extra };
}

function updateCoachToggle() {
  coachToggle.classList.toggle("active", coachMode);
  coachToggle.setAttribute("aria-pressed", String(coachMode));
  coachToggle.textContent = coachMode ? "有人帮忙" : "找人帮忙";
}

function updateReviewButton() {
  const available = userTurnCount() >= 2 && !busy && !analysisBusy;
  reviewButton.disabled = !available;
  reviewButton.title = available ? "让复盘分析师总结这次练习" : "完成两轮表达后可复盘";
}

function setReadyState(message) {
  const sessionRef = activeSession?.id ? ` · 会话 ${activeSession.id.slice(8, 14)}` : "";
  if (!modelReady) modelState.textContent = `本地演练模式 · 对话已持久化${sessionRef}`;
  else modelState.textContent = `${message || "争吵方已连接"}${coachMode ? " · 帮忙专家已加入" : ""}${sessionRef}`;
}

async function readStream(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
    onText(result);
  }
  const tail = decoder.decode();
  if (tail) {
    result += tail;
    onText(result);
  }
  return result.trim();
}

async function loadSessionState() {
  const response = await fetch(`/api/sessions/${activeSession.id}`, { headers: sessionHeaders(), cache: "no-store" });
  if (!response.ok) throw new Error("会话无法恢复");
  const state = await response.json();
  coachMode = Boolean(state.coachEnabled);
  sessionMessages = state.messages || [];
  renderMessages(sessionMessages);
  updateCoachToggle();
  updateReviewButton();
  return state;
}

async function createSession() {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sceneId: scene.id })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "无法创建练习会话");
  activeSession = { id: data.session.id, token: data.token };
  sessionStorage.setItem(sessionStorageKey, JSON.stringify(activeSession));
  coachMode = Boolean(data.session.coachEnabled);
  sessionMessages = data.messages || [];
  renderMessages(sessionMessages);
  updateCoachToggle();
  updateReviewButton();
}

async function restoreOrCreateSession() {
  try {
    activeSession = JSON.parse(sessionStorage.getItem(sessionStorageKey) || "null");
  } catch {
    activeSession = null;
  }
  if (activeSession?.id && activeSession?.token) {
    try {
      await loadSessionState();
      return;
    } catch {
      sessionStorage.removeItem(sessionStorageKey);
      activeSession = null;
    }
  }
  await createSession();
}

async function streamAgent(action, role, payload) {
  const response = await fetch(`/api/sessions/${activeSession.id}/${action}`, {
    method: "POST",
    headers: sessionHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "智能体暂时无法回应");
  }
  const content = addLine(role, "");
  const result = await readStream(response, (text) => {
    content.textContent = text || " ";
    content.parentElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  if (!result) throw new Error("智能体没有返回有效内容");
  return result;
}

async function askCoach(requestId = `coach-${crypto.randomUUID()}`) {
  if (!coachMode) return "";
  modelState.textContent = "帮忙专家正在看这一步…";
  const advice = await streamAgent("coach", "coach", { requestId });
  sessionMessages.push({ role: "coach", content: advice, requestId });
  return advice;
}

function renderList(id, items) {
  const list = document.querySelector(`#${id}`);
  list.replaceChildren();
  for (const item of items || []) {
    const row = document.createElement("li");
    row.textContent = item;
    list.append(row);
  }
}

function renderReport(report, model) {
  document.querySelector("#reportModel").textContent = `${model} · 复盘分析师`;
  document.querySelector("#reportOverview").textContent = report.overview;
  document.querySelector("#reportTurningPoint").textContent = report.turningPoint;
  document.querySelector("#personalitySummary").textContent = report.personality.summary;
  document.querySelector("#suggestedReply").textContent = report.suggestedReply;
  document.querySelector("#reportDisclaimer").textContent = report.disclaimer;
  const scoreGrid = document.querySelector("#scoreGrid");
  scoreGrid.replaceChildren();
  const labels = { clarity: "表达清晰", boundary: "边界明确", emotionalControl: "情绪稳定", listening: "回应对焦" };
  for (const [key, label] of Object.entries(labels)) {
    const item = document.createElement("div");
    const heading = document.createElement("p");
    heading.textContent = label;
    const value = document.createElement("strong");
    value.textContent = report.scores[key];
    const track = document.createElement("span");
    const fill = document.createElement("i");
    fill.style.width = `${report.scores[key]}%`;
    track.append(fill);
    item.append(heading, value, track);
    scoreGrid.append(item);
  }
  const traits = document.querySelector("#traitList");
  traits.replaceChildren();
  const traitItems = Array.isArray(report.personality.traits) && report.personality.traits.length ? report.personality.traits : [
    { name: "样本不足", evidence: "本次用户原文不足以支撑稳定倾向判断。", caveat: "仍可参考上面的过程复盘和下一步建议。" }
  ];
  for (const trait of traitItems) {
    const item = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = trait.name;
    const evidence = document.createElement("blockquote");
    evidence.textContent = trait.evidence;
    const caveat = document.createElement("p");
    caveat.textContent = trait.caveat;
    item.append(title, evidence, caveat);
    traits.append(item);
  }
  renderList("strengthList", report.strengths);
  renderList("riskList", report.risks);
  renderList("nextStepList", report.nextSteps);
  analysisLoading.hidden = true;
  analysisReport.hidden = false;
}

async function openReview() {
  if (userTurnCount() < 2 || busy || analysisBusy) return;
  page.dataset.phase = "review";
  const currentVersion = sessionMessages.filter((message) => message.role !== "coach").length;
  if (analyzedVersion === currentVersion && !analysisReport.hidden) return;
  analysisBusy = true;
  updateReviewButton();
  analysisLoading.hidden = false;
  analysisLoading.querySelector("p").textContent = "正在把这场对话重新看一遍…";
  analysisReport.hidden = true;
  try {
    const response = await fetch(`/api/sessions/${activeSession.id}/analyze`, {
      method: "POST",
      headers: sessionHeaders({ "Content-Type": "application/json" }),
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "复盘生成失败");
    renderReport(data.report, data.model);
    analyzedVersion = currentVersion;
  } catch (error) {
    analysisLoading.querySelector("p").textContent = `复盘失败：${error.message}`;
  } finally {
    analysisBusy = false;
    updateReviewButton();
  }
}

async function load() {
  const response = await fetch(`/api/scenes/${slug}`);
  if (!response.ok) return location.replace("/");
  scene = await response.json();
  setArt(scene.art);
  ["introOne", "introTwo", "introThree"].forEach((id, index) => document.querySelector(`#${id}`).textContent = scene.introLines[index]);
  document.querySelector("#sceneKicker").textContent = scene.kicker;
  document.querySelector("#arenaTitle").textContent = scene.title;
  document.querySelector("#arenaIntro").textContent = scene.intro;
  const status = await fetch("/api/status").then((item) => item.json()).catch(() => ({}));
  modelReady = Boolean(status.configured);
  await restoreOrCreateSession();
  setReadyState(status.model ? `三个智能体已连接 · ${status.model} · 对话流式` : "");
}

document.querySelector("#continueScene").addEventListener("click", () => {
  page.dataset.phase = "arena";
  input.focus();
});

coachToggle.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  coachToggle.disabled = true;
  const previousMode = coachMode;
  try {
    coachMode = !previousMode;
    const response = await fetch(`/api/sessions/${activeSession.id}`, {
      method: "PATCH",
      headers: sessionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ coachEnabled: coachMode })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法更新帮忙状态");
    updateCoachToggle();
    if (coachMode && userTurnCount() > 0) {
      try { await askCoach(); } catch (error) { addLine("coach", `找人失败：${error.message}`); }
    }
  } catch (error) {
    coachMode = previousMode;
    updateCoachToggle();
    addLine("coach", `找人失败：${error.message}`);
  } finally {
    busy = false;
    coachToggle.disabled = false;
    updateReviewButton();
    setReadyState();
    input.focus();
  }
});

reviewButton.addEventListener("click", openReview);
document.querySelector("#returnPractice").addEventListener("click", () => {
  page.dataset.phase = "arena";
  input.focus();
});
document.querySelector("#restartPractice").addEventListener("click", () => {
  sessionStorage.removeItem(sessionStorageKey);
  location.reload();
});

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!busy) document.querySelector("#replyForm").requestSubmit();
});

document.querySelector("#replyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const text = input.value.trim();
  if (!text) return;
  const requestId = `message-${crypto.randomUUID()}`;
  addLine("user", text);
  sessionMessages.push({ role: "user", content: text, requestId });
  input.value = "";
  busy = true;
  submit.disabled = true;
  coachToggle.disabled = true;
  submit.textContent = "...";
  updateReviewButton();
  try {
    modelState.textContent = "争吵方正在回应…";
    const opponentReply = await streamAgent("messages", "opponent", { content: text, requestId });
    sessionMessages.push({ role: "opponent", content: opponentReply, requestId });
    if (coachMode) await askCoach(`coach-${requestId}`);
  } catch (error) {
    await loadSessionState().catch(() => {});
    addLine("opponent", `练习暂停：${error.message}`);
  } finally {
    busy = false;
    submit.disabled = false;
    coachToggle.disabled = false;
    submit.textContent = "说";
    updateReviewButton();
    setReadyState();
    input.focus();
  }
});

updateCoachToggle();
load().catch((error) => {
  modelState.textContent = `会话初始化失败：${error.message}`;
});
