const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDatabase } = require("../database");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argue-turns-test-"));
const database = createDatabase(path.join(dir, "test.sqlite"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const created = database.createSession("scene-a", "开场");
  const sessionId = created.session.id;

  database.appendMessage(sessionId, "old-half", "user", "旧半轮");
  assert(
    !database.listMessages(sessionId).some((message) => message.requestId === "old-half"),
    "历史孤立 user 消息不应出现在会话消息里"
  );

  database.beginTurn(sessionId, "message-test-1", "我的边界");
  database.failTurn(sessionId, "message-test-1", "timeout");
  assert(
    !database.listArgumentMessages(sessionId).some((message) => message.requestId === "message-test-1"),
    "失败轮次不应进入争吵上下文"
  );

  database.beginTurn(sessionId, "message-test-1", "我的边界");
  database.completeTurn(sessionId, "message-test-1", "我的边界", "我知道了");

  const messages = database.listArgumentMessages(sessionId);
  assert(messages.length === 3, `应包含开场和一组完整问答，实际为 ${messages.length} 条`);
  assert(messages.at(-2).role === "user" && messages.at(-1).role === "opponent", "完整轮次应按 user/opponent 成对落库");

  const completed = database.beginTurn(sessionId, "message-test-1", "我的边界");
  assert(completed.opponentContent === "我知道了", "完成轮次重试应返回已保存的对方回复");

  console.log("turn lifecycle ok");
} finally {
  database.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
