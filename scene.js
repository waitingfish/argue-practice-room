const slug = location.pathname.split("/").pop();
const page = document.querySelector(".scene-page");
const conversation = document.querySelector("#conversation");
const input = document.querySelector("#replyInput");
const submit = document.querySelector("#submitButton");
const coachToggle = document.querySelector("#coachToggle");
const reviewButton = document.querySelector("#reviewButton");
const voiceReviewButton = document.querySelector("#voiceReviewButton");
const modelState = document.querySelector("#modelState");
const analysisLoading = document.querySelector("#analysisLoading");
const analysisReport = document.querySelector("#analysisReport");
const recordButton = document.querySelector("#recordButton");
const voiceOrbit = document.querySelector("#voiceOrbit");
const voiceStatus = document.querySelector("#voiceStatus");
const voiceHint = document.querySelector("#voiceHint");
const speechPlayer = document.querySelector("#speechPlayer");

let scene = null;
let serviceStatus = {};
let activeSession = null;
let sessionMessages = [];
let currentMode = "";
let modelReady = false;
let coachMode = false;
let busy = false;
let analysisBusy = false;
let analyzedVersion = 0;
let mediaRecorder = null;
let microphoneStream = null;
let recordedChunks = [];
let activeAudioUrl = "";

function sessionStorageKey(mode = currentMode) {
  return `argue-practice-session:${slug}:${mode}`;
}

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
  voiceReviewButton.disabled = !available;
  const title = available ? "让复盘分析师总结这次练习" : "完成两轮表达后可复盘";
  reviewButton.title = title;
  voiceReviewButton.title = title;
}

function setReadyState(message) {
  const sessionRef = activeSession?.id ? ` · 会话 ${activeSession.id.slice(8, 14)}` : "";
  if (!modelReady) modelState.textContent = `本地演练模式 · 对话已持久化${sessionRef}`;
  else modelState.textContent = `${message || "争吵方已连接"}${coachMode ? " · 帮忙专家已加入" : ""}${sessionRef}`;
}

function setVoiceState(state, status, hint = "") {
  voiceOrbit.dataset.state = state;
  voiceStatus.textContent = status;
  if (hint) voiceHint.textContent = hint;
  recordButton.disabled = ["thinking", "speaking", "transcribing"].includes(state);
  recordButton.setAttribute("aria-label", state === "recording" ? "结束录音" : "开始录音");
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
  result += decoder.decode();
  onText(result);
  return result.trim();
}

async function loadSessionState() {
  const response = await fetch(`/api/sessions/${activeSession.id}`, { headers: sessionHeaders(), cache: "no-store" });
  if (!response.ok) throw new Error("会话无法恢复");
  const state = await response.json();
  if (state.mode !== currentMode) throw new Error("会话模式不匹配");
  coachMode = currentMode === "training" && Boolean(state.coachEnabled);
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
    body: JSON.stringify({ sceneId: scene.id, mode: currentMode })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "无法创建练习会话");
  activeSession = { id: data.session.id, token: data.token };
  sessionStorage.setItem(sessionStorageKey(), JSON.stringify(activeSession));
  coachMode = false;
  sessionMessages = data.messages || [];
  renderMessages(sessionMessages);
  updateCoachToggle();
  updateReviewButton();
}

async function restoreOrCreateSession() {
  try { activeSession = JSON.parse(sessionStorage.getItem(sessionStorageKey()) || "null"); } catch { activeSession = null; }
  if (activeSession?.id && activeSession?.token) {
    try {
      const state = await loadSessionState();
      if (state.status === "reviewed") {
        sessionStorage.removeItem(sessionStorageKey());
        activeSession = null;
        await createSession();
      }
      return;
    } catch {
      sessionStorage.removeItem(sessionStorageKey());
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
  if (!coachMode || currentMode !== "training") return "";
  modelState.textContent = "帮忙专家正在看这一步…";
  const advice = await streamAgent("coach", "coach", { requestId });
  sessionMessages.push({ role: "coach", content: advice, requestId });
  return advice;
}

function browserSpeak(text) {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) return reject(new Error("浏览器不支持备用语音播放"));
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.onend = resolve;
    utterance.onerror = () => reject(new Error("浏览器备用语音播放失败"));
    speechSynthesis.speak(utterance);
  });
}

async function speakText(text, requestId = "") {
  setVoiceState("speaking", "争吵方正在说话…", "听完后，点麦克风回应");
  try {
    if (!serviceStatus.immersiveConfigured) {
      await browserSpeak(text);
      return;
    }
    const response = await fetch(`/api/sessions/${activeSession.id}/speech`, {
      method: "POST",
      headers: sessionHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: text, requestId })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "语音合成失败");
    }
    if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = URL.createObjectURL(await response.blob());
    speechPlayer.src = activeAudioUrl;
    const finished = new Promise((resolve, reject) => {
      speechPlayer.onended = resolve;
      speechPlayer.onerror = () => reject(new Error("生成的音频无法播放"));
    });
    await speechPlayer.play();
    await finished;
  } catch (error) {
    voiceStatus.textContent = `远程语音失败，使用浏览器声音：${error.message}`;
    await browserSpeak(text);
  } finally {
    setVoiceState("idle", "轮到你了", "点一下开始说，再点一下结束");
  }
}

function preferredRecordingType() {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function ensureMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) throw new Error("当前浏览器不支持录音，请使用最新版 Edge、Chrome 或 Safari");
  if (!microphoneStream || microphoneStream.getTracks().every((track) => track.readyState === "ended")) {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }
  return microphoneStream;
}

async function startRecording() {
  try {
    const stream = await ensureMicrophone();
    recordedChunks = [];
    const mimeType = preferredRecordingType();
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => { if (event.data.size) recordedChunks.push(event.data); };
    mediaRecorder.onstop = processRecording;
    mediaRecorder.start(250);
    setVoiceState("recording", "正在听你说…", "说完后再点一下");
  } catch (error) {
    setVoiceState("error", `无法开始录音：${error.message}`, "请允许麦克风权限后重试");
  }
}

function stopRecording() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    setVoiceState("transcribing", "正在识别你说的话…", "录音只发送给已配置的识别服务");
  }
}

function encodePcmWav(audioBuffer) {
  const samples = audioBuffer.getChannelData(0);
  const wav = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(wav);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([wav], { type: "audio/wav" });
}

async function convertRecordingToWav(recording) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const OfflineContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineContextClass) throw new Error("当前浏览器无法转换录音格式，请升级浏览器后重试");
  const decoder = new AudioContextClass();
  try {
    const decoded = await decoder.decodeAudioData(await recording.arrayBuffer());
    const frameCount = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineContextClass(1, frameCount, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    return encodePcmWav(await offline.startRendering());
  } finally {
    await decoder.close().catch(() => {});
  }
}

async function processRecording() {
  busy = true;
  updateReviewButton();
  const mimeType = mediaRecorder.mimeType || recordedChunks[0]?.type || "audio/webm";
  const recording = new Blob(recordedChunks, { type: mimeType });
  try {
    const audio = await convertRecordingToWav(recording);
    const transcriptionResponse = await fetch(`/api/sessions/${activeSession.id}/transcriptions`, {
      method: "POST",
      headers: sessionHeaders({ "Content-Type": "audio/wav" }),
      body: audio
    });
    const transcription = await transcriptionResponse.json().catch(() => ({}));
    if (!transcriptionResponse.ok) throw new Error(transcription.error || "语音识别失败");
    const text = String(transcription.text || "").trim();
    if (!text) throw new Error("没有识别到清楚的话，请再说一次");
    const requestId = `voice-${crypto.randomUUID()}`;
    addLine("user", text);
    sessionMessages.push({ role: "user", content: text, requestId });
    setVoiceState("thinking", "争吵方正在回应…", `识别结果：${text}`);
    const reply = await streamAgent("messages", "opponent", { content: text, requestId });
    sessionMessages.push({ role: "opponent", content: reply, requestId });
    await speakText(reply, requestId);
  } catch (error) {
    await loadSessionState().catch(() => {});
    setVoiceState("error", `这一轮失败：${error.message}`, "点麦克风重新说一次");
  } finally {
    busy = false;
    updateReviewButton();
  }
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
    const heading = document.createElement("p"); heading.textContent = label;
    const value = document.createElement("strong"); value.textContent = report.scores[key];
    const track = document.createElement("span");
    const fill = document.createElement("i"); fill.style.width = `${report.scores[key]}%`;
    track.append(fill); item.append(heading, value, track); scoreGrid.append(item);
  }
  const traits = document.querySelector("#traitList");
  traits.replaceChildren();
  const traitItems = Array.isArray(report.personality.traits) && report.personality.traits.length ? report.personality.traits : [{ name: "样本不足", evidence: "本次用户原文不足以支撑稳定倾向判断。", caveat: "仍可参考上面的过程复盘和下一步建议。" }];
  for (const trait of traitItems) {
    const item = document.createElement("article");
    const title = document.createElement("h3"); title.textContent = trait.name;
    const evidence = document.createElement("blockquote"); evidence.textContent = trait.evidence;
    const caveat = document.createElement("p"); caveat.textContent = trait.caveat;
    item.append(title, evidence, caveat); traits.append(item);
  }
  renderList("strengthList", report.strengths);
  renderList("riskList", report.risks);
  renderList("nextStepList", report.nextSteps);
  analysisLoading.hidden = true;
  analysisReport.hidden = false;
}

async function openReview() {
  if (userTurnCount() < 2 || busy || analysisBusy) return;
  window.speechSynthesis?.cancel();
  speechPlayer.pause();
  page.dataset.phase = "review";
  const currentVersion = sessionMessages.filter((message) => message.role !== "coach").length;
  if (analyzedVersion === currentVersion && !analysisReport.hidden) return;
  analysisBusy = true;
  updateReviewButton();
  analysisLoading.hidden = false;
  analysisLoading.querySelector("p").textContent = "正在把这场对话重新看一遍…";
  analysisReport.hidden = true;
  try {
    const response = await fetch(`/api/sessions/${activeSession.id}/analyze`, { method: "POST", headers: sessionHeaders({ "Content-Type": "application/json" }), body: "{}" });
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

async function startMode(mode) {
  if (busy) return;
  currentMode = mode;
  page.dataset.mode = mode;
  page.dataset.phase = "arena";
  busy = true;
  try {
    await restoreOrCreateSession();
    setReadyState(serviceStatus.model ? `三个智能体已连接 · ${serviceStatus.model} · 对话流式` : "");
    if (mode === "training") input.focus();
    else {
      const lastOpponent = [...sessionMessages].reverse().find((message) => message.role === "opponent");
      await speakText(lastOpponent?.content || scene.opponent, lastOpponent?.requestId || "opening");
    }
  } catch (error) {
    if (mode === "training") modelState.textContent = `会话初始化失败：${error.message}`;
    else setVoiceState("error", `沉浸模式初始化失败：${error.message}`, "请检查后台语音配置");
  } finally {
    busy = false;
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
  document.querySelector("#modeKicker").textContent = scene.kicker;
  document.querySelector("#arenaTitle").textContent = scene.title;
  document.querySelector("#arenaIntro").textContent = scene.intro;
  serviceStatus = await fetch("/api/status").then((item) => item.json()).catch(() => ({}));
  modelReady = Boolean(serviceStatus.configured);
  if (!serviceStatus.immersiveConfigured) document.querySelector("#modeNote").textContent = "沉浸模式的语音合成尚未配置，将临时使用浏览器声音；语音识别仍需后台配置。";
}

document.querySelector("#continueScene").addEventListener("click", () => { page.dataset.phase = "mode"; });
document.querySelectorAll("[data-mode-choice]").forEach((button) => button.addEventListener("click", () => startMode(button.dataset.modeChoice)));

coachToggle.addEventListener("click", async () => {
  if (busy || currentMode !== "training") return;
  busy = true;
  coachToggle.disabled = true;
  const previousMode = coachMode;
  try {
    coachMode = !previousMode;
    const response = await fetch(`/api/sessions/${activeSession.id}`, { method: "PATCH", headers: sessionHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ coachEnabled: coachMode }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法更新帮忙状态");
    updateCoachToggle();
    if (coachMode && userTurnCount() > 0) await askCoach();
  } catch (error) {
    coachMode = previousMode;
    updateCoachToggle();
    addLine("coach", `找人失败：${error.message}`);
  } finally {
    busy = false; coachToggle.disabled = false; updateReviewButton(); setReadyState(); input.focus();
  }
});

reviewButton.addEventListener("click", openReview);
voiceReviewButton.addEventListener("click", openReview);
document.querySelector("#restartPractice").addEventListener("click", () => {
  sessionStorage.removeItem(sessionStorageKey("training"));
  sessionStorage.removeItem(sessionStorageKey("immersive"));
  location.reload();
});

recordButton.addEventListener("click", () => {
  if (mediaRecorder?.state === "recording") stopRecording();
  else if (!busy) startRecording();
});

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!busy) document.querySelector("#replyForm").requestSubmit();
});

document.querySelector("#replyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || currentMode !== "training") return;
  const text = input.value.trim();
  if (!text) return;
  const requestId = `message-${crypto.randomUUID()}`;
  addLine("user", text);
  sessionMessages.push({ role: "user", content: text, requestId });
  input.value = "";
  busy = true; submit.disabled = true; coachToggle.disabled = true; submit.textContent = "..."; updateReviewButton();
  try {
    modelState.textContent = "争吵方正在回应…";
    const opponentReply = await streamAgent("messages", "opponent", { content: text, requestId });
    sessionMessages.push({ role: "opponent", content: opponentReply, requestId });
    if (coachMode) await askCoach(`coach-${requestId}`);
  } catch (error) {
    await loadSessionState().catch(() => {});
    addLine("opponent", `练习暂停：${error.message}`);
  } finally {
    busy = false; submit.disabled = false; coachToggle.disabled = false; submit.textContent = "说"; updateReviewButton(); setReadyState(); input.focus();
  }
});

window.addEventListener("beforeunload", () => {
  microphoneStream?.getTracks().forEach((track) => track.stop());
  if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
});

updateCoachToggle();
load().catch((error) => { modelState.textContent = `场景初始化失败：${error.message}`; });
