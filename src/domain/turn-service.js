function createTurnService({ sessions, generateReply }) {
  async function complete({ config, scene, sessionId, requestId, content }) {
    const existingTurn = sessions.getTurn(sessionId, requestId);
    if (existingTurn?.status === "completed" && existingTurn.userContent !== content) {
      const error = new Error("同一个 requestId 已经完成，不能改用另一条消息重试");
      error.statusCode = 409;
      throw error;
    }
    const existing = sessions.getMessage(sessionId, requestId, "opponent");
    if (existing) return existing.content;

    const lockToken = sessions.claimSession(sessionId);
    if (!lockToken) {
      const error = new Error("这个会话正在处理上一条消息，请稍后重试");
      error.statusCode = 409;
      throw error;
    }

    let turnBegan = false;
    try {
      sessions.beginTurn(sessionId, requestId, content);
      turnBegan = true;
      const reply = await generateReply(config, scene, sessionId, content);
      sessions.completeTurn(sessionId, requestId, content, reply);
      return reply;
    } catch (error) {
      if (turnBegan) sessions.failTurn(sessionId, requestId, error.message);
      throw error;
    } finally {
      sessions.releaseSession(sessionId, lockToken);
    }
  }

  return Object.freeze({ complete });
}

module.exports = { createTurnService };
