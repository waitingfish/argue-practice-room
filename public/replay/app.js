const replayId = location.pathname.split("/").filter(Boolean).at(-1);
const page = document.querySelector("#replayPage");
const intro = document.querySelector("#replayIntro");
const enterButton = document.querySelector("#replayEnter");
const shareButton = document.querySelector("#shareReplay");
const currentLine = document.querySelector("#replayCurrent");
const speaker = document.querySelector("#replaySpeaker");
const text = document.querySelector("#replayText");
const endedDialog = document.querySelector("#replayEndedDialog");
const startArgueButton = document.querySelector("#startArgue");
const replayAgainButton = document.querySelector("#replayAgain");

let replay = null;
let currentIndex = 0;
let playing = false;
let runToken = 0;
let currentAudio = null;
let typingFrame = 0;
let waitResolver = null;
let messageResolver = null;
let skipSerial = 0;

function setArt(file) {
  const url = file.includes("/") ? `/${file}` : `/assets/${file}`;
  page.style.setProperty("--replay-art", `url("${url}")`);
}

function setMessage(message, index) {
  if (!message) {
    currentLine.className = "replay-current";
    speaker.textContent = "";
    text.textContent = "";
    return;
  }
  currentLine.className = `replay-current ${message.role === "user" ? "replay-self" : "replay-opponent"} replay-appear`;
  speaker.textContent = message.role === "user" ? "你" : "对方";
  text.textContent = "";
  window.setTimeout(() => currentLine.classList.remove("replay-appear"), 420);
}

function setTypedText(message, ratio = 1) {
  const fullText = message?.text || "";
  const chars = Array.from(fullText);
  const visibleCount = Math.min(chars.length, Math.max(0, Math.ceil(chars.length * ratio)));
  text.textContent = chars.slice(0, visibleCount).join("");
}

function stopTyping() {
  if (typingFrame) cancelAnimationFrame(typingFrame);
  typingFrame = 0;
}

function startTyping(message, audio, token) {
  stopTyping();
  setTypedText(message, 0);

  const tick = () => {
    if (token !== runToken || !playing || audio !== currentAudio) {
      typingFrame = 0;
      return;
    }

    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const ratio = duration ? audio.currentTime / duration : 0;
    setTypedText(message, ratio);

    if (!audio.ended) {
      typingFrame = requestAnimationFrame(tick);
      return;
    }

    setTypedText(message, 1);
    typingFrame = 0;
  };

  typingFrame = requestAnimationFrame(tick);
}

function wait(ms, token) {
  return new Promise((resolve) => {
    waitResolver = resolve;
    const startedAt = performance.now();
    const tick = () => {
      if (token !== runToken || !playing || performance.now() - startedAt >= ms) {
        if (waitResolver === resolve) waitResolver = null;
        return resolve();
      }
      window.setTimeout(tick, 80);
    };
    tick();
  });
}

async function playMessage(message, token) {
  const skipMarker = skipSerial;
  currentAudio = new Audio(message.audioUrl);
  startTyping(message, currentAudio, token);
  await new Promise((resolve, reject) => {
    messageResolver = resolve;
    currentAudio.onended = () => {
      setTypedText(message, 1);
      if (messageResolver === resolve) messageResolver = null;
      resolve();
    };
    currentAudio.onpause = () => {
      if (messageResolver === resolve) messageResolver = null;
      resolve();
    };
    currentAudio.onerror = () => {
      setTypedText(message, 1);
      if (messageResolver === resolve) messageResolver = null;
      resolve();
    };
    currentAudio.play().catch((error) => {
      if (error?.name === "NotAllowedError") {
        if (messageResolver === resolve) messageResolver = null;
        reject(error);
        return;
      }
      setTypedText(message, 1);
      if (messageResolver === resolve) messageResolver = null;
      resolve();
    });
  });
  stopTyping();
  currentAudio = null;
  if (skipMarker !== skipSerial) return;
  if (token === runToken && playing) await wait(Number(message.pauseAfterMs || 700), token);
}

function skipCurrentMessage() {
  if (!playing) return;
  skipSerial += 1;
  stopTyping();
  if (currentAudio) {
    currentAudio.pause();
  }
  currentAudio = null;
  const message = replay?.timeline?.[currentIndex];
  if (message) setTypedText(message, 1);
  messageResolver?.();
  messageResolver = null;
  waitResolver?.();
  waitResolver = null;
}

async function runReplay() {
  if (!replay || playing) return;
  const token = ++runToken;
  playing = true;
  page.dataset.state = "playing";
  intro.hidden = true;
  if (endedDialog.open) endedDialog.close();
  if (currentIndex >= replay.timeline.length) currentIndex = 0;

  try {
    while (playing && token === runToken && currentIndex < replay.timeline.length) {
      const message = replay.timeline[currentIndex];
      setMessage(message, currentIndex);
      await playMessage(message, token);
      if (!playing || token !== runToken) return;
      currentIndex += 1;
    }

    if (token === runToken) {
      playing = false;
      page.dataset.state = "ended";
      endedDialog.showModal();
    }
  } catch (error) {
    stopTyping();
    currentAudio?.pause();
    currentAudio = null;
    messageResolver = null;
    waitResolver = null;
    playing = false;
    page.dataset.state = "ready";
    currentIndex = 0;
    if (replay.timeline[0]) setMessage(replay.timeline[0], 0);
    intro.hidden = false;
  }
}

function startReplay() {
  if (!replay) return;
  runReplay();
}

enterButton.addEventListener("click", startReplay);
page.addEventListener("click", (event) => {
  if (intro.contains(event.target) || event.target.closest(".replay-header") || event.target.closest("dialog")) return;
  skipCurrentMessage();
});
startArgueButton.addEventListener("click", () => { location.href = "/"; });
replayAgainButton.addEventListener("click", () => {
  currentIndex = 0;
  runReplay();
});

shareButton.addEventListener("click", async () => {
  const data = { title: `吵架练习室 · ${replay?.scene?.title || "对话回放"}`, text: "一次被保存的对话回放。", url: location.href };
  if (navigator.share) return navigator.share(data).catch(() => {});
  await navigator.clipboard?.writeText(location.href).catch(() => {});
  shareButton.textContent = "链接已复制";
  window.setTimeout(() => { shareButton.textContent = "分享"; }, 1800);
});

async function loadReplay() {
  const response = await fetch(`/api/replays/${replayId}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "回放无法打开");
  replay = data;
  setArt(replay.scene.art);
  document.title = `${replay.scene.title} · 对话回放`;
  document.querySelector("#replayKicker").textContent = replay.scene.kicker || "对话回放";
  document.querySelector("#replayTitle").textContent = replay.scene.title;
  document.querySelector("#replayOutcome").textContent = replay.outcome.resultCopy || replay.outcome.achievement || "";
  enterButton.disabled = false;
  if (replay.timeline[0]) setMessage(replay.timeline[0], 0);
  currentLine.classList.remove("replay-appear");
  runReplay();
}

loadReplay().catch((error) => {
  intro.hidden = true;
  document.querySelector("#replayTitle").textContent = error.message;
  document.querySelector("#replayOutcome").textContent = "这个链接可能已经失效。";
  page.dataset.state = "error";
});
