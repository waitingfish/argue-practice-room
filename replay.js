const replayId = location.pathname.split("/").filter(Boolean).at(-1);
const page = document.querySelector("#replayPage");
const timelineElement = document.querySelector("#replayTimeline");
const playButton = document.querySelector("#replayPlay");
const speedSelect = document.querySelector("#replaySpeed");
const progress = document.querySelector("#replayProgress");
const shareButton = document.querySelector("#shareReplay");

let replay = null;
let currentIndex = 0;
let playing = false;
let runToken = 0;
let currentAudio = null;

function setArt(file) {
  const url = file.includes("/") ? `/${file}` : `/assets/${file}`;
  page.style.setProperty("--replay-art", `url("${url}")`);
}

function renderTimeline() {
  timelineElement.replaceChildren();
  replay.timeline.forEach((message, index) => {
    const item = document.createElement("article");
    item.className = `replay-line ${message.role === "user" ? "replay-self" : "replay-opponent"}`;
    item.dataset.index = index;
    const label = document.createElement("span");
    label.textContent = message.role === "user" ? "你" : "争吵方";
    const text = document.createElement("p");
    text.textContent = message.text;
    item.append(label, text);
    timelineElement.append(item);
  });
  updateTimeline();
}

function updateTimeline(activeIndex = -1) {
  const lines = [...timelineElement.children];
  lines.forEach((line, index) => {
    line.classList.toggle("visible", index < currentIndex || index === activeIndex);
    line.classList.toggle("speaking", index === activeIndex);
  });
  const visible = Math.min(currentIndex, replay?.timeline.length || 0);
  progress.textContent = `${visible} / ${replay?.timeline.length || 0}`;
  lines[Math.max(0, activeIndex)]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function wait(ms, token) {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (token !== runToken || !playing || performance.now() - started >= ms) return resolve();
      setTimeout(check, 80);
    };
    check();
  });
}

async function playMessage(message, token) {
  currentAudio = new Audio(message.audioUrl);
  currentAudio.playbackRate = Number(speedSelect.value);
  await new Promise((resolve) => {
    currentAudio.onended = resolve;
    currentAudio.onpause = resolve;
    currentAudio.onerror = resolve;
    currentAudio.play().catch(resolve);
  });
  currentAudio = null;
  if (token === runToken && playing) await wait(Number(message.pauseAfterMs || 0) / Number(speedSelect.value), token);
}

async function runReplay() {
  const token = ++runToken;
  playing = true;
  playButton.textContent = "暂停";
  if (currentIndex >= replay.timeline.length) currentIndex = 0;
  while (playing && token === runToken && currentIndex < replay.timeline.length) {
    updateTimeline(currentIndex);
    await playMessage(replay.timeline[currentIndex], token);
    if (!playing || token !== runToken) return;
    currentIndex += 1;
    updateTimeline();
  }
  if (token === runToken) {
    playing = false;
    playButton.textContent = "重新回放";
  }
}

playButton.addEventListener("click", () => {
  if (!replay) return;
  if (playing) {
    playing = false;
    runToken += 1;
    currentAudio?.pause();
    currentAudio = null;
    playButton.textContent = "继续回放";
    updateTimeline();
    return;
  }
  runReplay();
});

speedSelect.addEventListener("change", () => {
  if (currentAudio) currentAudio.playbackRate = Number(speedSelect.value);
});

shareButton.addEventListener("click", async () => {
  const data = { title: `吵架练习室 · ${replay?.scene?.title || "对话回放"}`, text: "一次被保存的对话回放。", url: location.href };
  if (navigator.share) return navigator.share(data).catch(() => {});
  await navigator.clipboard?.writeText(location.href).catch(() => {});
  shareButton.textContent = "链接已复制";
  setTimeout(() => { shareButton.textContent = "分享"; }, 1800);
});

async function loadReplay() {
  const response = await fetch(`/api/replays/${replayId}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "回放无法打开");
  replay = data;
  setArt(replay.scene.art);
  document.title = `${replay.scene.title} · 对话回放`;
  document.querySelector("#replayKicker").textContent = `${replay.scene.kicker || "对话回放"} · ${new Date(replay.createdAt).toLocaleDateString("zh-CN")}`;
  document.querySelector("#replayTitle").textContent = replay.scene.title;
  document.querySelector("#replayOutcome").textContent = replay.outcome.achievement;
  renderTimeline();
  playButton.disabled = false;
}

loadReplay().catch((error) => {
  document.querySelector("#replayTitle").textContent = error.message;
  document.querySelector("#replayOutcome").textContent = "这个链接可能已经失效。";
});
