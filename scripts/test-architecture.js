const { pageEntry, publicAsset, safeFile } = require("../src/http/router");
const { createSessionService } = require("../src/domain/session-service");
const referee = require("../src/agents/referee");
const path = require("node:path");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(pageEntry("/") === "lobby/index.html", "首页必须映射到 lobby 入口");
assert(pageEntry("/scene/phone-night") === "scene/index.html", "场景动态 URL 必须映射到 scene 入口");
assert(pageEntry("/scene/app.js") === "", "静态脚本不能误判为场景动态页");
assert(publicAsset("/scene/app.js") === "scene/app.js", "scene 脚本必须走静态资源分支");
assert(publicAsset("/shared/styles.css") === "shared/styles.css", "共享样式必须可解析");
assert(
  safeFile(path.join(__dirname, "..", "public"), "../package.json") === null,
  "静态文件解析必须拒绝目录穿越"
);

const storedSession = { id: "session-test", mode: "training", coachEnabled: false };
const fakeRepository = {
  createSession: (sceneId, opponent, mode) => ({ session: { ...storedSession, sceneId, mode }, opponent }),
  authenticateSession: () => storedSession,
  listMessages: () => [{ role: "opponent", content: "开场" }],
  getLatestVerdict: () => null,
  setCoachEnabled: (id, enabled) => ({ ...storedSession, id, coachEnabled: enabled }),
  deleteSession: () => 1
};
const sessions = createSessionService({ sessions: fakeRepository });
assert(sessions.create({ id: "scene-a", opponent: "开场" }, "other").session.mode === "training", "未知模式必须降级为训练模式");
assert(sessions.setCoachEnabled(storedSession, true).coachEnabled === true, "训练模式应允许开启教练");

const verdict = referee.parse(JSON.stringify({
  status: "won",
  confidence: 80,
  reason: "对方已承诺停止",
  mood: { label: "松了一口气", valence: 30, arousal: 40, confidence: 60 },
  resultCopy: "你把边界说清楚了，对方也给出了具体回应。"
}), (value) => value);
assert(verdict.status === "won" && verdict.confidence === 80, "裁判输出必须规范化");

console.log("architecture contracts ok");
