const { serializeError } = require("../logger");

function createReviewService({ sessions, judgeConversation, analyzeConversation, localJudge, localAnalyze, logger = console }) {
  async function withLock(sessionId, ttlMs, work) {
    const lockToken = sessions.claimSession(sessionId, ttlMs);
    if (!lockToken) {
      const error = new Error("这个会话正在处理其他请求，请稍后重试");
      error.statusCode = 409;
      throw error;
    }
    try {
      return await work();
    } finally {
      sessions.releaseSession(sessionId, lockToken);
    }
  }

  async function judge({ config, scene, sessionId, messages }) {
    const version = sessions.messageVersion(sessionId);
    const cached = sessions.getVerdict(sessionId, version);
    if (cached) {
      logger.info?.("裁判判定命中缓存", { sessionId, sceneId: scene?.id, version });
      return { ...cached, cached: true };
    }
    const startedAt = Date.now();
    return withLock(sessionId, 60000, async () => {
      try {
        logger.info?.("裁判判定开始", { sessionId, sceneId: scene?.id, version, model: config.apiKey ? config.model : "本地裁判" });
        const verdict = config.apiKey
          ? await judgeConversation(config, scene, messages)
          : localJudge(messages);
        const saved = sessions.saveVerdict(sessionId, version, verdict, config.apiKey ? config.model : "本地裁判");
        logger.info?.("裁判判定完成", { sessionId, sceneId: scene?.id, version, status: verdict?.status, durationMs: Date.now() - startedAt });
        return { ...saved, cached: false };
      } catch (error) {
        logger.error?.("裁判判定失败", { sessionId, sceneId: scene?.id, version, durationMs: Date.now() - startedAt, error: serializeError(error) });
        throw error;
      }
    });
  }

  async function analyze({ config, scene, sessionId, messages, coachHistory }) {
    const version = sessions.messageVersion(sessionId);
    const cached = sessions.getReport(sessionId, version);
    if (cached) {
      logger.info?.("复盘分析命中缓存", { sessionId, sceneId: scene?.id, version });
      return { ...cached, cached: true };
    }
    const startedAt = Date.now();
    return withLock(sessionId, 150000, async () => {
      try {
        logger.info?.("复盘分析开始", { sessionId, sceneId: scene?.id, version, model: config.apiKey ? config.model : "本地分析" });
        const report = config.apiKey
          ? await analyzeConversation(config, scene, messages, coachHistory)
          : localAnalyze(messages);
        const saved = sessions.saveReport(sessionId, version, report, config.apiKey ? config.model : "本地分析");
        logger.info?.("复盘分析完成", { sessionId, sceneId: scene?.id, version, durationMs: Date.now() - startedAt });
        return { ...saved, cached: false };
      } catch (error) {
        logger.error?.("复盘分析失败", { sessionId, sceneId: scene?.id, version, durationMs: Date.now() - startedAt, error: serializeError(error) });
        throw error;
      }
    });
  }

  return Object.freeze({ judge, analyze });
}

module.exports = { createReviewService };
