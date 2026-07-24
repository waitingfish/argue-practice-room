function createReviewService({ sessions, judgeConversation, analyzeConversation, localJudge, localAnalyze }) {
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
    if (cached) return { ...cached, cached: true };
    return withLock(sessionId, 60000, async () => {
      const verdict = config.apiKey
        ? await judgeConversation(config, scene, messages)
        : localJudge(messages);
      const saved = sessions.saveVerdict(sessionId, version, verdict, config.apiKey ? config.model : "本地裁判");
      return { ...saved, cached: false };
    });
  }

  async function analyze({ config, scene, sessionId, messages, coachHistory }) {
    const version = sessions.messageVersion(sessionId);
    const cached = sessions.getReport(sessionId, version);
    if (cached) return { ...cached, cached: true };
    return withLock(sessionId, 150000, async () => {
      const report = config.apiKey
        ? await analyzeConversation(config, scene, messages, coachHistory)
        : localAnalyze(messages);
      const saved = sessions.saveReport(sessionId, version, report, config.apiKey ? config.model : "本地分析");
      return { ...saved, cached: false };
    });
  }

  return Object.freeze({ judge, analyze });
}

module.exports = { createReviewService };
