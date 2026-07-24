const crypto = require("node:crypto");

function createSceneGenerationService({ scenes, enqueue, validateImageConfig }) {
  function submit({ prompt, idempotencyKey, opponentGender, config }) {
    const description = String(prompt || "").trim();
    const key = String(idempotencyKey || "").trim();
    if (description.length < 8) {
      const error = new Error("请多说一点你想吵的那件事。");
      error.statusCode = 400;
      throw error;
    }
    if (!config.apiKey) {
      const error = new Error("请先在后台配置文案模型 API Key。");
      error.statusCode = 503;
      throw error;
    }
    const imageError = validateImageConfig(config);
    if (imageError) {
      const error = new Error(imageError);
      error.statusCode = 503;
      throw error;
    }
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) {
      const error = new Error("请求缺少有效的 Idempotency-Key");
      error.statusCode = 400;
      throw error;
    }

    const existing = scenes.findJobByIdempotencyKey(key);
    if (existing) return { job: existing, created: false };

    const now = new Date().toISOString();
    const job = scenes.saveJob({
      id: `job-${crypto.randomUUID()}`,
      idempotencyKey: key,
      status: "queued",
      progress: 5,
      message: "任务已创建，等待生成",
      prompt: description.slice(0, 3000),
      opponentGender: ["male", "female"].includes(opponentGender) ? opponentGender : "unspecified",
      sceneId: `scene-${crypto.randomUUID()}`,
      sceneUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now
    });
    enqueue(job.id);
    return { job, created: true };
  }

  return Object.freeze({ submit });
}

module.exports = { createSceneGenerationService };
