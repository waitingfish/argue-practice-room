const form = document.querySelector("#createForm");
const input = document.querySelector("#scenarioInput");
const button = document.querySelector("#createButton");
const progress = document.querySelector("#generationProgress");
const progressBar = document.querySelector("#progressBar");
const status = document.querySelector("#createStatus");
const reference = document.querySelector("#jobReference");
const note = document.querySelector("#createNote");
const storageKey = "argue-scene-generation-job";

let eventSource = null;
let pollTimer = null;

function readPending() {
  try { return JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { return null; }
}

function savePending(value) {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

function clearPending() {
  localStorage.removeItem(storageKey);
}

function sceneIdFromUrl(url) {
  return String(url || "").split("/").filter(Boolean).at(-1) || "";
}

async function saveCreatedScene(job) {
  if (!job?.sceneUrl) return;
  const id = sceneIdFromUrl(job.sceneUrl);
  let scene = {
    id,
    url: job.sceneUrl,
    title: input.value.trim().slice(0, 36) || "新造的场景",
    art: "assets/sketch-default/home-card.webp",
    createdAt: new Date().toISOString()
  };

  try {
    const response = await fetch(`/api/scenes/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.ok) {
      const detail = await response.json();
      scene = {
        ...scene,
        title: detail.title || scene.title,
        art: detail.thumbnailArt || detail.art || scene.art
      };
    }
  } catch {
    // The scene URL is enough for the local history; details can be missing during a transient refresh.
  }

  window.createdScenesStore.upsert(scene);
}

function stopUpdates() {
  if (eventSource) eventSource.close();
  if (pollTimer) clearInterval(pollTimer);
  eventSource = null;
  pollTimer = null;
}

function renderJob(job) {
  progress.hidden = false;
  progressBar.style.width = `${Math.max(0, Math.min(100, Number(job.progress || 0)))}%`;
  status.textContent = job.message || "正在生成场景";
  reference.textContent = job.id ? `任务 ${job.id.slice(0, 18)}` : "";
  button.disabled = !["failed", "completed"].includes(job.status);
  button.textContent = job.status === "failed" ? "重新生成" : "正在把 TA 叫出来…";

  if (job.status === "completed" && job.sceneUrl) {
    stopUpdates();
    clearPending();
    status.textContent = "完整场景已生成，正在进入…";
    saveCreatedScene(job).finally(() => {
      location.href = job.sceneUrl;
    });
  } else if (job.status === "failed") {
    stopUpdates();
    clearPending();
    status.textContent = `生成失败：${job.error || "请稍后重试"}`;
    note.textContent = "失败任务不会发布半成品，也不会占用场景地址。";
  }
}

async function pollJob(jobId) {
  try {
    const response = await fetch(`/api/scene-jobs/${jobId}`, { cache: "no-store" });
    if (!response.ok) throw new Error("无法查询生成任务");
    renderJob(await response.json());
  } catch (error) {
    status.textContent = `${error.message}，正在重试…`;
  }
}

function startPolling(jobId) {
  if (pollTimer) return;
  pollJob(jobId);
  pollTimer = setInterval(() => pollJob(jobId), 2000);
}

function subscribe(jobId, eventsUrl = `/api/scene-jobs/${jobId}/events`) {
  stopUpdates();
  const pending = readPending();
  if (pending) savePending({ ...pending, jobId, eventsUrl });
  eventSource = new EventSource(eventsUrl);

  const receive = (event) => {
    try { renderJob(JSON.parse(event.data)); } catch { status.textContent = "收到无效的任务状态"; }
  };
  eventSource.addEventListener("snapshot", receive);
  eventSource.addEventListener("progress", receive);
  eventSource.addEventListener("completed", receive);
  eventSource.addEventListener("failed", receive);
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    startPolling(jobId);
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  const opponentGender = document.querySelector("input[name=opponentGender]:checked").value;
  if (!prompt) return;

  const previous = readPending();
  const idempotencyKey = previous?.prompt === prompt && previous?.opponentGender === opponentGender
    ? previous.idempotencyKey
    : crypto.randomUUID();
  savePending({ idempotencyKey, prompt, opponentGender });
  progress.hidden = false;
  button.disabled = true;
  button.textContent = "正在创建任务…";
  status.textContent = "正在创建生成任务";
  note.textContent = "页面刷新后仍可继续查看这个任务。";

  try {
    const response = await fetch("/api/scene-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ prompt, opponentGender })
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "无法创建生成任务");
    renderJob(job);
    if (!["completed", "failed"].includes(job.status)) subscribe(job.id, job.eventsUrl);
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
    button.textContent = "重试创建任务";
  }
});

const pending = readPending();
if (pending?.jobId) {
  input.value = pending.prompt || "";
  const opponentGender = document.querySelector(`input[name=opponentGender][value="${CSS.escape(pending.opponentGender || "unspecified")}"]`);
  if (opponentGender) opponentGender.checked = true;
  progress.hidden = false;
  button.disabled = true;
  button.textContent = "正在恢复任务…";
  status.textContent = "正在恢复上次的生成任务";
  subscribe(pending.jobId, pending.eventsUrl);
}
