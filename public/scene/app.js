const slug = location.pathname.split("/").pop();
const page = document.querySelector(".scene-page");
const conversation = document.querySelector("#conversation");
const input = document.querySelector("#replyInput");
const submit = document.querySelector("#submitButton");
const coachToggle = document.querySelector("#coachToggle");
const trainingEndButton = document.querySelector("#trainingEndButton");
const reviewButton = document.querySelector("#reviewButton");
const reviewTooltip = document.querySelector("#reviewTooltip");
const voiceEndButton = document.querySelector("#voiceEndButton");
const immersivePrelude = document.querySelector("#immersivePrelude");
const immersiveBegin = document.querySelector("#immersiveBegin");
const modelState = document.querySelector("#modelState");
const analysisLoading = document.querySelector("#analysisLoading");
const analysisReport = document.querySelector("#analysisReport");
const recordButton = document.querySelector("#recordButton");
const voiceBox = document.querySelector("#voiceBox");
const voiceOrbit = document.querySelector("#voiceOrbit");
const voiceStatus = document.querySelector("#voiceStatus");
const voiceHint = document.querySelector("#voiceHint");
const speechPlayer = document.querySelector("#speechPlayer");
const argumentOutcome = document.querySelector("#argumentOutcome");
const outcomeDialog = document.querySelector("#outcomeDialog");
const outcomeContinue = document.querySelector("#outcomeContinue");
const outcomeSaveReplay = document.querySelector("#outcomeSaveReplay");
const outcomeSaveStatus = document.querySelector("#outcomeSaveStatus");
const opponentFigure = document.querySelector("#opponentFigure");

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
let speechAudioContext = null;
let scheduledSpeechTime = 0;
let voiceMonitorContext = null;
let voiceMonitorSource = null;
let voiceAnalyser = null;
let voiceSamples = null;
let voiceMonitorFrame = 0;
let autoListening = false;
let autoRecording = false;
let autoRecordingStarting = false;
let autoSpeechStartedAt = 0;
let autoLastVoiceAt = 0;
let argumentEnded = false;
let endingImmersive = false;
let immersiveStartPending = false;
let immersivePreludeTimer = 0;
let pendingTrainingTurn = null;
let pendingVoiceTurn = null;
const reviewRequiredTurns = 5;
const autoVoiceStartLevel = 0.035;
const autoVoiceStopLevel = 0.018;
const autoVoiceSilenceMs = 1100;
const autoVoiceMinSpeechMs = 450;
const autoVoiceIdleReminderMs = 18000;

function sessionStorageKey(mode = currentMode) {
  return `argue-practice-session:${slug}:${mode}`;
}

function userTurnCount() {
  return sessionMessages.filter((message) => message.role === "user").length;
}

function hasCompletedRequest(requestId) {
  return sessionMessages.some((message) => message.requestId === requestId && message.role === "opponent");
}

function reviewUnavailableReason() {
  if (currentMode !== "training") return "复盘只在训练模式中使用";
  if (analysisBusy) return "复盘正在生成，请稍候";
  if (busy) return "争吵方还在回应，等这一轮结束后再复盘";
  const remaining = Math.max(0, reviewRequiredTurns - userTurnCount());
  if (remaining > 0) return `还差 ${remaining} 轮对话；完成 5 轮后可复盘`;
  return "";
}

function setArt(file) {
  document.documentElement.style.setProperty("--scene-art", `url("/${file.includes("/") ? file : `assets/${file}`}")`);
}

function imageUrl(file) {
  const value = String(file || "").trim();
  if (!value) return "";
  return value.startsWith("/") ? value : `/${value.includes("/") ? value : `assets/${value}`}`;
}

function roleLabel(role) {
  if (role === "user") return "你";
  if (role === "coach") return "帮忙专家";
  return "争吵方";
}

function showLatestLineOnly() {
  return currentMode === "immersive" && page.dataset.immersiveStarted === "true";
}

function displayMessages(messages) {
  if (!showLatestLineOnly()) return messages;
  const latest = [...messages].reverse().find((message) => message.role !== "coach");
  return latest ? [latest] : [];
}

function addLine(role, text = "") {
  if (showLatestLineOnly() && role !== "coach") conversation.replaceChildren();
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
  for (const message of displayMessages(messages)) addLine(message.role, message.content);
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
  const reason = reviewUnavailableReason();
  const available = currentMode === "training" && !reason;
  reviewButton.disabled = !available;
  reviewButton.title = available ? "让复盘分析师总结这次练习" : reason;
  reviewTooltip.dataset.tooltip = available ? "让复盘分析师总结这次练习" : reason;
  reviewTooltip.dataset.disabled = String(!available);
  trainingEndButton.disabled = currentMode !== "training" || busy || analysisBusy;
  voiceEndButton.disabled = endingImmersive;
  voiceEndButton.title = "结束本次沉浸对话并清除内容";
}

function setReadyState(message) {
  const sessionRef = activeSession?.id ? ` · 会话 ${activeSession.id.slice(8, 14)}` : "";
  if (!modelReady) modelState.textContent = currentMode === "immersive" ? `本地演练模式 · 离开即清除${sessionRef}` : `本地演练模式 · 对话已持久化${sessionRef}`;
  else modelState.textContent = `${message || "争吵方已连接"}${coachMode ? " · 帮忙专家已加入" : ""}${sessionRef}`;
}

function setVoiceState(state, status, hint = "") {
  voiceBox.dataset.state = state;
  voiceOrbit.dataset.state = state;
  voiceStatus.textContent = status;
  if (hint) voiceHint.textContent = hint;
  if (recordButton) {
    recordButton.disabled = ["thinking", "speaking", "transcribing"].includes(state);
    recordButton.setAttribute("aria-label", state === "recording" ? "结束录音" : "开始录音");
  }
  if (!["listening", "recording"].includes(state)) setVoiceLevel(0);
}

function setVoiceLevel(level) {
  const normalized = Math.max(0, Math.min(1, level));
  voiceOrbit.style.setProperty("--voice-level", normalized.toFixed(3));
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
  argumentEnded = state.status === "ended" && state.latestVerdict?.verdict?.status === "won";
  renderMessages(sessionMessages);
  updateCoachToggle();
  updateReviewButton();
  return state;
}

function canAutoListen() {
  return currentMode === "immersive" && activeSession?.id && page.dataset.phase === "arena" && page.dataset.immersiveStarted === "true" && !busy && !argumentEnded && !endingImmersive;
}

function showImmersivePrelude() {
  clearTimeout(immersivePreludeTimer);
  page.dataset.immersiveStarted = "false";
  immersivePrelude.hidden = false;
  immersivePrelude.classList.remove("leaving");
  immersiveBegin.disabled = false;
  setVoiceState("idle", "准备开始", "点击后对方会先开口");
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
  argumentEnded = false;
  sessionMessages = data.messages || [];
  renderMessages(sessionMessages);
  updateCoachToggle();
  updateReviewButton();
  return { ...data.session, latestVerdict: null };
}

async function restoreOrCreateSession() {
  try { activeSession = JSON.parse(sessionStorage.getItem(sessionStorageKey()) || "null"); } catch { activeSession = null; }
  if (activeSession?.id && activeSession?.token) {
    try {
      const state = await loadSessionState();
      if (state.status === "reviewed") {
        sessionStorage.removeItem(sessionStorageKey());
        activeSession = null;
        return createSession();
      }
      return state;
    } catch {
      sessionStorage.removeItem(sessionStorageKey());
      activeSession = null;
    }
  }
  return createSession();
}

async function judgeImmersiveTurn() {
  const response = await fetch(`/api/sessions/${activeSession.id}/judge`, {
    method: "POST",
    headers: sessionHeaders({ "Content-Type": "application/json" }),
    body: "{}"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "裁判暂时无法判断这一轮");
  return data.verdict;
}

function showArgumentOutcome(verdict) {
  if (!verdict || verdict.status !== "won") return;
  argumentEnded = true;
  stopAutoListening();
  window.speechSynthesis?.cancel();
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  document.querySelector("#outcomeCopy").textContent = verdict.resultCopy || "这次表达有了结果。你把真正想守住的东西说清楚了，也让对方给出了回应。";
  document.querySelector("#outcomeMood").textContent = verdict.mood?.label || "终于松了一口气";
  argumentOutcome.hidden = false;
  page.dataset.argumentEnded = "true";
  setVoiceState("ended", "裁判判定：表达目标达成", "你已经不需要继续回应");
  if (recordButton) recordButton.disabled = true;
  updateReviewButton();
  outcomeContinue.disabled = false;
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

function ensureSpeechAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("当前浏览器不支持流式语音播放");
  if (!speechAudioContext || speechAudioContext.state === "closed") speechAudioContext = new AudioContextClass();
  return speechAudioContext;
}

function decodePcm16Base64(base64, sampleRate = 24000) {
  const binary = atob(base64);
  const sampleCount = Math.floor(binary.length / 2);
  const context = ensureSpeechAudioContext();
  const audioBuffer = context.createBuffer(1, sampleCount, sampleRate);
  const channel = audioBuffer.getChannelData(0);
  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const value = (high << 8) | low;
    channel[index] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
  }
  return audioBuffer;
}

async function playPcm16Stream(response) {
  const context = ensureSpeechAudioContext();
  await context.resume();
  speechPlayer.pause();
  scheduledSpeechTime = Math.max(context.currentTime + 0.08, scheduledSpeechTime);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let lastEnded = Promise.resolve();
  const schedule = (base64) => {
    const audioBuffer = decodePcm16Base64(base64, Number(response.headers.get("x-audio-sample-rate") || 24000));
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    source.start(scheduledSpeechTime);
    scheduledSpeechTime += audioBuffer.duration;
    chunkCount += 1;
    lastEnded = new Promise((resolve) => { source.onended = resolve; });
  };
  const consumeLine = (line) => {
    if (!line.trim()) return;
    const item = JSON.parse(line);
    if (item.audio) schedule(item.audio);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!chunkCount) throw new Error("流式语音没有返回音频块");
  await lastEnded;
}

async function speakRemoteAudio(text, requestId = "") {
  const payload = JSON.stringify({ input: text, requestId });
  if (serviceStatus.speechMode === "mimo") {
    const streamResponse = await fetch(`/api/sessions/${activeSession.id}/speech-stream`, {
      method: "POST",
      headers: sessionHeaders({ "Content-Type": "application/json" }),
      body: payload
    });
    if (streamResponse.ok) {
      try {
        await playPcm16Stream(streamResponse);
        return;
      } catch {
        // 部分兼容接口会接受 stream 参数但只返回空流，继续走完整音频。
      }
    }
    if (streamResponse.status !== 409 && streamResponse.status !== 404) {
      const data = await streamResponse.json().catch(() => ({}));
      throw new Error(data.error || "流式语音合成失败");
    }
  }
  const response = await fetch(`/api/sessions/${activeSession.id}/speech`, {
    method: "POST",
    headers: sessionHeaders({ "Content-Type": "application/json" }),
    body: payload
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
}

async function speakText(text, requestId = "") {
  stopAutoListening();
  setVoiceState("speaking", "争吵方正在说话…", "听完后可以直接开口回应");
  try {
    if (!serviceStatus.immersiveConfigured) {
      await browserSpeak(text);
      return;
    }
    await speakRemoteAudio(text, requestId);
  } catch (error) {
    voiceStatus.textContent = `远程语音失败，使用浏览器声音：${error.message}`;
    await browserSpeak(text);
  } finally {
    setVoiceState("idle", "轮到你了", "直接说话，系统会自动发送");
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

async function ensureVoiceAnalyser(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("当前浏览器不支持自动监听，请手动点击麦克风");
  if (!voiceMonitorContext || voiceMonitorContext.state === "closed") {
    voiceMonitorContext = new AudioContextClass();
    voiceMonitorSource = null;
    voiceAnalyser = null;
  }
  if (!voiceAnalyser || !voiceMonitorSource) {
    voiceMonitorSource = voiceMonitorContext.createMediaStreamSource(stream);
    voiceAnalyser = voiceMonitorContext.createAnalyser();
    voiceAnalyser.fftSize = 1024;
    voiceAnalyser.smoothingTimeConstant = 0.18;
    voiceMonitorSource.connect(voiceAnalyser);
    voiceSamples = new Uint8Array(voiceAnalyser.fftSize);
  }
  await voiceMonitorContext.resume().catch(() => {});
  return voiceAnalyser;
}

function currentVoiceLevel() {
  if (!voiceAnalyser || !voiceSamples) return 0;
  voiceAnalyser.getByteTimeDomainData(voiceSamples);
  let sum = 0;
  for (const sample of voiceSamples) {
    const value = (sample - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / voiceSamples.length);
}

function stopAutoListening() {
  autoListening = false;
  autoRecording = false;
  autoRecordingStarting = false;
  if (voiceMonitorFrame) cancelAnimationFrame(voiceMonitorFrame);
  voiceMonitorFrame = 0;
  setVoiceLevel(0);
}

function queueAutoListening(delay = 320) {
  window.setTimeout(() => {
    if (canAutoListen()) startAutoListening();
  }, delay);
}

async function beginAutoRecording() {
  if (autoRecording || autoRecordingStarting || mediaRecorder?.state === "recording") return;
  autoRecordingStarting = true;
  autoSpeechStartedAt = performance.now();
  autoLastVoiceAt = autoSpeechStartedAt;
  try {
    await startRecording({ automatic: true });
    autoRecording = mediaRecorder?.state === "recording";
  } finally {
    autoRecordingStarting = false;
  }
}

async function startAutoListening() {
  if (!canAutoListen() || autoListening || mediaRecorder?.state === "recording") return;
  try {
    const stream = await ensureMicrophone();
    await ensureVoiceAnalyser(stream);
    autoListening = true;
    autoRecording = false;
    autoRecordingStarting = false;
    let lastReminderAt = performance.now();
    setVoiceState("listening", "轮到你了，我在听…", "直接说话；停顿后会自动发送");

    const tick = () => {
      if (!autoListening) return;
      if (!canAutoListen() && mediaRecorder?.state !== "recording") {
        stopAutoListening();
        return;
      }

      const now = performance.now();
      const level = currentVoiceLevel();
      setVoiceLevel(Math.min(1, level / autoVoiceStartLevel));
      if (mediaRecorder?.state === "recording") {
        if (level >= autoVoiceStopLevel) autoLastVoiceAt = now;
        if (now - autoSpeechStartedAt >= autoVoiceMinSpeechMs && now - autoLastVoiceAt >= autoVoiceSilenceMs) {
          stopAutoListening();
          stopRecording();
          return;
        }
      } else if (level >= autoVoiceStartLevel) {
        beginAutoRecording();
      } else if (now - lastReminderAt >= autoVoiceIdleReminderMs) {
        lastReminderAt = now;
        setVoiceState("listening", "我还在听…", "开口后会自动录音，停顿后自动发送");
      }

      voiceMonitorFrame = requestAnimationFrame(tick);
    };
    voiceMonitorFrame = requestAnimationFrame(tick);
  } catch (error) {
    stopAutoListening();
    setVoiceState("idle", "自动监听不可用", `${error.message}；请检查浏览器麦克风权限`);
  }
}

async function startRecording({ automatic = false } = {}) {
  try {
    if (automatic && !canAutoListen()) return;
    const stream = await ensureMicrophone();
    recordedChunks = [];
    const mimeType = preferredRecordingType();
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => { if (event.data.size) recordedChunks.push(event.data); };
    mediaRecorder.onstop = processRecording;
    mediaRecorder.start(250);
    setVoiceState("recording", "正在听你说…", automatic ? "停顿后会自动发送" : "说完后再点一下");
  } catch (error) {
    setVoiceState("error", `无法开始录音：${error.message}`, "请允许麦克风权限后重试");
  }
}

function stopRecording() {
  if (mediaRecorder?.state === "recording") {
    stopAutoListening();
    mediaRecorder.stop();
    setVoiceState("transcribing", "正在识别你说的话…", "录音会临时与本次会话关联");
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

async function sendImmersiveText(text, requestId) {
  addLine("user", text);
  sessionMessages.push({ role: "user", content: text, requestId });
  setVoiceState("thinking", "争吵方正在回应…", `识别结果：${text}`);
  const reply = await streamAgent("messages", "opponent", { content: text, requestId });
  sessionMessages.push({ role: "opponent", content: reply, requestId });
  pendingVoiceTurn = null;
  const verdictPromise = judgeImmersiveTurn().catch((error) => ({ error }));
  await speakText(reply, requestId);
  const verdictResult = await verdictPromise;
  if (verdictResult?.error) {
    setVoiceState("idle", "裁判暂时没有完成判定", "你可以继续回应；异常详情已记录在服务端");
  } else if (verdictResult?.status === "won") {
    showArgumentOutcome(verdictResult);
  }
}

async function processRecording() {
  if (argumentEnded) return;
  stopAutoListening();
  busy = true;
  updateReviewButton();
  const mimeType = mediaRecorder.mimeType || recordedChunks[0]?.type || "audio/webm";
  const recording = new Blob(recordedChunks, { type: mimeType });
  let requestId = "";
  let text = "";
  try {
    const audio = await convertRecordingToWav(recording);
    requestId = `voice-${crypto.randomUUID()}`;
    const transcriptionResponse = await fetch(`/api/sessions/${activeSession.id}/transcriptions`, {
      method: "POST",
      headers: sessionHeaders({ "Content-Type": "audio/wav", "X-Request-Id": requestId }),
      body: audio
    });
    const transcription = await transcriptionResponse.json().catch(() => ({}));
    if (!transcriptionResponse.ok) throw new Error(transcription.error || "语音识别失败");
    text = String(transcription.text || "").trim();
    if (!text) throw new Error("没有识别到清楚的话，请再说一次");
    await sendImmersiveText(text, requestId);
  } catch (error) {
    await loadSessionState().catch(() => {});
    if (text && requestId && !hasCompletedRequest(requestId)) pendingVoiceTurn = { text, requestId };
    setVoiceState("error", `这一轮失败：${error.message}`, "点麦克风重新说一次");
  } finally {
    busy = false;
    updateReviewButton();
    if (currentMode === "immersive" && !argumentEnded && page.dataset.phase === "arena") queueAutoListening();
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
  if (!((currentMode === "training" && userTurnCount() >= reviewRequiredTurns) || (currentMode === "immersive" && argumentEnded)) || busy || analysisBusy) return;
  window.speechSynthesis?.cancel();
  speechPlayer.pause();
  if (outcomeDialog.open) outcomeDialog.close();
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
  if (mode === "immersive") page.dataset.immersiveStarted = "false";
  else delete page.dataset.immersiveStarted;
  page.dataset.phase = "arena";
  busy = true;
  try {
    const state = await restoreOrCreateSession();
    setReadyState(serviceStatus.model ? `${mode === "immersive" ? "争吵方与裁判" : "三个智能体"}已连接 · ${serviceStatus.model} · 对话流式` : "");
    if (mode === "immersive" && state?.status === "ended" && state.latestVerdict?.verdict?.status === "won") {
      page.dataset.immersiveStarted = "true";
      immersivePrelude.hidden = true;
      showArgumentOutcome(state.latestVerdict.verdict);
      return;
    }
    if (mode === "training") input.focus();
    else {
      showImmersivePrelude();
    }
  } catch (error) {
    if (mode === "training") modelState.textContent = `会话初始化失败：${error.message}`;
    else setVoiceState("error", `沉浸模式初始化失败：${error.message}`, "请检查后台语音配置");
  } finally {
    busy = false;
    updateReviewButton();
    if (mode === "immersive" && !argumentEnded && page.dataset.phase === "arena") queueAutoListening();
  }
}

async function beginImmersiveDialogue() {
  if (busy || currentMode !== "immersive" || !activeSession || argumentEnded || immersiveStartPending) return;
  immersiveStartPending = true;
  busy = true;
  immersiveBegin.disabled = true;
  page.dataset.immersiveStarted = "true";
  renderMessages(sessionMessages);
  immersivePrelude.classList.add("leaving");
  try {
    clearTimeout(immersivePreludeTimer);
    immersivePreludeTimer = window.setTimeout(() => { immersivePrelude.hidden = true; }, 620);
    const lastOpponent = [...sessionMessages].reverse().find((message) => message.role === "opponent");
    await speakText(lastOpponent?.content || scene.opponent, lastOpponent?.requestId || "opening");
  } catch (error) {
    clearTimeout(immersivePreludeTimer);
    immersivePrelude.hidden = false;
    immersivePrelude.classList.remove("leaving");
    page.dataset.immersiveStarted = "false";
    setVoiceState("error", `沉浸模式启动失败：${error.message}`, "可以稍后再试");
  } finally {
    busy = false;
    immersiveStartPending = false;
    updateReviewButton();
    if (currentMode === "immersive" && !argumentEnded && page.dataset.phase === "arena") queueAutoListening();
  }
}

function stopLocalMedia() {
  stopAutoListening();
  window.speechSynthesis?.cancel();
  speechPlayer.pause();
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  voiceMonitorSource?.disconnect();
  voiceMonitorSource = null;
  voiceAnalyser = null;
  voiceSamples = null;
  voiceMonitorContext?.close().catch(() => {});
  voiceMonitorContext = null;
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = "";
  }
}

function clearStoredSession(mode = currentMode) {
  if (mode) sessionStorage.removeItem(sessionStorageKey(mode));
}

function requestDeleteImmersiveSession({ beacon = false } = {}) {
  if (currentMode !== "immersive" || !activeSession?.id || !activeSession?.token) return;
  const url = `/api/sessions/${activeSession.id}`;
  const body = JSON.stringify({ token: activeSession.token });
  if (beacon && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon(`${url}?_method=DELETE`, blob);
    return;
  }
  fetch(url, {
    method: "DELETE",
    headers: sessionHeaders({ "Content-Type": "application/json" }),
    body: "{}",
    keepalive: true
  }).catch(() => {});
}

function finishImmersiveSession(target = "/") {
  if (endingImmersive) return;
  endingImmersive = true;
  stopLocalMedia();
  requestDeleteImmersiveSession();
  clearStoredSession("immersive");
  activeSession = null;
  location.href = target;
}

function finishTrainingSession(target = "/") {
  if (busy || analysisBusy) return;
  sessionStorage.removeItem(sessionStorageKey("training"));
  activeSession = null;
  location.href = target;
}

async function load() {
  const response = await fetch(`/api/scenes/${slug}`);
  if (!response.ok) return location.replace("/");
  scene = await response.json();
  setArt(scene.art);
  if (opponentFigure) {
    const opponentArt = imageUrl(scene.opponentArt);
    opponentFigure.hidden = !opponentArt;
    if (opponentArt) opponentFigure.src = opponentArt;
  }
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
immersiveBegin.addEventListener("click", beginImmersiveDialogue);

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

trainingEndButton.addEventListener("click", () => finishTrainingSession("/"));
reviewButton.addEventListener("click", openReview);
voiceEndButton.addEventListener("click", () => finishImmersiveSession("/"));
document.querySelector("#arenaExit").addEventListener("click", (event) => {
  if (currentMode !== "immersive") return;
  event.preventDefault();
  finishImmersiveSession("/");
});
document.querySelector("#restartPractice").addEventListener("click", () => {
  sessionStorage.removeItem(sessionStorageKey("training"));
  sessionStorage.removeItem(sessionStorageKey("immersive"));
  location.reload();
});

recordButton?.addEventListener("click", () => {
  if (argumentEnded) return;
  if (mediaRecorder?.state === "recording") stopRecording();
  else if (!busy) {
    stopAutoListening();
    if (pendingVoiceTurn) {
      const turn = pendingVoiceTurn;
      busy = true;
      updateReviewButton();
      sendImmersiveText(turn.text, turn.requestId)
        .catch(async (error) => {
          await loadSessionState().catch(() => {});
          if (!hasCompletedRequest(turn.requestId)) pendingVoiceTurn = turn;
          setVoiceState("error", `这一轮失败：${error.message}`, "点麦克风重新说一次");
        })
        .finally(() => {
          busy = false;
          updateReviewButton();
          if (currentMode === "immersive" && !argumentEnded && page.dataset.phase === "arena") queueAutoListening();
        });
    } else {
      startRecording();
    }
  }
});

document.querySelector("#outcomeLeave").addEventListener("click", () => finishImmersiveSession("/"));
outcomeContinue.addEventListener("click", () => {
  if (page.dataset.phase !== "arena" || outcomeDialog.open) return;
  outcomeContinue.disabled = true;
  outcomeDialog.showModal();
});
document.querySelector("#outcomeReview").addEventListener("click", openReview);

outcomeSaveReplay.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  outcomeSaveReplay.disabled = true;
  outcomeSaveReplay.textContent = "正在保存语音…";
  outcomeSaveStatus.textContent = "正在整理双方的文字和语音，请稍候。";
  try {
    const response = await fetch(`/api/sessions/${activeSession.id}/replay`, {
      method: "POST",
      headers: sessionHeaders({ "Content-Type": "application/json" }),
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "保存回放失败");
    const replayUrl = new URL(`/replay/${data.id}`, location.origin).href;
    clearStoredSession("immersive");
    outcomeSaveStatus.textContent = "已保存，正在打开回放页。";
    if (navigator.share) {
      await navigator.share({ title: `吵架练习室 · ${scene.title}`, text: "这是我保存的一次对话回放。", url: replayUrl }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(replayUrl).catch(() => {});
    }
    location.href = replayUrl;
  } catch (error) {
    outcomeSaveStatus.textContent = error.message;
    outcomeSaveReplay.disabled = false;
    outcomeSaveReplay.textContent = "重试保存并分享";
  } finally {
    busy = false;
  }
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
  const retrying = pendingTrainingTurn?.text === text;
  const requestId = retrying ? pendingTrainingTurn.requestId : `message-${crypto.randomUUID()}`;
  if (!retrying) pendingTrainingTurn = null;
  addLine("user", text);
  sessionMessages.push({ role: "user", content: text, requestId });
  input.value = "";
  busy = true; submit.disabled = true; coachToggle.disabled = true; submit.textContent = "..."; updateReviewButton();
  try {
    modelState.textContent = "争吵方正在回应…";
    const opponentReply = await streamAgent("messages", "opponent", { content: text, requestId });
    sessionMessages.push({ role: "opponent", content: opponentReply, requestId });
    pendingTrainingTurn = null;
    if (coachMode) await askCoach(`coach-${requestId}`);
  } catch (error) {
    await loadSessionState().catch(() => {});
    if (!hasCompletedRequest(requestId)) {
      pendingTrainingTurn = { text, requestId };
      input.value = text;
    }
    addLine("opponent", `练习暂停：${error.message}`);
  } finally {
    busy = false; submit.disabled = false; coachToggle.disabled = false; submit.textContent = "说"; updateReviewButton(); setReadyState(); input.focus();
  }
});

window.addEventListener("beforeunload", () => {
  if (currentMode === "immersive" && activeSession && !argumentEnded) {
    requestDeleteImmersiveSession({ beacon: true });
    clearStoredSession("immersive");
  }
  stopLocalMedia();
});

updateCoachToggle();
load().catch((error) => { modelState.textContent = `场景初始化失败：${error.message}`; });
