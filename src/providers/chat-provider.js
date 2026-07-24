function createChatProvider({
  endpointFor,
  systemPromptFor,
  temperatureFor,
  requestBody,
  readContent,
  readDelta,
  createVisibleChunkFilter,
  logger = console
}) {
  async function complete(config, scene, messages, role = "opponent") {
    const endpoint = endpointFor(config);
    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(requestBody(config, {
        model: config.model,
        temperature: temperatureFor(config, role),
        messages: [{ role: "system", content: systemPromptFor(config, scene, role) }, ...messages]
      }, role)),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      logger.warn?.("聊天模型调用失败", { endpoint, model: config.model, role, statusCode: response.status, durationMs: Date.now() - startedAt });
      throw new Error(data.error?.message || `模型接口返回 ${response.status}`);
    }
    const content = readContent(data);
    if (!content) throw new Error("模型没有返回有效内容");
    logger.info?.("聊天模型调用完成", { endpoint, model: config.model, role, durationMs: Date.now() - startedAt });
    return content;
  }

  async function stream(config, scene, messages, onChunk, signal, role = "opponent") {
    const endpoint = endpointFor(config);
    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(requestBody(config, {
        model: config.model,
        temperature: temperatureFor(config, role),
        stream: true,
        messages: [{ role: "system", content: systemPromptFor(config, scene, role) }, ...messages]
      }, role)),
      signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      logger.warn?.("流式聊天模型调用失败", { endpoint, model: config.model, role, statusCode: response.status, durationMs: Date.now() - startedAt });
      throw new Error(data.error?.message || `模型接口返回 ${response.status}`);
    }
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      const content = readContent(await response.json());
      if (content) onChunk(content);
      logger.info?.("流式聊天模型以 JSON 完成", { endpoint, model: config.model, role, durationMs: Date.now() - startedAt });
      return content;
    }

    const emitVisibleChunk = createVisibleChunkFilter(onChunk);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          emitVisibleChunk("", true);
          logger.info?.("流式聊天模型调用完成", { endpoint, model: config.model, role, durationMs: Date.now() - startedAt });
          return "";
        }
        try {
          const text = readDelta(JSON.parse(payload));
          if (text) emitVisibleChunk(text);
        } catch {
          // 某个畸形 SSE 片段不应终止完整流。
        }
      }
    }
    emitVisibleChunk("", true);
    logger.info?.("流式聊天模型连接结束", { endpoint, model: config.model, role, durationMs: Date.now() - startedAt });
    return "";
  }

  return Object.freeze({ complete, stream });
}

module.exports = { createChatProvider };
