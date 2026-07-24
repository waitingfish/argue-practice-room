function createSessionService({ sessions, cleanupFiles = () => {} }) {
  function create(scene, mode) {
    const normalizedMode = mode === "immersive" ? "immersive" : "training";
    return sessions.createSession(scene.id, scene.opponent, normalizedMode);
  }

  function authenticate(id, token) {
    return sessions.authenticateSession(id, String(token || ""));
  }

  function state(session) {
    return {
      ...session,
      messages: sessions.listMessages(session.id),
      latestVerdict: sessions.getLatestVerdict(session.id)
    };
  }

  function setCoachEnabled(session, enabled) {
    if (typeof enabled !== "boolean") {
      const error = new Error("coachEnabled 必须是布尔值");
      error.statusCode = 400;
      throw error;
    }
    if (session.mode === "immersive" && enabled) {
      const error = new Error("沉浸模式不启用帮忙专家");
      error.statusCode = 409;
      throw error;
    }
    return state(sessions.setCoachEnabled(session.id, enabled));
  }

  function remove(session) {
    if (session.mode !== "immersive") {
      const error = new Error("只有沉浸模式会话会在离开时直接清除");
      error.statusCode = 409;
      throw error;
    }
    cleanupFiles(session.id);
    sessions.deleteSession(session.id);
    return { deleted: true };
  }

  return Object.freeze({ create, authenticate, state, setCoachEnabled, remove });
}

module.exports = { createSessionService };
