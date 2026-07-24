const { serializeError } = require("../logger");

function createTurnService({ sessions, generateReply, logger = console }) {
  async function complete({ config, scene, sessionId, requestId, content }) {
    const existingTurn = sessions.getTurn(sessionId, requestId);
    if (existingTurn?.status === "completed" && existingTurn.userContent !== content) {
      logger.warn?.("回合幂等冲突", { sessionId, requestId, sceneId: scene?.id });
      const error = new Error("同一个 requestId 已经完成，不能改用另一条消息重试");
      error.statusCode = 409;
      throw error;
    }
    const existing = sessions.getMessage(sessionId, requestId, "opponent");
    if (existing) {
      logger.info?.("回合命中已保存回复", { sessionId, requestId, sceneId: scene?.id });
      return existing.content;
    }

    const lockToken = sessions.claimSession(sessionId);
    if (!lockToken) {
      logger.warn?.("回合处理锁冲突", { sessionId, requestId, sceneId: scene?.id });
      const error = new Error("这个会话正在处理上一条消息，请稍后重试");
      error.statusCode = 409;
      throw error;
    }

    let turnBegan = false;
    const startedAt = Date.now();
    try {
      logger.info?.("回合开始", { sessionId, requestId, sceneId: scene?.id, model: config?.model });
      sessions.beginTurn(sessionId, requestId, content);
      turnBegan = true;
      const reply = await generateReply(config, scene, sessionId, content);
      sessions.completeTurn(sessionId, requestId, content, reply);
      logger.info?.("回合完成", { sessionId, requestId, sceneId: scene?.id, durationMs: Date.now() - startedAt });
      return reply;
    } catch (error) {
      if (turnBegan) sessions.failTurn(sessionId, requestId, error.message);
      logger.error?.("回合失败", { sessionId, requestId, sceneId: scene?.id, durationMs: Date.now() - startedAt, error: serializeError(error) });
      throw error;
    } finally {
      sessions.releaseSession(sessionId, lockToken);
    }
  }

  return Object.freeze({ complete });
}

module.exports = { createTurnService };
